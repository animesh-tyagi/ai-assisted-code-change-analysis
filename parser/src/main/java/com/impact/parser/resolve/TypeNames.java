package com.impact.parser.resolve;

import com.github.javaparser.ast.CompilationUnit;
import com.github.javaparser.ast.ImportDeclaration;
import com.github.javaparser.ast.type.ArrayType;
import com.github.javaparser.ast.type.ClassOrInterfaceType;
import com.github.javaparser.ast.type.Type;
import com.impact.parser.graph.NodeKeys;
import java.util.Optional;

/**
 * Names a type as precisely as the available resolution allows, and reports how
 * confident that name is.
 *
 * <p><strong>Why this exists.</strong> Under source+JDK resolution (D2), a
 * parameter typed with a third-party class — {@code HttpServletRequest},
 * {@code Pageable} — does not resolve. Asking {@link NodeKeys} for a key would
 * then throw, and the enclosing method would vanish from the graph entirely. That
 * is the worst possible failure for an impact analyser: a controller method with
 * no node has no callers, so a change to it looks harmless. Section 6.5's rule —
 * never drop, always record — applies to nodes just as it does to edges.
 *
 * <p>So resolution is attempted first, and on failure the type is named from the
 * source text, qualified through the compilation unit's explicit imports. The
 * result is deterministic and usually correct; {@link Named#resolved()} records
 * which path was taken so the imprecision is counted rather than hidden.
 *
 * <p>What this deliberately does <em>not</em> do is guess. An unqualified name
 * with no matching import is left exactly as written rather than being assumed
 * same-package or expanded from a wildcard import — a wrong fully-qualified name
 * is worse than an honestly partial one, because it looks authoritative.
 */
public final class TypeNames {

    private TypeNames() {}

    /**
     * A type name plus whether it came from real symbol resolution.
     *
     * @param name erased type name — fully qualified when {@code resolved}, and
     *     best-effort qualified otherwise
     * @param resolved true when SymbolSolver bound the type
     */
    public record Named(String name, boolean resolved) {}

    /** Names an AST type, resolving it if possible. */
    public static Named of(Type astType) {
        try {
            return new Named(NodeKeys.erase(astType.resolve()), true);
        } catch (RuntimeException e) {
            // Unresolvable: almost always a third-party type absent from the
            // source+JDK solver. Fall back rather than lose the enclosing node.
            return new Named(fromSource(astType), false);
        }
    }

    /**
     * Names a type from source text alone, erasing generics and qualifying simple
     * names through explicit imports.
     */
    public static String fromSource(Type astType) {
        if (astType.isArrayType()) {
            ArrayType array = astType.asArrayType();
            return fromSource(array.getComponentType()) + "[]";
        }
        if (astType.isPrimitiveType()) {
            return astType.asPrimitiveType().asString();
        }
        if (astType.isVoidType()) {
            return "void";
        }
        if (astType.isClassOrInterfaceType()) {
            ClassOrInterfaceType declared = astType.asClassOrInterfaceType();
            // getNameAsString() excludes type arguments, which is the erasure.
            String written = declared.getScope().map(s -> s.asString() + ".").orElse("")
                    + declared.getNameAsString();
            return qualify(astType, written);
        }
        // Wildcards, union types and anything exotic: erase to Object the way the
        // JVM would, rather than inventing a name.
        return "java.lang.Object";
    }

    /**
     * Qualifies a simple name using the compilation unit's explicit imports.
     *
     * <p>Wildcard imports are skipped on purpose: {@code import java.util.*} does
     * not tell us that {@code Foo} is {@code java.util.Foo}, and pretending it
     * does would fabricate a fully-qualified name.
     */
    private static String qualify(Type astType, String written) {
        if (written.contains(".")) {
            return written; // already qualified in source
        }
        Optional<CompilationUnit> cu = astType.findCompilationUnit();
        if (cu.isEmpty()) {
            return written;
        }
        for (ImportDeclaration importDecl : cu.get().getImports()) {
            if (importDecl.isAsterisk() || importDecl.isStatic()) {
                continue;
            }
            String imported = importDecl.getNameAsString();
            if (imported.endsWith("." + written)) {
                return imported;
            }
        }
        return written;
    }
}
