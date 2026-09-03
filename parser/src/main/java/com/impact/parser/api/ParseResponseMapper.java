package com.impact.parser.api;

import com.impact.parser.extract.ExtractionResult;
import com.impact.parser.workspace.WorkspaceLayout;

/**
 * Shapes an {@link ExtractionResult} into the §8 wire response.
 *
 * <p>Pure copying, on purpose. If anything were computed here, the CLI and the
 * HTTP endpoint could disagree, and §8's purity guarantee would depend on which
 * entry point you came through.
 */
public final class ParseResponseMapper {

    private ParseResponseMapper() {}

    public static ParseResponse toResponse(
            String requestId,
            String sha,
            String mode,
            WorkspaceLayout layout,
            ExtractionResult result,
            long durationMs) {
        ParseDiagnostics diagnostics =
                new ParseDiagnostics(
                        durationMs,
                        result.filesParsed(),
                        result.parseErrors(),
                        result.edges().size(),
                        result.unresolvedEdges(),
                        result.unresolvedRate(),
                        result.nonExternalUnresolvedRate(),
                        result.externalCalls(),
                        result.unresolvedParamTypes(),
                        result.ambiguousOverloads(),
                        result.failedDeclarations(),
                        result.guardedFailures(),
                        result.targetsMissingFromIndex());

        return new ParseResponse(
                requestId,
                sha,
                mode,
                // Extraction roots, not solver roots: this reports what became
                // nodes. Generated sources are read but never extracted, so
                // listing them here would misdescribe the graph.
                layout.relativeExtractionRoots(),
                result.functions(),
                result.surfaces(),
                result.edges(),
                diagnostics);
    }
}
