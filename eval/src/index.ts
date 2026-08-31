/**
 * `@impact/eval` — the eval harness (BUILD_PLAN Step 8).
 *
 * The differentiator: it answers "why is this better than pasting the diff into
 * ChatGPT?" with a number. Two conditions — the graph-grounded context object
 * versus a diff-only-to-LLM baseline — scored on a rubric of: caught the affected
 * callers? flagged the breaking signature change? hallucinated?
 *
 * M1 scaffold only. The corpus and runner land in M8.
 */

import { CONTEXT_SCHEMA_VERSION, type ContextObject } from '@impact/shared';

/**
 * One scored case. The context object *is* the ground truth — `directCallers`,
 * `reachableSurfaces`, and the `signatureCompatible` flags are what the rubric
 * scores, so this type and ARCHITECTURE §10 change together.
 */
export interface EvalCase {
  prNumber: number;
  /** Hand-written "what a reviewer needed to know" for this PR. */
  groundTruth: string;
  context: ContextObject | null;
}

function main(): void {
  console.log(
    `[eval] scaffold up; context schema v${String(CONTEXT_SCHEMA_VERSION)}. ` +
      'Corpus and runner land in M8.',
  );
}

main();
