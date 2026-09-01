package com.impact.parser.graph;

import java.util.Map;

/**
 * A Java annotation as read off the raw AST.
 *
 * <p>Matched by <em>name</em>, never by resolved type (DECISIONS D2). That is what
 * lets source+JDK resolution carry the Spring rules: {@code @RestController} is
 * recognised without Spring's own jars ever being on the classpath.
 *
 * @param name simple annotation name as written, e.g. {@code RequestMapping}
 * @param values member values, keyed by member name. A single-member annotation
 *     such as {@code @RequestMapping("/api")} uses the key {@code value}. String
 *     literals are stored unquoted so phase 5 can build route paths directly;
 *     any other expression is stored as its source text. Sorted by key so the
 *     serialised output is deterministic.
 */
public record AnnotationRef(String name, Map<String, String> values) {

    public boolean isNamed(String candidate) {
        return name.equals(candidate);
    }

    /** The {@code value} member, which is what single-member annotations carry. */
    public String value() {
        return values.get("value");
    }
}
