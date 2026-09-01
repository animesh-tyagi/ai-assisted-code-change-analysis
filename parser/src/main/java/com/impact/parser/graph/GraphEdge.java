package com.impact.parser.graph;

import java.util.List;

/**
 * One edge in the graph (ARCHITECTURE.md section 6.3, stored per section 7).
 *
 * <p>Edges live in their own collection and are never embedded as caller/callee
 * arrays on nodes (CLAUDE.md rule 3).
 *
 * @param from the dependent node key
 * @param to the depended-upon node key
 * @param inferred false when the edge is written literally in the source, true
 *     when a Spring rule derived it. The UI and the explanation need to say
 *     <em>how</em> we know a connection exists, not just that it does.
 * @param callSites every place this edge was observed, sorted and deduplicated.
 *     Repeated call sites collapse into this list rather than producing duplicate
 *     edge documents — which is what keeps section 7's unique index valid and
 *     stops reverse traversal counting one caller twice.
 * @param reason set only on {@link EdgeType#UNRESOLVED} edges
 * @param candidates for {@link UnresolvedReason#AMBIGUOUS_OVERLOAD}, the overloads
 *     that could not be told apart (section 6.6)
 */
public record GraphEdge(
        String from,
        String to,
        EdgeType type,
        boolean inferred,
        Confidence confidence,
        List<CallSite> callSites,
        UnresolvedReason reason,
        List<String> candidates) {

    /** Identity of an edge for deduplication: everything except where it was seen. */
    public record Key(String from, String to, EdgeType type) {}

    public Key key() {
        return new Key(from, to, type);
    }

    public boolean isUnresolved() {
        return type == EdgeType.UNRESOLVED;
    }
}
