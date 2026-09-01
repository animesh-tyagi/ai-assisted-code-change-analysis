package com.impact.parser.extract;

import com.github.javaparser.JavaParser;
import com.github.javaparser.ParserConfiguration;
import com.github.javaparser.ast.CompilationUnit;
import com.github.javaparser.ast.Node;
import com.github.javaparser.ast.body.CallableDeclaration;
import com.github.javaparser.ast.body.ClassOrInterfaceDeclaration;
import com.github.javaparser.ast.body.ConstructorDeclaration;
import com.github.javaparser.ast.body.MethodDeclaration;
import com.github.javaparser.ast.body.Parameter;
import com.github.javaparser.ast.body.TypeDeclaration;
import com.github.javaparser.ast.expr.AnnotationExpr;
import com.github.javaparser.ast.expr.MemberValuePair;
import com.github.javaparser.ast.expr.ObjectCreationExpr;
import com.github.javaparser.ast.expr.StringLiteralExpr;
import com.github.javaparser.resolution.TypeSolver;
import com.github.javaparser.symbolsolver.JavaSymbolSolver;
import com.impact.parser.graph.AnnotationRef;
import com.impact.parser.graph.NodeKeys;
import com.impact.parser.graph.ParsedFunction;
import com.impact.parser.resolve.TypeNames;
import com.impact.parser.workspace.WorkspaceLayout;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.HexFormat;
import java.util.IdentityHashMap;
import java.util.List;
import java.util.Map;
import java.util.TreeMap;

/**
 * Turns Java source into {@code functions[]} entries (ARCHITECTURE.md section 8).
 *
 * <p>Two properties this class has to hold:
 *
 * <ol>
 *   <li><strong>Determinism.</strong> The parse response is a pure function of
 *       (workspace, mode, files, options). Files arrive sorted, functions leave
 *       sorted by key, and annotation members are stored in a sorted map — so the
 *       same commit always serialises to the same bytes.
 *   <li><strong>Never lose a node.</strong> A file that fails to parse becomes a
 *       {@link ParseError}, and a parameter whose type will not resolve falls back
 *       to import-based naming. Both are counted. A missing node is invisible
 *       damage: its method would appear to have no callers.
 * </ol>
 */
public final class FunctionExtractor {

    private final TypeSolver typeSolver;

    public FunctionExtractor(TypeSolver typeSolver) {
        this.typeSolver = typeSolver;
    }

    /**
     * Extracts function nodes from the given files.
     *
     * <p>{@code files} narrows extraction only. The solver still spans the whole
     * workspace, so subset mode (D4) resolves calls from a touched file into
     * untouched ones exactly as full mode would.
     */
    public ExtractionResult extract(WorkspaceLayout layout, List<Path> files) {
        JavaParser parser = configuredParser();
        List<ParsedFunction> functions = new ArrayList<>();
        List<ParseError> errors = new ArrayList<>();
        int filesParsed = 0;
        int unresolvedParams = 0;

        for (Path file : files) {
            String relativePath = layout.relativize(file);
            CompilationUnit cu;
            try {
                var result = parser.parse(file);
                if (!result.isSuccessful() || result.getResult().isEmpty()) {
                    errors.add(new ParseError(relativePath, firstProblem(result.getProblems())));
                    continue;
                }
                cu = result.getResult().get();
            } catch (IOException e) {
                errors.add(new ParseError(relativePath, "could not read file: " + e.getMessage()));
                continue;
            }
            filesParsed++;

            Map<ObjectCreationExpr, String> anonymousNames = anonymousClassNames(cu);
            for (CallableDeclaration<?> callable : cu.findAll(CallableDeclaration.class)) {
                try {
                    ParsedFunction fn = toFunction(callable, relativePath, anonymousNames);
                    functions.add(fn);
                    unresolvedParams += fn.unresolvedParamTypes();
                } catch (RuntimeException e) {
                    // One malformed declaration must not cost us the whole file.
                    errors.add(
                            new ParseError(
                                    relativePath,
                                    "could not extract "
                                            + callable.getNameAsString()
                                            + ": "
                                            + e.getClass().getSimpleName()
                                            + ": "
                                            + e.getMessage()));
                }
            }
        }

        functions.sort(Comparator.comparing(ParsedFunction::key));
        errors.sort(Comparator.comparing(ParseError::filePath).thenComparing(ParseError::message));
        return new ExtractionResult(List.copyOf(functions), List.copyOf(errors), filesParsed, unresolvedParams);
    }

    /**
     * Language level used for every parse.
     *
     * <p>Not optional, and not cosmetic. JavaParser's default level predates Java
     * 12, so a single switch expression makes a whole file unparseable — every
     * function in it disappears, and every method it declares then looks like it
     * has no callers. That was measured, not theorised: it silently cost one file
     * in observability-final until this was set.
     *
     * <p>A newer level parses older sources fine, so this is set high rather than
     * per-repository. It is fixed rather than a request option so that output
     * stays a pure function of (workspace, mode, files, options) — a per-run
     * language level would make graph versions irreproducible.
     */
    private static final ParserConfiguration.LanguageLevel LANGUAGE_LEVEL =
            ParserConfiguration.LanguageLevel.JAVA_21;

    private JavaParser configuredParser() {
        ParserConfiguration config =
                new ParserConfiguration()
                        .setLanguageLevel(LANGUAGE_LEVEL)
                        .setSymbolResolver(new JavaSymbolSolver(typeSolver));
        return new JavaParser(config);
    }

    // -----------------------------------------------------------------------
    // One declaration
    // -----------------------------------------------------------------------

    private ParsedFunction toFunction(
            CallableDeclaration<?> callable,
            String relativePath,
            Map<ObjectCreationExpr, String> anonymousNames) {
        boolean isConstructor = callable instanceof ConstructorDeclaration;

        List<String> paramTypes = new ArrayList<>();
        List<String> paramNames = new ArrayList<>();
        int unresolved = 0;
        for (Parameter parameter : callable.getParameters()) {
            TypeNames.Named named = TypeNames.of(parameter.getType());
            String typeName = named.name();
            // A variadic parameter is an array at the JVM level; normalising here
            // keeps the key identical if the declaration is later rewritten as an
            // explicit array.
            if (parameter.isVarArgs() && !typeName.endsWith("[]")) {
                typeName = typeName + "[]";
            }
            paramTypes.add(typeName);
            paramNames.add(parameter.getNameAsString());
            if (!named.resolved()) {
                unresolved++;
            }
        }

        DeclaringType owner = declaringTypeOf(callable, anonymousNames);
        String methodName = isConstructor ? NodeKeys.CONSTRUCTOR_NAME : callable.getNameAsString();

        String returnType =
                isConstructor
                        ? "void"
                        : TypeNames.of(((MethodDeclaration) callable).getType()).name();

        boolean interfaceMethod = owner.isInterface();

        return new ParsedFunction(
                NodeKeys.format(owner.fqcn(), methodName, paramTypes),
                owner.fqcn(),
                owner.simpleName(),
                methodName,
                List.copyOf(paramTypes),
                List.copyOf(paramNames),
                returnType,
                relativePath,
                callable.getBegin().map(p -> p.line).orElse(0),
                callable.getEnd().map(p -> p.line).orElse(0),
                bodyHash(callable),
                modifiersOf(callable),
                annotationsOf(callable),
                isAbstract(callable, interfaceMethod),
                interfaceMethod,
                unresolved);
    }

    /** The type a callable belongs to, named well enough to key it uniquely. */
    private record DeclaringType(String fqcn, String simpleName, boolean isInterface) {}

    /**
     * Assigns JVM-style names to anonymous classes: {@code Outer$1}, {@code Outer$2}.
     *
     * <p>Anonymous class bodies are not {@code TypeDeclaration}s, so walking up to
     * the nearest declared type attributes their methods to the <em>enclosing</em>
     * class. In real code that collides: {@code JdbcVetRepositoryImpl} declares two
     * anonymous {@code BeanPropertyRowMapper}s, each with {@code mapRow(ResultSet,int)},
     * which produced two nodes sharing one key. Duplicate keys violate the unique
     * indexes in section 7 and would merge two unrelated methods into one node.
     *
     * <p>Numbering follows source order within the outermost type, which is what
     * the JVM does. Known limitation, inherited from the JVM's own scheme: adding
     * an anonymous class earlier in a file renumbers the ones after it, so their
     * keys shift. Anonymous classes have no stabler name available.
     */
    private static Map<ObjectCreationExpr, String> anonymousClassNames(CompilationUnit cu) {
        Map<ObjectCreationExpr, String> names = new IdentityHashMap<>();
        for (TypeDeclaration<?> topLevel : cu.getTypes()) {
            String base = topLevel.getFullyQualifiedName().orElseGet(topLevel::getNameAsString);
            int index = 1;
            // findAll walks in source order, so numbering is deterministic.
            for (ObjectCreationExpr creation : topLevel.findAll(ObjectCreationExpr.class)) {
                if (creation.getAnonymousClassBody().isPresent()) {
                    names.put(creation, base + "$" + index++);
                }
            }
        }
        return names;
    }

    /**
     * Walks out to the declaring type.
     *
     * <p>Uses the nearest enclosing type rather than the file's primary type, so a
     * method on a nested class is attributed to {@code Outer.Inner} — which is what
     * makes its key distinct from a same-named method on the outer class. Anonymous
     * and local classes, which have no qualified name of their own, get a synthetic
     * {@code $}-suffixed one rather than being folded into their parent.
     */
    private static DeclaringType declaringTypeOf(Node node, Map<ObjectCreationExpr, String> anonymousNames) {
        Node current = node;
        while (current.getParentNode().isPresent()) {
            Node parent = current.getParentNode().get();

            // A callable whose parent is an ObjectCreationExpr sits in its
            // anonymous class body.
            if (parent instanceof ObjectCreationExpr creation
                    && creation.getAnonymousClassBody().isPresent()) {
                String fqcn =
                        anonymousNames.getOrDefault(
                                creation, creation.getType().getNameAsString() + "$anonymous");
                return new DeclaringType(fqcn, simpleNameOf(fqcn), false);
            }

            if (parent instanceof TypeDeclaration<?> type) {
                String fqcn =
                        type.getFullyQualifiedName()
                                .orElseGet(
                                        () ->
                                                // A local class (declared inside a method) has no
                                                // qualified name; qualify it through its enclosing
                                                // type so it cannot collide with a same-named
                                                // local class elsewhere.
                                                declaringTypeOf(type, anonymousNames).fqcn()
                                                        + "$"
                                                        + type.getNameAsString());
                boolean isInterface =
                        type instanceof ClassOrInterfaceDeclaration decl && decl.isInterface();
                return new DeclaringType(fqcn, type.getNameAsString(), isInterface);
            }

            current = parent;
        }
        throw new IllegalStateException("declaration has no enclosing type");
    }

    private static String simpleNameOf(String fqcn) {
        int lastDot = fqcn.lastIndexOf('.');
        return lastDot == -1 ? fqcn : fqcn.substring(lastDot + 1);
    }

    private static boolean isAbstract(CallableDeclaration<?> callable, boolean interfaceMethod) {
        if (callable instanceof MethodDeclaration method) {
            // An interface method without a body is abstract even though it carries
            // no `abstract` keyword.
            return method.isAbstract() || (interfaceMethod && method.getBody().isEmpty());
        }
        return false;
    }

    /** Modifiers in source order — already deterministic for a given source text. */
    private static List<String> modifiersOf(CallableDeclaration<?> callable) {
        return callable.getModifiers().stream().map(m -> m.getKeyword().asString()).toList();
    }

    private static List<AnnotationRef> annotationsOf(CallableDeclaration<?> callable) {
        return callable.getAnnotations().stream().map(FunctionExtractor::toAnnotationRef).toList();
    }

    private static AnnotationRef toAnnotationRef(AnnotationExpr annotation) {
        // TreeMap: member order in source is not meaningful, but output bytes must
        // be stable, so members are keyed and sorted.
        Map<String, String> values = new TreeMap<>();
        if (annotation.isSingleMemberAnnotationExpr()) {
            values.put("value", literalOf(annotation.asSingleMemberAnnotationExpr().getMemberValue()));
        } else if (annotation.isNormalAnnotationExpr()) {
            for (MemberValuePair pair : annotation.asNormalAnnotationExpr().getPairs()) {
                values.put(pair.getNameAsString(), literalOf(pair.getValue()));
            }
        }
        return new AnnotationRef(annotation.getName().getIdentifier(), Map.copyOf(values));
    }

    /**
     * String literals are stored unquoted so phase 5 can concatenate route paths
     * directly; every other expression keeps its source text.
     */
    private static String literalOf(com.github.javaparser.ast.expr.Expression expression) {
        if (expression instanceof StringLiteralExpr literal) {
            return literal.asString();
        }
        return expression.toString();
    }

    /**
     * {@code sha256:...} over the pretty-printed body.
     *
     * <p>Pretty-printing first means a pure reformat does not read as a change in
     * section 5.2's change detection. Comments are included: a changed comment is
     * a real change to the source, even if not a behavioural one. Abstract and
     * interface methods have no body and hash the empty string — they change
     * identity through their signature instead.
     */
    private static String bodyHash(CallableDeclaration<?> callable) {
        String body = "";
        if (callable instanceof MethodDeclaration method) {
            body = method.getBody().map(Node::toString).orElse("");
        } else if (callable instanceof ConstructorDeclaration constructor) {
            body = constructor.getBody().toString();
        }
        return "sha256:" + sha256Hex(body);
    }

    private static String sha256Hex(String value) {
        try {
            MessageDigest digest = MessageDigest.getInstance("SHA-256");
            return HexFormat.of().formatHex(digest.digest(value.getBytes(StandardCharsets.UTF_8)));
        } catch (NoSuchAlgorithmException e) {
            throw new IllegalStateException("SHA-256 unavailable", e);
        }
    }

    private static String firstProblem(List<com.github.javaparser.Problem> problems) {
        return problems.isEmpty() ? "unparseable" : problems.getFirst().getMessage();
    }

    /** Reads a file's text, used by callers that need the raw source. */
    public static String readSource(Path file) throws IOException {
        return Files.readString(file, StandardCharsets.UTF_8);
    }
}
