/**
 * The LLM boundary (ARCHITECTURE §11.2): `generate(contextObject, promptVersion)
 * → sections`, and nothing else crosses it. `GeminiProvider` (`geminiProvider.ts`)
 * is the v1 implementation; no Gemini-specific type or option may leak past this
 * interface — swapping models (M8's cross-provider eval) must stay a config
 * change, mirroring the `TypeSolver` seam (D2).
 *
 * `repair` is kept as its own method rather than an optional parameter on
 * `generate`: §11.3 step 5 treats the repair attempt as a distinct operation
 * ("re-sending the same context object with the violation list appended as an
 * operator instruction"), and every provider must support it the same way.
 * Nothing crosses this method either except the context object and facts about
 * the model's own prior output — never repo access, never a second turn that
 * could fetch more.
 */

import type { ContextObject, ExplanationSections, LLMUsage, ValidationViolation } from '@impact/shared';

export interface LLMGenerateResult {
  sections: ExplanationSections;
  raw: string;
  usage: LLMUsage;
}

export interface LLMProvider {
  readonly model: string;
  generate(contextObject: ContextObject, promptVersion: string): Promise<LLMGenerateResult>;
  repair(
    contextObject: ContextObject,
    promptVersion: string,
    violations: readonly ValidationViolation[],
  ): Promise<LLMGenerateResult>;
}
