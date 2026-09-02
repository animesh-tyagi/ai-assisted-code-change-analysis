package com.impact.parser.api;

import com.impact.parser.graph.GraphEdge;
import com.impact.parser.graph.ParsedFunction;
import com.impact.parser.graph.Surface;
import java.util.List;

/**
 * The parse response of ARCHITECTURE.md §8.
 *
 * <p>This is the wire contract between the parser service and the Node worker. It
 * is deliberately a plain record with no behaviour: everything in it was decided
 * during extraction, and serialising must not be a place where anything is
 * computed, reordered, or defaulted.
 *
 * <p>The response is a <strong>pure function</strong> of (workspace contents,
 * mode, files, options). That is not an aspiration — graph versions are keyed by
 * commit SHA and must be reproducible, so identical inputs have to serialise to
 * identical bytes. Every list here arrives already sorted from extraction.
 *
 * <p>Used by both the CLI (phase 6) and {@code POST /v1/parse} (phase 7), so the
 * two cannot drift.
 */
public record ParseResponse(
        String requestId,
        String sha,
        String mode,
        List<String> sourceRoots,
        List<ParsedFunction> functions,
        List<Surface> surfaces,
        List<GraphEdge> edges,
        ParseDiagnostics diagnostics) {}
