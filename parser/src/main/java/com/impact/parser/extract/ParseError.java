package com.impact.parser.extract;

/**
 * A file that could not be parsed.
 *
 * <p>Surfaced in {@code diagnostics.parseErrors} (section 8) rather than swallowed.
 * A file that silently vanishes takes its functions with it, and every method in
 * it then appears to have no callers — the failure mode section 13 exists to
 * prevent. The rest of the graph is still built.
 */
public record ParseError(String filePath, String message) {}
