package com.impact.parser.extract;

import com.github.javaparser.ast.CompilationUnit;
import com.github.javaparser.ast.Node;
import com.github.javaparser.ast.body.CallableDeclaration;
import com.github.javaparser.ast.body.ClassOrInterfaceDeclaration;
import com.github.javaparser.ast.body.ConstructorDeclaration;
import com.github.javaparser.ast.body.TypeDeclaration;
import com.github.javaparser.ast.expr.ObjectCreationExpr;
import com.impact.parser.graph.NodeKeys;
import com.impact.parser.resolve.TypeNames;
import java.util.IdentityHashMap;
import java.util.List;
import java.util.Map;
import java.util.Optional;

/**
 * Naming declarations consistently, shared by function and edge extraction.
 *
 * <p>Both passes must agree exactly on what a callable is called: a {@code calls}
 * edge whose {@code from} key differs from the corresponding entry in
 * {@code functions[]} points at a node that does not exist. Keeping the naming in
 * one place is what stops the two drifting.
 */
final class Declarations {

    private Declarations() {}

    /** The type a callable belongs to, named well enough to key it uniquely. */
    record DeclaringType(String fqcn, String simpleName, boolean isInterface) {}

    /**
     * Assigns JVM-style names to anonymous classes: {@code Outer$1}, {@code Outer$2}.
     *
     * <p>Anonymous class bodies are not {@code TypeDeclaration}s, so walking up to
     * the nearest declared type attributes their methods to the <em>enclosing</em>
     * class. In real code that collides: petclinic's {@code JdbcVetRepositoryImpl}
     * declares two anonymous {@code BeanPropertyRowMapper}s, each with
     * {@code mapRow(ResultSet,int)}, which produced two nodes sharing one key.
     * Duplicate keys violate the unique indexes in section 7 and would merge two
     * unrelated methods into one node.
     *
     * <p>Numbering follows source order within the outermost type, which is what
     * the JVM does. Known limitation, inherited from the JVM's own scheme: adding
     * an anonymous class earlier in a file renumbers the ones after it.
     */
    static Map<ObjectCreationExpr, String> anonymousClassNames(CompilationUnit cu) {
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
     * method on a nested class is attributed to {@code Outer.Inner}. Anonymous and
     * local classes, which have no qualified name of their own, get a synthetic
     * {@code $}-suffixed one rather than being folded into their parent.
     */
    static DeclaringType declaringTypeOf(Node node, Map<ObjectCreationExpr, String> anonymousNames) {
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
                                        // A local class (declared inside a method) has no qualified
                                        // name; qualify it through its enclosing type so it cannot
                                        // collide with a same-named local class elsewhere.
                                        () ->
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

    /**
     * The node key for a callable, derived from its AST.
     *
     * <p>Deliberately AST-based rather than resolution-based: a method whose
     * parameter types will not resolve must still get a key, or the whole node
     * disappears and its method looks uncalled. See {@link TypeNames}.
     */
    static String keyOf(CallableDeclaration<?> callable, Map<ObjectCreationExpr, String> anonymousNames) {
        DeclaringType owner = declaringTypeOf(callable, anonymousNames);
        String methodName =
                callable instanceof ConstructorDeclaration
                        ? NodeKeys.CONSTRUCTOR_NAME
                        : callable.getNameAsString();
        return NodeKeys.format(owner.fqcn(), methodName, paramTypesOf(callable));
    }

    /** Erased parameter types, with the varargs normalisation the key format requires. */
    static List<String> paramTypesOf(CallableDeclaration<?> callable) {
        return callable.getParameters().stream()
                .map(
                        parameter -> {
                            String name = TypeNames.of(parameter.getType()).name();
                            return parameter.isVarArgs() && !name.endsWith("[]") ? name + "[]" : name;
                        })
                .toList();
    }

    /** The callable a node sits inside, if any. */
    static Optional<CallableDeclaration<?>> enclosingCallable(Node node) {
        Node current = node;
        while (current.getParentNode().isPresent()) {
            current = current.getParentNode().get();
            if (current instanceof CallableDeclaration<?> callable) {
                return Optional.of(callable);
            }
        }
        return Optional.empty();
    }

    /**
     * A parse-independent identity for a declaration: absolute file path plus
     * start line.
     *
     * <p>Node object identity cannot be used, because the same declaration is
     * parsed twice — once by the extractor and once inside
     * {@code JavaParserTypeSolver} — producing two unrelated AST objects. A
     * source position is the same in both.
     */
    static Optional<String> positionOf(com.github.javaparser.ast.Node node) {
        return node.findCompilationUnit()
                .flatMap(CompilationUnit::getStorage)
                .map(storage -> storage.getPath().toAbsolutePath().normalize().toString())
                .flatMap(path -> node.getBegin().map(begin -> path + "#" + begin.line));
    }

    static String simpleNameOf(String fqcn) {
        int lastDot = fqcn.lastIndexOf('.');
        return lastDot == -1 ? fqcn : fqcn.substring(lastDot + 1);
    }
}
