/**
 * The top-level orchestration for ARCHITECTURE §11: cache → generate → validate
 * → one repair attempt → degrade-to-template, then persist. This is the one
 * function the rest of the worker (and, later, the analyze flow of §5.2 step 7)
 * calls; everything above it in this directory is a building block.
 */

import type { ContextObject, ExplanationDoc, ValidationViolation } from '@impact/shared';

import { buildAllowlists } from './allowlist.js';
import { contextHash } from './contextHash.js';
import type { ExplanationStore } from './explanationStore.js';
import type { LLMProvider } from './provider.js';
import { buildTemplateSections } from './template.js';
import { validateOutput } from './validator.js';

export interface GetOrGenerateExplanationInput {
  contextObject: ContextObject;
  promptVersion: string;
}

export interface GetOrGenerateExplanationResult {
  doc: ExplanationDoc;
  /** True when this call made zero provider calls (§11.2 D-cache hit). */
  fromCache: boolean;
}

export async function getOrGenerateExplanation(
  store: ExplanationStore,
  provider: LLMProvider,
  input: GetOrGenerateExplanationInput,
): Promise<GetOrGenerateExplanationResult> {
  const hash = contextHash(input.contextObject);
  const cacheKey = {
    contextHash: hash,
    promptVersion: input.promptVersion,
    model: provider.model,
  };

  const cached = await store.find(cacheKey);
  if (cached !== null) {
    return { doc: cached, fromCache: true };
  }

  const allowlists = buildAllowlists(input.contextObject);

  let result = await provider.generate(input.contextObject, input.promptVersion);
  let violations = validateOutput(result.sections, allowlists);
  let attempts = 1;

  if (violations.length > 0) {
    logViolations('generate', violations);
    result = await provider.repair(input.contextObject, input.promptVersion, violations);
    violations = validateOutput(result.sections, allowlists);
    attempts = 2;
  }

  const degraded = violations.length > 0;
  let sections = result.sections;
  let raw = result.raw;
  if (degraded) {
    logViolations('repair', violations);
    console.error(
      `[llm] both attempts failed validation (contextHash ${hash}) — falling back to the deterministic template, degraded: true`,
    );
    sections = buildTemplateSections(input.contextObject);
    raw = '';
  }

  const doc = await store.save({
    contextHash: hash,
    promptVersion: input.promptVersion,
    model: provider.model,
    sections,
    raw,
    validation: { passed: !degraded, attempts, violations },
    usage: result.usage,
    degraded,
    createdAt: new Date(),
  });

  return { doc, fromCache: false };
}

/** The validator-rejection metric, in the only reporting channel this project has pre-M6 (console). */
function logViolations(stage: 'generate' | 'repair', violations: readonly ValidationViolation[]): void {
  for (const violation of violations) {
    console.warn(
      `[llm] validator rejected ${stage} attempt: ${violation.kind} "${violation.token}" in ${violation.section}`,
    );
  }
}
