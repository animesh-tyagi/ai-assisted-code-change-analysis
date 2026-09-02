package com.impact.parser.graph;

import com.fasterxml.jackson.annotation.JsonValue;

/** Non-method nodes: entry points, data, and the unresolved sink (§6.2). */
public enum SurfaceKind {
    HTTP_ROUTE("http_route"),
    SCHEDULED_JOB("scheduled_job"),
    MESSAGE_LISTENER("message_listener"),
    ENTITY("entity"),
    TABLE("table"),
    UNRESOLVED("unresolved");

    private final String wireName;

    SurfaceKind(String wireName) {
        this.wireName = wireName;
    }

    @JsonValue
    public String wireName() {
        return wireName;
    }
}
