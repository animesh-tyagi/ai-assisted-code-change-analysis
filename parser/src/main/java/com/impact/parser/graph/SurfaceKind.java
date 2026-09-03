package com.impact.parser.graph;

import com.fasterxml.jackson.annotation.JsonValue;

/**
 * Non-method nodes: entry points and data (§6.2).
 *
 * <p>No {@code UNRESOLVED} member: an unbindable call site becomes a {@link
 * GraphEdge} to an {@code unresolved:*} node key, never a {@link Surface}
 * record — see {@link UnresolvedReason} and §6.5. A prior version of this enum
 * carried an {@code UNRESOLVED} value that no code ever constructed; removed
 * rather than left on the wire contract describing a shape the parser never
 * emits.
 */
public enum SurfaceKind {
    HTTP_ROUTE("http_route"),
    SCHEDULED_JOB("scheduled_job"),
    MESSAGE_LISTENER("message_listener"),
    ENTITY("entity"),
    TABLE("table");

    private final String wireName;

    SurfaceKind(String wireName) {
        this.wireName = wireName;
    }

    @JsonValue
    public String wireName() {
        return wireName;
    }
}
