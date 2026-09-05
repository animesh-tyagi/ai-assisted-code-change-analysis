/**
 * `GeminiProvider` — the v1 `LLMProvider` (ARCHITECTURE §11.2). Everything
 * Gemini-specific (the SDK, `responseSchema`, `usageMetadata` field names) lives
 * in this one file; nothing of it leaks past `provider.ts`'s interface.
 *
 * Split into pure request-building / response-parsing functions and a thin I/O
 * wrapper around the SDK call, so the request shape and response mapping are
 * unit-testable without a network call (see `geminiProvider.test.ts`) — only
 * the wrapper itself needs a live API key, exercised by `cli.ts` instead.
 */

import { GoogleGenAI, Type, type GenerateContentConfig, type Schema } from '@google/genai';

import type { ContextObject, ExplanationSections, LLMUsage, ValidationViolation } from '@impact/shared';

import { buildPrompt } from './prompt.js';
import type { LLMGenerateResult, LLMProvider } from './provider.js';

/** The fixed §11.5 output sections, and nothing else — the load-bearing setting (§11.2). */
export const RESPONSE_SCHEMA: Schema = {
  type: Type.OBJECT,
  properties: {
    whatChanged: { type: Type.STRING },
    whoIsAffected: { type: Type.STRING },
    whatToCheck: { type: Type.STRING },
  },
  required: ['whatChanged', 'whoIsAffected', 'whatToCheck'],
};

const GENERATE_CONFIG: GenerateContentConfig = {
  responseMimeType: 'application/json',
  responseSchema: RESPONSE_SCHEMA,
  maxOutputTokens: 4000,
  // thinkingConfig left unset (§11.2): this is bounded rewriting of a supplied
  // structure, not open-ended reasoning.
};

export interface GenerateContentRequest {
  model: string;
  contents: string;
  config: GenerateContentConfig;
}

export function buildGenerateContentRequest(
  model: string,
  contextObject: ContextObject,
  promptVersion: string,
  repair?: { violations: readonly ValidationViolation[] },
): GenerateContentRequest {
  return {
    model,
    contents: buildPrompt(contextObject, promptVersion, repair),
    config: GENERATE_CONFIG,
  };
}

/** The slice of `GenerateContentResponse` this module reads — real SDK responses satisfy this structurally. */
export interface GenerateContentResponseLike {
  readonly text: string | undefined;
  usageMetadata?: {
    promptTokenCount?: number;
    candidatesTokenCount?: number;
  };
}

export function parseGenerateContentResponse(
  response: GenerateContentResponseLike,
): LLMGenerateResult {
  const raw = response.text;
  if (raw === undefined) {
    throw new Error('GeminiProvider: response had no text part');
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(
      `GeminiProvider: response was not valid JSON: ${err instanceof Error ? err.message : String(err)}`,
      { cause: err },
    );
  }

  const sections = asExplanationSections(parsed);
  const usage: LLMUsage = {
    inputTokens: response.usageMetadata?.promptTokenCount ?? 0,
    outputTokens: response.usageMetadata?.candidatesTokenCount ?? 0,
  };

  return { sections, raw, usage };
}

function asExplanationSections(value: unknown): ExplanationSections {
  if (typeof value !== 'object' || value === null) {
    throw new Error('GeminiProvider: response JSON was not an object');
  }
  const obj = value as Record<string, unknown>;
  for (const key of ['whatChanged', 'whoIsAffected', 'whatToCheck'] as const) {
    if (typeof obj[key] !== 'string') {
      throw new Error(`GeminiProvider: response JSON missing string field "${key}"`);
    }
  }
  return {
    whatChanged: obj.whatChanged as string,
    whoIsAffected: obj.whoIsAffected as string,
    whatToCheck: obj.whatToCheck as string,
  };
}

export interface GeminiProviderConfig {
  apiKey: string;
  model: string;
}

export class GeminiProvider implements LLMProvider {
  readonly model: string;
  private readonly client: GoogleGenAI;

  constructor(config: GeminiProviderConfig) {
    if (config.apiKey === '') {
      throw new Error('GeminiProvider: GEMINI_API_KEY is empty');
    }
    this.model = config.model;
    this.client = new GoogleGenAI({ apiKey: config.apiKey });
  }

  async generate(contextObject: ContextObject, promptVersion: string): Promise<LLMGenerateResult> {
    const request = buildGenerateContentRequest(this.model, contextObject, promptVersion);
    const response = await this.client.models.generateContent(request);
    return parseGenerateContentResponse(response);
  }

  async repair(
    contextObject: ContextObject,
    promptVersion: string,
    violations: readonly ValidationViolation[],
  ): Promise<LLMGenerateResult> {
    const request = buildGenerateContentRequest(this.model, contextObject, promptVersion, {
      violations,
    });
    const response = await this.client.models.generateContent(request);
    return parseGenerateContentResponse(response);
  }
}
