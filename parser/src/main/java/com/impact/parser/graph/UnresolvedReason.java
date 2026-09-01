package com.impact.parser.graph;

import com.fasterxml.jackson.annotation.JsonValue;

/** Why a call site could not be bound (ARCHITECTURE.md section 6.5). */
public enum UnresolvedReason {
    /** The target's type is not on the source+JDK solver — usually a third-party jar. */
    EXTERNAL_TYPE("external_type"),
    /** Several overloads matched and argument types were too weak to choose (section 6.6). */
    AMBIGUOUS_OVERLOAD("ambiguous_overload"),
    /** The enclosing file did not parse. */
    PARSE_ERROR("parse_error"),
    /** The target's source is absent from the workspace. */
    MISSING_SOURCE("missing_source");

    private final String wireName;

    UnresolvedReason(String wireName) {
        this.wireName = wireName;
    }

    @JsonValue
    public String wireName() {
        return wireName;
    }
}
