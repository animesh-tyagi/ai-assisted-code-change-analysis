package com.impact.parser.extract;

import com.github.javaparser.ast.CompilationUnit;
import com.github.javaparser.ast.body.CallableDeclaration;
import com.github.javaparser.ast.body.ClassOrInterfaceDeclaration;
import com.github.javaparser.ast.expr.MethodCallExpr;
import com.github.javaparser.ast.expr.MethodReferenceExpr;
import com.github.javaparser.ast.expr.ObjectCreationExpr;
import com.github.javaparser.ast.nodeTypes.NodeWithSimpleName;
import com.github.javaparser.resolution.declarations.ResolvedConstructorDeclaration;
import com.github.javaparser.resolution.declarations.ResolvedMethodDeclaration;
import com.github.javaparser.resolution.declarations.ResolvedReferenceTypeDeclaration;
import com.github.javaparser.resolution.types.ResolvedReferenceType;
import com.impact.parser.graph.CallSite;
import com.impact.parser.graph.Confidence;
import com.impact.parser.graph.EdgeCollector;
import com.impact.parser.graph.EdgeType;
import com.impact.parser.graph.NodeKeys;
import com.impact.parser.graph.UnresolvedReason;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.Optional;

/**
 * Builds the structural edges of section 6.3: {@code calls}, {@code implements},
 * {@code overrides}, and the {@code unresolved} sink of section 6.5.
 *
 * <p>The Spring-inferred edges — interface dispatch, routes, Spring Data — are a
 * separate concern and land in phase 5. Everything here is either written
 * literally in the source or is a structural type fact, so every edge this class
 * emits carries {@code inferred: false}.
 *
 * <p><strong>What counts as an edge.</strong> A resolved call to a JDK or
 * third-party method is not recorded. D2 is explicit that the impact surface is
 * entirely intra-repo: you cannot change {@code java.util.HashMap}, so an edge to
 * it can never carry impact, and reverse traversal would never walk through it.
 * Such calls are counted as {@code externalCalls} instead of being dropped
 * silently. This is a different case from section 6.5's unresolved calls, which
 * are ones we <em>failed</em> to bind and which therefore might have been in-repo.
 * Conflating the two would make {@code unresolvedRate} meaningless as a health
 * metric.
 */
final class EdgeExtractor {

    /** Counters that feed {@code diagnostics} in the parse response. */
    static final class Stats {
        int externalCalls;
        int unresolvedCalls;
        int ambiguousOverloads;
        int failedDeclarations;
        /**
         * In-extraction-set targets whose key was not in the index, so it had to be
         * recomputed from the resolved signature.
         *
         * <p>Should be zero in full mode. It can be non-zero in subset mode, where
         * only touched files are indexed while a call may target an untouched one —
         * a known gap, counted here so it is visible rather than silent, and to be
         * closed when subset mode is exercised for real in phase 7.
         */
        int targetsMissingFromIndex;
        final List<String> ambiguousOverloadTargets = new ArrayList<>();
    }

    private final EdgeCollector collector;
    private final Stats stats;
    private final Map<String, String> keyIndex;
    private final List<java.nio.file.Path> extractionRoots;

    EdgeExtractor(
            EdgeCollector collector,
            Stats stats,
            Map<String, String> keyIndex,
            List<java.nio.file.Path> extractionRoots) {
        this.collector = collector;
        this.stats = stats;
        this.keyIndex = keyIndex;
        this.extractionRoots = extractionRoots;
    }

    void extractFrom(
            CompilationUnit cu, String relativePath, Map<ObjectCreationExpr, String> anonymousNames) {
        for (CallableDeclaration<?> callable : cu.findAll(CallableDeclaration.class)) {
            // Isolated per declaration. A single unresolvable symbol must cost one
            // edge, never a whole file's worth: an earlier version wrapped the file
            // and one `Pageable` silently erased every edge in twenty petclinic
            // files, which is the exact blind spot this tool exists to prevent.
            try {
                String fromKey = Declarations.keyOf(callable, anonymousNames);
                callSites(callable, relativePath, fromKey);
                inheritanceEdges(callable, relativePath, fromKey, anonymousNames);
            } catch (RuntimeException e) {
                stats.failedDeclarations++;
            }
        }
    }

    // -----------------------------------------------------------------------
    // calls
    // -----------------------------------------------------------------------

    private void callSites(CallableDeclaration<?> callable, String relativePath, String fromKey) {
        for (MethodCallExpr call : callable.findAll(MethodCallExpr.class)) {
            // A nested callable (a local class's method) owns its own calls.
            if (!ownsNode(callable, call)) {
                continue;
            }
            guard(() -> resolveCall(call, relativePath, fromKey));
        }
        for (ObjectCreationExpr creation : callable.findAll(ObjectCreationExpr.class)) {
            if (!ownsNode(callable, creation)) {
                continue;
            }
            guard(() -> resolveConstruction(creation, relativePath, fromKey));
        }
        for (MethodReferenceExpr reference : callable.findAll(MethodReferenceExpr.class)) {
            if (!ownsNode(callable, reference)) {
                continue;
            }
            // `this::handle` is as much a call edge as `handle()` — the method is
            // reachable, so a change to it affects this caller.
            guard(() -> resolveMethodReference(reference, relativePath, fromKey));
        }
    }

    /** True when the nearest enclosing callable of {@code node} is {@code callable}. */
    private static boolean ownsNode(CallableDeclaration<?> callable, com.github.javaparser.ast.Node node) {
        return Declarations.enclosingCallable(node).map(owner -> owner == callable).orElse(false);
    }

    private void resolveCall(MethodCallExpr call, String relativePath, String fromKey) {
        CallSite site = siteOf(call, relativePath);
        try {
            ResolvedMethodDeclaration target = call.resolve();
            recordResolvedCall(target, fromKey, site, Confidence.EXACT);
        } catch (RuntimeException e) {
            // Section 6.6: argument types too weak to pick an overload. If the
            // target type offers exactly one method of that name and arity, bind
            // it — downgraded to single_impl, because we chose by elimination
            // rather than by matching types.
            Optional<ResolvedMethodDeclaration> only = onlyCandidateByNameAndArity(call);
            if (only.isPresent()) {
                recordResolvedCall(only.get(), fromKey, site, Confidence.SINGLE_IMPL);
                return;
            }
            recordUnresolved(call, fromKey, site, reasonFor(e), call.getNameAsString());
        }
    }

    private void resolveConstruction(ObjectCreationExpr creation, String relativePath, String fromKey) {
        CallSite site = siteOf(creation, relativePath);
        try {
            ResolvedConstructorDeclaration target = creation.resolve();
            if (isInExtractionSet(target)) {
                collector.add(
                        fromKey, keyOfTarget(target), EdgeType.CALLS, false, Confidence.EXACT, site);
            } else {
                stats.externalCalls++;
            }
        } catch (RuntimeException e) {
            recordUnresolved(creation, fromKey, site, reasonFor(e), creation.getType().getNameAsString());
        }
    }

    private void resolveMethodReference(
            MethodReferenceExpr reference, String relativePath, String fromKey) {
        CallSite site = siteOf(reference, relativePath);
        try {
            var resolved = reference.resolve();
            if (resolved instanceof ResolvedMethodDeclaration method) {
                recordResolvedCall(method, fromKey, site, Confidence.EXACT);
            }
        } catch (RuntimeException e) {
            recordUnresolved(reference, fromKey, site, reasonFor(e), reference.getIdentifier());
        }
    }

    private void recordResolvedCall(
            ResolvedMethodDeclaration target, String fromKey, CallSite site, Confidence confidence) {
        if (!isInExtractionSet(target)) {
            stats.externalCalls++;
            return;
        }
        collector.add(fromKey, keyOfTarget(target), EdgeType.CALLS, false, confidence, site);
    }

    /**
     * The node key of a resolved in-repo target.
     *
     * <p>Derived from the target's own AST rather than from its resolved
     * signature, and that is load-bearing. {@code functions[]} keys come from the
     * AST (so that a method with an unresolvable parameter type still gets a
     * node); if edge targets were keyed from resolved types instead, the two would
     * disagree exactly for those methods and every edge into them would point at a
     * node that does not exist. Deriving both from the AST makes them equal by
     * construction.
     */
    private String keyOfTarget(ResolvedMethodDeclaration target) {
        return indexedKey(target)
                .orElseGet(
                        () -> {
                            stats.targetsMissingFromIndex++;
                            return NodeKeys.forMethod(target);
                        });
    }

    private String keyOfTarget(ResolvedConstructorDeclaration target) {
        return indexedKey(target)
                .orElseGet(
                        () -> {
                            stats.targetsMissingFromIndex++;
                            return NodeKeys.forConstructor(target);
                        });
    }

    /**
     * The key {@code functions[]} already gave this declaration, found by source
     * position.
     *
     * <p>Looking the key up rather than recomputing it is the only way to
     * guarantee an edge target matches its node. Recomputing from the AST that
     * {@code toAst()} returns does <em>not</em> work: that node comes from
     * {@code JavaParserTypeSolver}'s own internal parse, which carries no symbol
     * solver, so its parameter types fail to resolve and fall back to source text.
     * The result is a key like {@code #findById(Long)} against a node keyed
     * {@code #findById(java.lang.Long)} — every edge into that method would
     * dangle. Recomputing from the resolved signature has the mirror-image flaw:
     * it throws for in-repo methods whose parameter types are third-party, which
     * is precisely the case {@code functions[]} handles by falling back.
     *
     * <p>A position — absolute file path plus start line — is stable across both
     * parses, so it identifies the same declaration in either.
     */
    private Optional<String> indexedKey(Object resolvedDeclaration) {
        if (!(resolvedDeclaration
                instanceof com.github.javaparser.resolution.declarations.AssociableToAST associable)) {
            return Optional.empty();
        }
        return associable
                .toAst()
                .flatMap(Declarations::positionOf)
                .map(keyIndex::get)
                .filter(java.util.Objects::nonNull);
    }

    private static void guard(Runnable action) {
        try {
            action.run();
        } catch (RuntimeException ignored) {
            // One unresolvable call site costs one edge, not the file.
        }
    }

    private void recordUnresolved(
            com.github.javaparser.ast.Node node,
            String fromKey,
            CallSite site,
            UnresolvedReason reason,
            String bestEffortName) {
        stats.unresolvedCalls++;
        String target = NodeKeys.unresolved(bestEffortTarget(node, bestEffortName));
        List<String> candidates = List.of();
        if (reason == UnresolvedReason.AMBIGUOUS_OVERLOAD) {
            stats.ambiguousOverloads++;
            stats.ambiguousOverloadTargets.add(target);
            candidates = candidatesFor(node);
        }
        collector.add(
                fromKey,
                target,
                EdgeType.UNRESOLVED,
                false,
                Confidence.AMBIGUOUS,
                site,
                reason,
                candidates);
    }

    /**
     * Best textual description of a target we could not bind.
     *
     * <p>Section 6.5 requires the unresolved node to carry the best available
     * target rather than a placeholder, so the sink stays diagnosable: a spike in
     * {@code unresolvedRate} should be traceable to a named type.
     */
    private static String bestEffortTarget(com.github.javaparser.ast.Node node, String name) {
        if (node instanceof MethodCallExpr call) {
            return call.getScope()
                    .map(scope -> scopeDescription(scope) + "#" + name)
                    .orElse("#" + name);
        }
        if (node instanceof ObjectCreationExpr creation) {
            return creation.getType().getNameAsString() + "#" + NodeKeys.CONSTRUCTOR_NAME;
        }
        if (node instanceof MethodReferenceExpr reference) {
            return reference.getScope().toString() + "#" + name;
        }
        return "#" + name;
    }

    private static String scopeDescription(com.github.javaparser.ast.expr.Expression scope) {
        try {
            return scope.calculateResolvedType().describe();
        } catch (RuntimeException e) {
            // The scope itself is unresolvable — its source text is the best we have.
            return scope.toString();
        }
    }

    /** Section 6.6: exactly one method of that name and arity on the target type. */
    private static Optional<ResolvedMethodDeclaration> onlyCandidateByNameAndArity(MethodCallExpr call) {
        List<ResolvedMethodDeclaration> candidates = candidateMethods(call);
        return candidates.size() == 1 ? Optional.of(candidates.getFirst()) : Optional.empty();
    }

    private static List<ResolvedMethodDeclaration> candidateMethods(MethodCallExpr call) {
        try {
            var scope = call.getScope();
            if (scope.isEmpty()) {
                return List.of();
            }
            ResolvedReferenceTypeDeclaration type =
                    scope.get().calculateResolvedType().asReferenceType().getTypeDeclaration().orElse(null);
            if (type == null) {
                return List.of();
            }
            return type.getDeclaredMethods().stream()
                    .filter(m -> m.getName().equals(call.getNameAsString()))
                    .filter(m -> m.getNumberOfParams() == call.getArguments().size())
                    .toList();
        } catch (RuntimeException e) {
            return List.of();
        }
    }

    private static List<String> candidatesFor(com.github.javaparser.ast.Node node) {
        if (node instanceof MethodCallExpr call) {
            return candidateMethods(call).stream().map(ResolvedMethodDeclaration::getQualifiedSignature).sorted().toList();
        }
        return List.of();
    }

    /**
     * Distinguishes "several overloads matched" from "the type is not on the
     * classpath at all", so the reason recorded on the edge is honest.
     */
    private static UnresolvedReason reasonFor(RuntimeException e) {
        String name = e.getClass().getSimpleName();
        if (name.contains("Ambiguity")) {
            return UnresolvedReason.AMBIGUOUS_OVERLOAD;
        }
        return UnresolvedReason.EXTERNAL_TYPE;
    }

    // -----------------------------------------------------------------------
    // implements / overrides
    // -----------------------------------------------------------------------

    /**
     * Structural inheritance edges.
     *
     * <p>Emitted for every in-repo supertype method with a matching signature:
     * {@code implements} when the supertype is an interface, {@code overrides}
     * when it is a class. Both are facts about the type system, so they are
     * {@code exact} and {@code inferred: false} — section 6.4 is explicit that
     * these are structural and not gated on any annotation.
     *
     * <p>Supertypes outside the repo are skipped for the same reason external
     * calls are: overriding {@code Object#toString} carries no impact anyone can
     * act on. One consequence worth knowing — implementing a framework interface
     * such as {@code HandlerInterceptor} yields no edge here, so those methods
     * appear callerless until an entry-point surface covers them (section 6.4).
     */
    private void inheritanceEdges(
            CallableDeclaration<?> callable,
            String relativePath,
            String fromKey,
            Map<ObjectCreationExpr, String> anonymousNames) {
        if (!(callable instanceof com.github.javaparser.ast.body.MethodDeclaration method)) {
            return; // constructors are not inherited
        }
        var ownerNode = method.findAncestor(ClassOrInterfaceDeclaration.class);
        if (ownerNode.isEmpty()) {
            return;
        }

        List<ResolvedReferenceType> ancestors = safeAncestors(ownerNode.get());
        CallSite site = siteOf(method, relativePath);
        List<String> paramTypes = Declarations.paramTypesOf(method);

        for (ResolvedReferenceType ancestor : ancestors) {
            ResolvedReferenceTypeDeclaration ancestorType = ancestor.getTypeDeclaration().orElse(null);
            if (ancestorType == null || !isInExtractionSet(ancestorType)) {
                continue;
            }
            for (ResolvedMethodDeclaration candidate : declaredMethodsOf(ancestorType)) {
                if (!candidate.getName().equals(method.getNameAsString())
                        || candidate.getNumberOfParams() != paramTypes.size()) {
                    continue;
                }
                if (!erasedParamsMatch(candidate, paramTypes)) {
                    continue;
                }
                EdgeType type = ancestorType.isInterface() ? EdgeType.IMPLEMENTS : EdgeType.OVERRIDES;
                collector.add(fromKey, keyOfTarget(candidate), type, false, Confidence.EXACT, site);
            }
        }
    }

    private static boolean erasedParamsMatch(ResolvedMethodDeclaration candidate, List<String> paramTypes) {
        try {
            for (int i = 0; i < paramTypes.size(); i++) {
                if (!NodeKeys.erase(candidate.getParam(i).getType()).equals(paramTypes.get(i))) {
                    return false;
                }
            }
            return true;
        } catch (RuntimeException e) {
            // A supertype parameter that will not resolve: name and arity already
            // matched, so treating it as a match is the safer over-approximation.
            return true;
        }
    }

    private static List<ResolvedMethodDeclaration> declaredMethodsOf(ResolvedReferenceTypeDeclaration type) {
        try {
            return List.copyOf(type.getDeclaredMethods());
        } catch (RuntimeException e) {
            return List.of();
        }
    }

    /** Ancestors, tolerating a hierarchy that reaches outside the solver. */
    private static List<ResolvedReferenceType> safeAncestors(ClassOrInterfaceDeclaration type) {
        try {
            return List.copyOf(type.resolve().getAllAncestors());
        } catch (RuntimeException e) {
            // A single unresolvable supertype (a framework base class) must not
            // cost us the resolvable ones, so fall back to the direct ancestors.
            List<ResolvedReferenceType> direct = new ArrayList<>();
            for (var declared : type.getExtendedTypes()) {
                addResolved(direct, declared);
            }
            for (var declared : type.getImplementedTypes()) {
                addResolved(direct, declared);
            }
            return direct;
        }
    }

    private static void addResolved(
            List<ResolvedReferenceType> into, com.github.javaparser.ast.type.ClassOrInterfaceType declared) {
        try {
            var resolved = declared.resolve();
            if (resolved.isReferenceType()) {
                into.add(resolved.asReferenceType());
            }
        } catch (RuntimeException ignored) {
            // Unresolvable supertype — nothing to attach an edge to.
        }
    }

    // -----------------------------------------------------------------------
    // Shared helpers
    // -----------------------------------------------------------------------

    /**
     * Whether a resolved target is in the <strong>extraction set</strong> — the
     * files that become nodes (section 6.5, bucket 1).
     *
     * <p>Membership is decided by source location, not by whether the declaration
     * has an AST. Those differ, and the difference is a real bug: generated
     * sources are fed to the solver so hand-written code can resolve them, so they
     * <em>do</em> have an AST — but they are not extracted, so an edge to one would
     * point at a node that was never emitted. Location is the honest test.
     *
     * <p>A target under no extraction root is bucket 2: resolved, counted, not
     * graphed. Nothing can act on a change to it, because it is either the JDK, a
     * jar, or regenerated output.
     */
    private boolean isInExtractionSet(Object declaration) {
        return sourcePathOf(declaration)
                .map(path -> extractionRoots.stream().anyMatch(path::startsWith))
                .orElse(false);
    }

    private static Optional<java.nio.file.Path> sourcePathOf(Object declaration) {
        if (!(declaration
                instanceof com.github.javaparser.resolution.declarations.AssociableToAST associable)) {
            return Optional.empty();
        }
        return associable
                .toAst()
                .flatMap(com.github.javaparser.ast.Node::findCompilationUnit)
                .flatMap(CompilationUnit::getStorage)
                .map(storage -> storage.getPath().toAbsolutePath().normalize());
    }

    private static CallSite siteOf(com.github.javaparser.ast.Node node, String relativePath) {
        return new CallSite(relativePath, node.getBegin().map(p -> p.line).orElse(0));
    }

    /** Unused today; kept so the compiler flags an unqualified name mismatch early. */
    @SuppressWarnings("unused")
    private static String nameOf(NodeWithSimpleName<?> node) {
        return node.getNameAsString();
    }
}
