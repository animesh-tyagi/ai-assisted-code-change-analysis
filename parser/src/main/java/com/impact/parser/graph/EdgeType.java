package com.impact.parser.graph;

import com.fasterxml.jackson.annotation.JsonValue;

/**
 * Edge types (ARCHITECTURE.md section 6.3).
 *
 * <p>Direction convention: an edge points <strong>from the dependent to the
 * depended-upon</strong> — {@code from} needs {@code to}. Reverse traversal
 * ("what is affected by a change to X") therefore matches {@code to = X} and
 * collects {@code from}. Getting this backwards would invert the entire product.
 *
 * <p>Wire names match the TypeScript union in {@code shared/src/graph.ts}.
 */
public enum EdgeType {
    CALLS("calls"),
    IMPLEMENTS("implements"),
    OVERRIDES("overrides"),
    HANDLES("handles"),
    TRIGGERS("triggers"),
    QUERIES("queries"),
    MAPS_TO("maps_to"),
    UNRESOLVED("unresolved");

    private final String wireName;

    EdgeType(String wireName) {
        this.wireName = wireName;
    }

    @JsonValue
    public String wireName() {
        return wireName;
    }
}
