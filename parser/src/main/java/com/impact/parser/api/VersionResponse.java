package com.impact.parser.api;

/** {@code GET /v1/version} response body (ARCHITECTURE.md §8). */
public record VersionResponse(String parserVersion, String ruleVersion, String javaParserVersion) {

    public static VersionResponse from(ParserProperties properties) {
        return new VersionResponse(
                properties.version(), properties.ruleVersion(), properties.javaparserVersion());
    }
}
