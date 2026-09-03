package com.impact.parser.extract;

import com.impact.parser.graph.GraphEdge;
import com.impact.parser.graph.UnresolvedReason;
import com.impact.parser.graph.ParsedFunction;
import com.impact.parser.graph.Surface;
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
 * @param failedDeclarations declarations whose own call-site/inheritance
 *     extraction threw, isolated so one unresolvable symbol costs one
 *     declaration's edges, never a whole file's. Should be zero; non-zero
 *     means a real bug, not an expected resolution gap.
 * @param guardedFailures call sites where resolution succeeded but recording
 *     the resulting edge then threw. Should be zero; non-zero means a bug in
 *     edge construction or the collector, not in symbol resolution.
 * @param targetsMissingFromIndex in-extraction-set call targets whose key had
 *     to be recomputed instead of read from the position index built during
 *     extraction. Zero in full mode; can be non-zero in subset mode, where a
 *     call may target a file outside the indexed subset (a known, disclosed
 *     gap — see DECISIONS.md).
 */
public record ExtractionResult(
        List<ParsedFunction> functions,
        List<GraphEdge> edges,
        List<Surface> surfaces,
        List<ParseError> parseErrors,
        int filesParsed,
        int unresolvedParamTypes,
        int externalCalls,
        List<String> ambiguousOverloads,
        int failedDeclarations,
        int guardedFailures,
        int targetsMissingFromIndex) {

    /** Share of parameter types that could not be resolved, across all functions. */
    public double unresolvedParamRate() {
        int total = functions.stream().mapToInt(f -> f.paramTypes().size()).sum();
        return total == 0 ? 0.0 : (double) unresolvedParamTypes / total;
    }

    public long unresolvedEdges() {
        return edges.stream().filter(GraphEdge::isUnresolved).count();
    }

    /**
     * {@code unresolvedEdges / totalEdges} (section 6.5).
     *
     * <p>Diagnostic, not an alerting metric: it is dominated by
     * {@code external_type}, which is expected under source+JDK resolution.
     * petclinic-rest measures above 50% while its non-external rate is zero.
     * Read it as the D2 upgrade trigger.
     */
    public double unresolvedRate() {
        return edges.isEmpty() ? 0.0 : (double) unresolvedEdges() / edges.size();
    }

    /** Unresolved edges that are <em>not</em> merely external types. */
    public long nonExternalUnresolvedEdges() {
        return edges.stream()
                .filter(GraphEdge::isUnresolved)
                .filter(e -> e.reason() != UnresolvedReason.EXTERNAL_TYPE)
                .count();
    }

    /**
     * The health signal that alerts (section 6.5).
     *
     * <p>A rise means genuine blindness — an in-repo call we failed to bind, an
     * overload we could not disambiguate, a file that would not parse. Zero in
     * both validation repos today.
     */
    public double nonExternalUnresolvedRate() {
        return edges.isEmpty() ? 0.0 : (double) nonExternalUnresolvedEdges() / edges.size();
    }
}
