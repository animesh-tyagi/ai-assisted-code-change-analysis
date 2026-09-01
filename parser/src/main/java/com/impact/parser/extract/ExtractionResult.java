package com.impact.parser.extract;

import com.impact.parser.graph.ParsedFunction;
import java.util.List;

/**
 * Everything phase 3 produces: the function nodes, plus enough diagnostics to
 * tell whether the run should be trusted.
 *
 * @param functions extracted nodes, sorted by key so output is byte-identical
 *     across runs (section 8 purity)
 * @param parseErrors files that failed to parse; never silently dropped
 * @param filesParsed how many files were actually read
 * @param unresolvedParamTypes how many parameter types fell back to import-based
 *     qualification instead of real resolution. This is the honest cost of D2's
 *     source+JDK-only choice, measured rather than assumed.
 */
public record ExtractionResult(
        List<ParsedFunction> functions,
        List<ParseError> parseErrors,
        int filesParsed,
        int unresolvedParamTypes) {

    /** Share of parameter types that could not be resolved, across all functions. */
    public double unresolvedParamRate() {
        int total = functions.stream().mapToInt(f -> f.paramTypes().size()).sum();
        return total == 0 ? 0.0 : (double) unresolvedParamTypes / total;
    }
}
