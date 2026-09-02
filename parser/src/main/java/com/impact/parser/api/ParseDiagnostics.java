package com.impact.parser.api;

import com.impact.parser.extract.ParseError;
import java.util.List;

/**
 * Whether this run should be trusted (ARCHITECTURE.md §8, §6.5).
 *
 * <p>Diagnostics are not optional colour. The graph is an over-approximation built
 * under source+JDK resolution, and these fields are how a consumer tells a healthy
 * run from a quietly degraded one.
 *
 * @param parseErrors files that failed; never silently dropped, because a missing
 *     file takes its functions with it and they then look uncalled
 * @param unresolvedRate all unresolved edges over total. Diagnostic only — it is
 *     dominated by {@code external_type}, which is expected under D2. This is the
 *     D2 upgrade trigger, not an alarm.
 * @param nonExternalUnresolvedRate the same, excluding {@code external_type}.
 *     <strong>This is the health signal that alerts</strong>: a rise means real
 *     blindness — an in-repo call we could not bind, an ambiguous overload, a
 *     parse failure. 0.0% on both validation repos.
 * @param externalCalls calls that resolved but whose target is outside the
 *     extraction set — the JDK, jars, and generated sources the solver reads but
 *     never extracts. Not edges; counted so the omission stays visible and is
 *     never confused with a resolution failure.
 * @param unresolvedParamTypes parameter types that fell back to import-based
 *     naming — the measured cost of D2
 */
public record ParseDiagnostics(
        long durationMs,
        int filesParsed,
        List<ParseError> parseErrors,
        int totalEdges,
        long unresolvedEdges,
        double unresolvedRate,
        double nonExternalUnresolvedRate,
        int externalCalls,
        int unresolvedParamTypes,
        List<String> ambiguousOverloads) {}
