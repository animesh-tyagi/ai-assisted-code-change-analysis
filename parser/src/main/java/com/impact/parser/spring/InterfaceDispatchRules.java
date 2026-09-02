package com.impact.parser.spring;

import com.impact.parser.graph.CallSite;
import com.impact.parser.graph.Confidence;
import com.impact.parser.graph.EdgeCollector;
import com.impact.parser.graph.EdgeType;
import com.impact.parser.graph.GraphEdge;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;

/**
 * Interface dispatch: a call through an interface reaches its implementations
 * (ARCHITECTURE.md §6.4, as rewritten).
 *
 * <p><strong>Discovery is annotation-independent.</strong> A real call dispatches
 * to whatever implementation is wired at runtime, whether Spring wired it or a
 * hand-built registry did. Annotations only *narrow or rank* candidates; they
 * never gate whether an implementation exists. observability-final's
 * {@code FailureStrategy} has four implementations, none annotated, all reachable
 * — requiring a stereotype would have found none of them.
 *
 * <p><strong>Over-approximate rather than miss.</strong> With several candidates
 * and no selector, edges go to <em>all</em> of them at
 * {@code confidence: "ambiguous"}. Impact analysis cannot tolerate a false
 * negative: if a call through the interface reaches an implementation and no edge
 * says so, a change to that implementation shows zero callers — the one failure
 * the tool exists to prevent. The ambiguous edges are true over-approximations,
 * and the confidence carries that uncertainty into the traversal so the
 * explanation hedges instead of asserting.
 *
 * <p>Runs after all files are walked, deriving everything from the
 * {@code implements} edges already collected — no second traversal of the source.
 */
public final class InterfaceDispatchRules {

    private final EdgeCollector edges;

    public InterfaceDispatchRules(EdgeCollector edges) {
        this.edges = edges;
    }

    /**
     * @param collected the structural edges gathered so far
     * @param primaryKeys methods whose declaring class carries {@code @Primary}
     * @param qualifiedKeys methods whose declaring class carries {@code @Qualifier}
     */
    public void apply(List<GraphEdge> collected, Set<String> primaryKeys, Set<String> qualifiedKeys) {
        // interfaceMethodKey -> implementation method keys
        Map<String, List<String>> implsByInterface = new LinkedHashMap<>();
        for (GraphEdge edge : collected) {
            if (edge.type() == EdgeType.IMPLEMENTS) {
                implsByInterface.computeIfAbsent(edge.to(), key -> new ArrayList<>()).add(edge.from());
            }
        }
        if (implsByInterface.isEmpty()) {
            return;
        }

        for (GraphEdge call : collected) {
            if (call.type() != EdgeType.CALLS) {
                continue;
            }
            List<String> impls = implsByInterface.get(call.to());
            if (impls == null || impls.isEmpty()) {
                continue; // the call did not land on an implemented interface method
            }

            List<String> selected = select(impls, primaryKeys, qualifiedKeys);
            Confidence confidence =
                    selected.size() == 1 ? Confidence.SINGLE_IMPL : Confidence.AMBIGUOUS;

            for (String impl : selected) {
                // Every call site of the interface call is a call site of the
                // dispatch, so the sites carry over rather than being invented.
                for (CallSite site : call.callSites()) {
                    edges.add(call.from(), impl, EdgeType.CALLS, true, confidence, site);
                }
            }
        }
    }

    /**
     * Narrows candidates by selector, never by mere presence of a stereotype.
     *
     * <p>{@code @Primary} wins outright — that is exactly what it means. A
     * {@code @Qualifier} on the implementation is a weaker signal (the real match
     * happens at the injection site, which v1 does not model), so it only narrows
     * when it picks out a single candidate. Otherwise every candidate stands.
     */
    private static List<String> select(
            List<String> impls, Set<String> primaryKeys, Set<String> qualifiedKeys) {
        if (impls.size() == 1) {
            return impls;
        }
        List<String> primary = impls.stream().filter(primaryKeys::contains).toList();
        if (primary.size() == 1) {
            return primary;
        }
        List<String> qualified = impls.stream().filter(qualifiedKeys::contains).toList();
        if (qualified.size() == 1) {
            return qualified;
        }
        // Several, with nothing to choose between them — including the hand-wired
        // case with no annotations at all. Never guess, never drop.
        return impls;
    }
}
