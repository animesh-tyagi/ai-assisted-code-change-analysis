package com.impact.parser.graph;

import com.fasterxml.jackson.annotation.JsonValue;

/**
 * How much an edge can be trusted (ARCHITECTURE.md section 6.3).
 *
 * <p>Carried on every edge so the traversal and the explanation can hedge rather
 * than assert. An over-approximated edge that is honestly labelled is useful; an
 * over-approximated edge that looks certain is a lie.
 */
public enum Confidence {
    /** Written literally in the source and fully resolved. */
    EXACT("exact"),
    /** Inferred because exactly one candidate existed. */
    SINGLE_IMPL("single_impl"),
    /** Several candidates and no selector; edges emitted to all of them. */
    AMBIGUOUS("ambiguous"),
    /** Extracted textually, e.g. names inside an {@code @Query} string. */
    REGEX("regex");

    private final String wireName;

    Confidence(String wireName) {
        this.wireName = wireName;
    }

    @JsonValue
    public String wireName() {
        return wireName;
    }
}
