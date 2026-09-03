package com.impact.parser.graph;

import com.github.javaparser.resolution.declarations.ResolvedConstructorDeclaration;
import com.github.javaparser.resolution.declarations.ResolvedMethodDeclaration;
import com.github.javaparser.resolution.declarations.ResolvedParameterDeclaration;
import com.github.javaparser.resolution.types.ResolvedType;
import com.github.javaparser.resolution.types.ResolvedTypeVariable;
import com.github.javaparser.resolution.types.ResolvedWildcard;
import java.util.ArrayList;
import java.util.List;
import java.util.stream.Collectors;

/**
 * Derivation of node keys, per ARCHITECTURE.md section 6.1.
 *
 * <p><strong>This class is the single source of truth for how a node key is
 * produced.</strong> The TypeScript side ({@code shared/src/nodeKey.ts}) only
 * <em>parses and formats</em> the resulting string; it deliberately does not
 * re-implement derivation. Two implementations of the project's most load-bearing
 * identifier would disagree silently, and a key bug is invisible — a changed
 * method would look like a delete plus a create, losing every edge and all
 * history attached to it.
 *
 * <p>Key shape:
 *
 * <pre>
 * fn:com.acme.user.UserService#findById(java.lang.Long)
 * </pre>
 *
 * <p><strong>Why the structured API and not {@code getQualifiedSignature()}.</strong>
 * That method returns a rendered signature such as
 * {@code com.acme.Svc.find(java.util.Map<java.lang.String, java.util.List<java.lang.Integer>>)}.
 * Recovering parameters from it means parsing nested angle brackets and
 * distinguishing a generic comma from a parameter comma — fragile, and wrong the
 * first time a nested generic appears. Reading {@link ResolvedMethodDeclaration}
 * parameter-by-parameter and erasing each type is both simpler and exact.
 *
 * <p><strong>Erasure.</strong> Parameter types are erased the way the JVM erases
 * them, so the key is stable across changes that do not change the runtime
 * signature: generics drop to their raw type, type variables drop to their first
 * bound (or {@code java.lang.Object}), and varargs become arrays.
 */
public final class NodeKeys {

    /** Namespace prefixes (ARCHITECTURE section 6.2). Mirrors NODE_KINDS in nodeKey.ts. */
    public static final String FN_PREFIX = "fn:";

    public static final String UNRESOLVED_PREFIX = "unresolved:";

    /**
     * Method name used for constructors.
     *
     * <p>Section 6.1 spells out methods only, but constructors are callable and a
     * change to one has callers, so they need node identity too. {@code <init>} is
     * the JVM's own name for a constructor and cannot collide with a real Java
     * method name, which makes it unambiguous in the flat key string.
     */
    public static final String CONSTRUCTOR_NAME = "<init>";

    private NodeKeys() {}

    // -----------------------------------------------------------------------
    // Formatting
    // -----------------------------------------------------------------------

    /**
     * Builds a {@code fn:} key from already-normalised parts.
     *
     * <p>Parameters are joined with {@code ,} and no spaces. That is not cosmetic:
     * keys are compared as exact strings and used as MongoDB index values, so a
     * stray space would fragment node identity. This matches
     * {@code formatFunctionKey} in nodeKey.ts byte for byte.
     */
    public static String format(String fqcn, String methodName, List<String> paramTypes) {
        return FN_PREFIX + fqcn + "#" + methodName + "(" + String.join(",", paramTypes) + ")";
    }

    /** Key for a resolved method declaration. */
    public static String forMethod(ResolvedMethodDeclaration method) {
        return format(
                method.declaringType().getQualifiedName(), method.getName(), paramTypesOf(method::getNumberOfParams, method::getParam));
    }

    /** Key for a resolved constructor declaration; the method name is {@code <init>}. */
    public static String forConstructor(ResolvedConstructorDeclaration constructor) {
        return format(
                constructor.declaringType().getQualifiedName(),
                CONSTRUCTOR_NAME,
                paramTypesOf(constructor::getNumberOfParams, constructor::getParam));
    }

    /**
     * Key for a call site that could not be bound (ARCHITECTURE section 6.5).
     *
     * <p>Unresolved calls are never dropped — they become edges to an
     * {@code unresolved:} node carrying the best textual target available, so the
     * {@code unresolvedRate} metric stays honest.
     */
    public static String unresolved(String bestEffortTarget) {
        return UNRESOLVED_PREFIX + bestEffortTarget;
    }

    // -----------------------------------------------------------------------
    // Erasure
    // -----------------------------------------------------------------------

    /**
     * Erases a resolved type to a fully-qualified raw type name.
     *
     * <ul>
     *   <li>primitives keep their own name ({@code int}, {@code boolean})
     *   <li>arrays erase their component and keep {@code []}
     *   <li>reference types drop type arguments ({@code List<String>} to {@code java.util.List})
     *   <li>type variables drop to their first bound, else {@code java.lang.Object}
     *   <li>wildcards drop to their bound, else {@code java.lang.Object}
     * </ul>
     */
    public static String erase(ResolvedType type) {
        if (type.isPrimitive()) {
            return type.asPrimitive().describe();
        }
        if (type.isVoid()) {
            return "void";
        }
        if (type.isArray()) {
            return erase(type.asArrayType().getComponentType()) + "[]";
        }
        if (type.isTypeVariable()) {
            return eraseTypeVariable(type.asTypeVariable());
        }
        if (type.isWildcard()) {
            return eraseWildcard(type.asWildcard());
        }
        if (type.isReferenceType()) {
            // getQualifiedName() already excludes type arguments — this is the erasure.
            return type.asReferenceType().getQualifiedName();
        }
        // Union types (multi-catch) and anything exotic: fall back to the rendered
        // form rather than throwing. A slightly odd key beats losing the node.
        return type.describe();
    }

    private static String eraseTypeVariable(ResolvedTypeVariable variable) {
        try {
            var bounds = variable.asTypeParameter().getBounds();
            for (var bound : bounds) {
                if (bound.isExtends()) {
                    return erase(bound.getType());
                }
            }
        } catch (RuntimeException e) {
            // Unresolvable bound — Object is the correct JVM erasure anyway.
        }
        return "java.lang.Object";
    }

    private static String eraseWildcard(ResolvedWildcard wildcard) {
        try {
            if (wildcard.isBounded() && wildcard.isExtends()) {
                return erase(wildcard.getBoundedType());
            }
        } catch (RuntimeException e) {
            // Fall through to Object.
        }
        // `? super T` erases to Object, as does an unbounded `?`.
        return "java.lang.Object";
    }

    // -----------------------------------------------------------------------
    // Internals
    // -----------------------------------------------------------------------

    /** Shared parameter walk for methods and constructors. */
    private static List<String> paramTypesOf(CountSupplier count, ParamSupplier param) {
        List<String> types = new ArrayList<>();
        int n = count.get();
        for (int i = 0; i < n; i++) {
            types.add(eraseParameter(param.get(i)));
        }
        return types;
    }

    /**
     * Erases one parameter, accounting for varargs.
     *
     * <p>A variadic parameter is an array at the JVM level ({@code String...} is
     * {@code String[]}), which is what makes the key stable if the declaration is
     * later rewritten as an explicit array.
     *
     * <p>Verified behaviour: for {@code String... parts} JavaParser already reports
     * the resolved type as {@code java.lang.String[]} with {@code isArray() == true},
     * so the branch below does not normally fire. It is kept as a cheap guard
     * against that changing, not because the two cases have been observed to
     * differ. See {@code NodeKeysTest.varargsAreAlreadyArraysInTheResolvedType}.
     */
    private static String eraseParameter(ResolvedParameterDeclaration parameter) {
        ResolvedType type = parameter.getType();
        String erased = erase(type);
        if (parameter.isVariadic() && !erased.endsWith("[]")) {
            erased = erased + "[]";
        }
        return erased;
    }

    /** Renders a key's parameter list for logging and diagnostics. */
    public static String describeParams(List<ResolvedType> types) {
        return types.stream().map(NodeKeys::erase).collect(Collectors.joining(","));
    }

    @FunctionalInterface
    private interface CountSupplier {
        int get();
    }

    @FunctionalInterface
    private interface ParamSupplier {
        ResolvedParameterDeclaration get(int index);
    }
}
