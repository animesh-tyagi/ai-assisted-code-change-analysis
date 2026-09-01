package com.impact.parser.extract;

import com.impact.parser.graph.GraphEdge;
import com.impact.parser.graph.ParsedFunction;
import java.util.List;

/**
 * The graph extracted from one workspace, plus enough diagnostics to say whether
 * the run should be trusted (ARCHITECTURE.md section 8).
 *
 * @param functions nodes, sorted by key so output is byte-identical across runs
 * @param edges edges, sorted and deduplicated by {@code (from, to, type)}
 * @param parseErrors files that failed to parse; never silently dropped
 * @param unresolvedParamTypes parameter types that fell back to import-based
 *     qualification instead of real resolution — the measured cost of D2
 * @param externalCalls calls that resolved cleanly to a JDK or third-party
 *     method. Deliberately <em>not</em> edges: D2 states the impact surface is
 *     entirely intra-repo, and nobody can act on a change to
 *     {@code java.util.HashMap}. Counted so the omission stays visible and is
 *     never confused with a resolution failure.
 */
public record ExtractionResult(
        List<ParsedFunction> functions,
        List<GraphEdge> edges,
        List<ParseError> parseErrors,
        int filesParsed,
        int unresolvedParamTypes,
        int externalCalls,
        List<String> ambiguousOverloads) {

    /** Share of parameter types that could not be resolved, across all functions. */
    public double unresolvedParamRate() {
        int total = functions.stream().mapToInt(f -> f.paramTypes().size()).sum();
        return total == 0 ? 0.0 : (double) unresolvedParamTypes / total;
    }

    public long unresolvedEdges() {
        return edges.stream().filter(GraphEdge::isUnresolved).count();
    }

    /**
     * {@code unresolvedEdges / totalEdges} — the health metric of section 6.5.
     *
     * <p>A spike means the analysis quietly got worse. It counts only calls we
     * <em>failed</em> to bind, not calls we deliberately left out of the graph as
     * external, so it stays a measure of blindness rather than of scope.
     */
    public double unresolvedRate() {
        return edges.isEmpty() ? 0.0 : (double) unresolvedEdges() / edges.size();
    }
}
