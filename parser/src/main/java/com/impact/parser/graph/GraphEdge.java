package com.impact.parser.graph;

import com.fasterxml.jackson.annotation.JsonIgnore;
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

    /**
     * {@code @JsonIgnore} is load-bearing, not decorative. Jackson's default bean
     * introspection treats any no-arg {@code isXxx()} method on a record as an
     * extra property, so without this annotation every edge silently grew a 9th
     * wire field — {@code "unresolved": &lt;bool&gt;} — never declared as a record
     * component, never mentioned in the Javadoc above, and never in
     * ARCHITECTURE.md's §8 example. Confirmed present in the golden snapshots
     * before this was added (a pre-merge review caught it). §8's purity promise —
     * "everything in it was decided during extraction... a pure record with no
     * behaviour" ({@link com.impact.parser.api.ParseResponseMapper}) — is only as
     * true as every method on every serialized type; a convenience accessor is
     * exactly the kind of thing that slips past that promise silently.
     */
    @JsonIgnore
    public boolean isUnresolved() {
        return type == EdgeType.UNRESOLVED;
    }
}
