package com.impact.parser.spring;

import com.github.javaparser.ast.body.ClassOrInterfaceDeclaration;
import com.github.javaparser.ast.body.MethodDeclaration;
import com.github.javaparser.ast.type.ClassOrInterfaceType;
import com.github.javaparser.resolution.declarations.ResolvedMethodDeclaration;
import com.github.javaparser.resolution.declarations.ResolvedReferenceTypeDeclaration;
import com.github.javaparser.resolution.types.ResolvedReferenceType;
import java.util.ArrayList;
import java.util.List;
import java.util.Optional;

/**
 * Walking a type's supertypes and reading declarations off them.
 *
 * <p><strong>Deliberately spans solver-only sources.</strong> Unlike the
 * structural {@code implements} edges of §6.3 — which are restricted to the
 * extraction set, because an edge must point at a node that exists — the rules
 * here <em>read</em> supertypes without creating nodes for them. That distinction
 * is what makes route inheritance work: petclinic's controllers implement
 * OpenAPI-generated interfaces under {@code target/generated-sources}, and the
 * method-level {@code @RequestMapping} annotations live only there. The route is
 * real and Spring serves it; only the declaration site is generated.
 *
 * <p>Reading annotations needs no symbol resolution — they are matched by name
 * off the raw AST (D2) — so an AST reached through the type solver is enough,
 * even though that parse carries no symbol resolver of its own.
 */
public final class Supertypes {

    private Supertypes() {}

    /**
     * The AST of the corresponding method on any supertype, nearest first.
     *
     * <p>Matched on name and arity rather than erased parameter types. A
     * supertype's parameters frequently fail to resolve (they are the very
     * third-party types D2 leaves out), and demanding an exact type match would
     * discard the override precisely when it matters most. Name plus arity
     * over-approximates only across same-arity overloads, which is rare enough to
     * accept and safer than losing the route entirely.
     */
    public static List<MethodDeclaration> correspondingMethods(
            ClassOrInterfaceDeclaration type, MethodDeclaration method) {
        List<MethodDeclaration> found = new ArrayList<>();
        for (ResolvedReferenceType ancestor : safeAncestors(type)) {
            Optional<ResolvedReferenceTypeDeclaration> declaration = ancestor.getTypeDeclaration();
            if (declaration.isEmpty()) {
                continue;
            }
            for (ResolvedMethodDeclaration candidate : declaredMethods(declaration.get())) {
                if (!candidate.getName().equals(method.getNameAsString())
                        || candidate.getNumberOfParams() != method.getParameters().size()) {
                    continue;
                }
                candidate
                        .toAst()
                        .filter(MethodDeclaration.class::isInstance)
                        .map(MethodDeclaration.class::cast)
                        .ifPresent(found::add);
            }
        }
        return found;
    }

    private static List<ResolvedMethodDeclaration> declaredMethods(ResolvedReferenceTypeDeclaration type) {
        try {
            return List.copyOf(type.getDeclaredMethods());
        } catch (RuntimeException e) {
            return List.of();
        }
    }

    /** Ancestors, tolerating a hierarchy that reaches outside the solver. */
    public static List<ResolvedReferenceType> safeAncestors(ClassOrInterfaceDeclaration type) {
        try {
            return List.copyOf(type.resolve().getAllAncestors());
        } catch (RuntimeException e) {
            // One unresolvable supertype — a framework base class — must not cost
            // us the resolvable ones.
            List<ResolvedReferenceType> direct = new ArrayList<>();
            type.getExtendedTypes().forEach(declared -> addResolved(direct, declared));
            type.getImplementedTypes().forEach(declared -> addResolved(direct, declared));
            return direct;
        }
    }

    private static void addResolved(List<ResolvedReferenceType> into, ClassOrInterfaceType declared) {
        try {
            var resolved = declared.resolve();
            if (resolved.isReferenceType()) {
                into.add(resolved.asReferenceType());
            }
        } catch (RuntimeException ignored) {
            // Unresolvable supertype — nothing to read from.
        }
    }
}
