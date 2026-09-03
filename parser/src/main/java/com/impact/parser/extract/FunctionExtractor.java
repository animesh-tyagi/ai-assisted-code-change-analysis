package com.impact.parser.extract;

import com.github.javaparser.ast.CompilationUnit;
import com.github.javaparser.ast.Node;
import com.github.javaparser.ast.body.CallableDeclaration;
import com.github.javaparser.ast.body.ConstructorDeclaration;
import com.github.javaparser.ast.body.MethodDeclaration;
import com.github.javaparser.ast.body.Parameter;
import com.github.javaparser.ast.expr.AnnotationExpr;
import com.github.javaparser.ast.expr.Expression;
import com.github.javaparser.ast.expr.MemberValuePair;
import com.github.javaparser.ast.expr.ObjectCreationExpr;
import com.github.javaparser.ast.expr.StringLiteralExpr;
import com.impact.parser.graph.AnnotationRef;
import com.impact.parser.graph.NodeKeys;
import com.impact.parser.graph.ParsedFunction;
import com.impact.parser.resolve.TypeNames;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.util.ArrayList;
import java.util.Collections;
import java.util.HexFormat;
import java.util.List;
import java.util.Map;
import java.util.TreeMap;

/**
 * Extracts {@code functions[]} entries from one already-parsed compilation unit.
 *
 * <p>Package-private and stateless: {@link GraphExtractor} owns the parse loop so
 * each file is read once for both nodes and edges.
 */
final class FunctionExtractor {

    private FunctionExtractor() {}

    /** Per-file outcome. Errors are per-declaration, so one bad method costs only itself. */
    record Result(
            List<ParsedFunction> functions,
            List<ParseError> errors,
            int unresolvedParamTypes,
            Map<String, String> keysByPosition) {}

    static Result fromCompilationUnit(
            CompilationUnit cu, String relativePath, Map<ObjectCreationExpr, String> anonymousNames) {
        List<ParsedFunction> functions = new ArrayList<>();
        List<ParseError> errors = new ArrayList<>();
        // Position -> key, so edge extraction can reuse the exact key a node got
        // rather than recomputing it under different resolution conditions.
        Map<String, String> keysByPosition = new java.util.HashMap<>();
        int unresolvedParams = 0;

        for (CallableDeclaration<?> callable : cu.findAll(CallableDeclaration.class)) {
            try {
                ParsedFunction fn = toFunction(callable, relativePath, anonymousNames);
                functions.add(fn);
                unresolvedParams += fn.unresolvedParamTypes();
                Declarations.positionOf(callable).ifPresent(pos -> keysByPosition.put(pos, fn.key()));
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
        return new Result(functions, errors, unresolvedParams, keysByPosition);
    }

    private static ParsedFunction toFunction(
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

        Declarations.DeclaringType owner = Declarations.declaringTypeOf(callable, anonymousNames);
        String methodName = isConstructor ? NodeKeys.CONSTRUCTOR_NAME : callable.getNameAsString();
        String returnType =
                isConstructor ? "void" : TypeNames.of(((MethodDeclaration) callable).getType()).name();

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
                isAbstract(callable, owner.isInterface()),
                owner.isInterface(),
                unresolved);
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

    static AnnotationRef toAnnotationRef(AnnotationExpr annotation) {
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
        // NOT Map.copyOf: its iteration order depends on a per-JVM random salt, so
        // it silently discards the TreeMap ordering above. The salt is constant
        // within a JVM, which is why every in-process determinism test passed while
        // two CLI runs produced different bytes for the same commit — a §8 purity
        // violation that would have made graph versions irreproducible.
        return new AnnotationRef(
                annotation.getName().getIdentifier(), Collections.unmodifiableMap(values));
    }

    /**
     * String literals are stored unquoted so phase 5 can concatenate route paths
     * directly; every other expression keeps its source text.
     */
    private static String literalOf(Expression expression) {
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
}
