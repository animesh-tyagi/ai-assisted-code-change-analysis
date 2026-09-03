package com.impact.parser.graph;

import java.util.ArrayList;
import java.util.Comparator;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.TreeSet;

/**
 * Accumulates edges, collapsing repeats.
 *
 * <p>Calling the same method three times from one caller is one edge with three
 * call sites, not three edges (ARCHITECTURE.md section 7). Two reasons that
 * matters: the unique index on {@code {graphVersionId, from, to, type}} would
 * reject the duplicates, and reverse traversal would otherwise report the same
 * caller three times, inflating {@code directCallerTotal} — a number the LLM is
 * handed as fact and forbidden from recomputing.
 *
 * <p>Output is sorted so the parse response stays byte-identical across runs.
 */
public final class EdgeCollector {

    private final Map<GraphEdge.Key, Accumulator> edges = new LinkedHashMap<>();

    private static final class Accumulator {
        private final boolean inferred;
        private final Confidence confidence;
        private final UnresolvedReason reason;
        private final List<String> candidates;
        private final TreeSet<CallSite> callSites = new TreeSet<>();

        Accumulator(boolean inferred, Confidence confidence, UnresolvedReason reason, List<String> candidates) {
            this.inferred = inferred;
            this.confidence = confidence;
            this.reason = reason;
            this.candidates = candidates;
        }
    }

    public void add(
            String from,
            String to,
            EdgeType type,
            boolean inferred,
            Confidence confidence,
            CallSite callSite) {
        add(from, to, type, inferred, confidence, callSite, null, List.of());
    }

    public void add(
            String from,
            String to,
            EdgeType type,
            boolean inferred,
            Confidence confidence,
            CallSite callSite,
            UnresolvedReason reason,
            List<String> candidates) {
        GraphEdge.Key key = new GraphEdge.Key(from, to, type);
        Accumulator accumulator =
                edges.computeIfAbsent(
                        key, k -> new Accumulator(inferred, confidence, reason, List.copyOf(candidates)));
        if (callSite != null) {
            accumulator.callSites.add(callSite);
        }
    }

    /** Every collected edge, sorted for determinism. */
    public List<GraphEdge> toList() {
        List<GraphEdge> result = new ArrayList<>(edges.size());
        edges.forEach(
                (key, accumulator) ->
                        result.add(
                                new GraphEdge(
                                        key.from(),
                                        key.to(),
                                        key.type(),
                                        accumulator.inferred,
                                        accumulator.confidence,
                                        List.copyOf(accumulator.callSites),
                                        accumulator.reason,
                                        accumulator.candidates)));
        result.sort(
                Comparator.comparing(GraphEdge::from)
                        .thenComparing(GraphEdge::to)
                        .thenComparing(e -> e.type().wireName()));
        return List.copyOf(result);
    }

    public int size() {
        return edges.size();
    }
}
