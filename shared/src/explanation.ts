/**
 * The LLM output contract — ARCHITECTURE.md §11.5.
 *
 * Cross-package: the worker generates it, the API serves it, the web app renders
 * it. Lives here so all three agree on the shape.
 *
 * The sections map 1:1 onto context-object fields on purpose. That mapping is a
 * structural mitigation for the validator's known gap (§11.4): it catches
 * invented symbols and numbers, but not a wrong *relationship* between two real
 * ones — so each claim is given exactly one place it can legitimately live.
 */

export interface ExplanationSections {
  /** Sourced from `changedMethod` only. */
  whatChanged: string;
  /** Sourced from `affectedBy` only. */
  whoIsAffected: string;
  /** Sourced from `affectedBy` + `nowDependsOn` + `quality`. */
  whatToCheck: string;
}

/** A single validator finding: a token in the prose absent from the allowlist. */
export interface ValidationViolation {
  /** Which allowlist the token failed against. */
  kind: 'symbol' | 'number';
  /** The offending token, logged so the rejection rate is diagnosable. */
  token: string;
  section: keyof ExplanationSections;
}

export interface ValidationResult {
  passed: boolean;
  /** 1 = passed first time; 2 = passed after the single repair attempt. */
  attempts: number;
  violations: ValidationViolation[];
}

export interface LLMUsage {
  inputTokens: number;
  outputTokens: number;
}

/**
 * `explanations` document (ARCHITECTURE §7). Unique on
 * `{contextHash, promptVersion, model}` — that tuple is the cache key, so an
 * identical analysis never pays for a second generation, and editing the prompt
 * invalidates deliberately.
 */
export interface ExplanationDoc {
  _id: string;
  /** sha256 of the canonical JSON of the ContextObject (see context.ts). */
  contextHash: string;
  promptVersion: string;
  model: string;
  sections: ExplanationSections;
  /** The raw provider response, kept for debugging and the eval corpus. */
  raw: string;
  validation: ValidationResult;
  usage: LLMUsage;
  /**
   * True when both generation attempts failed validation and the sections above
   * are the deterministic template fallback rather than model output (§11.3).
   */
  degraded: boolean;
  createdAt: Date;
}
