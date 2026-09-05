import type { ContextObject } from '@impact/shared';
import { describe, expect, it } from 'vitest';

import {
  RESPONSE_SCHEMA,
  buildGenerateContentRequest,
  parseGenerateContentResponse,
  type GenerateContentResponseLike,
} from './geminiProvider.js';
import { PROMPT_VERSION } from './prompt.js';

function context(): ContextObject {
  return {
    schemaVersion: 1,
    repo: { owner: 'acme', name: 'billing', prNumber: 412 },
    changedMethod: {
      key: 'fn:com.acme.service.FooService#findById(java.lang.Long)',
      displayName: 'FooService.findById(Long)',
      changeKind: 'modified',
      filePath: 'src/main/java/com/acme/service/FooService.java',
      signatureDiff: {
        base: 'void findById(Long id)',
        head: 'void findById(Long id)',
        returnTypeChanged: false,
        paramsChanged: false,
        throwsAdded: [],
        visibilityChanged: false,
      },
      sourceDiff: '@@ -1 +1 @@',
    },
    affectedBy: {
      directCallers: [],
      directCallerTotal: 0,
      directCallersTruncated: false,
      reachableSurfaces: { entrypoints: [], data: [] },
      traversal: { maxDepth: 5, depthCapHit: false, nodesVisited: 1 },
    },
    nowDependsOn: { callees: [] },
    changeHistory: { commits: [], truncatedAtRename: false },
    quality: { unresolvedRate: 0, ambiguousEdgesOnPath: 0, parseErrorsInTouchedFiles: 0 },
  };
}

describe('buildGenerateContentRequest', () => {
  it('carries the model, the responseSchema fixed to the three §11.5 sections, and the serialized context object', () => {
    const request = buildGenerateContentRequest('gemini-3.6-flash', context(), PROMPT_VERSION);
    expect(request.model).toBe('gemini-3.6-flash');
    expect(request.config.responseMimeType).toBe('application/json');
    expect(request.config.responseSchema).toBe(RESPONSE_SCHEMA);
    expect(RESPONSE_SCHEMA.required).toEqual(['whatChanged', 'whoIsAffected', 'whatToCheck']);
    expect(request.contents).toContain('FooService.findById(Long)');
    expect(request.contents).toContain(`prompt version: ${PROMPT_VERSION}`);
  });

  it('appends the operator repair instruction with the violating tokens when repairing', () => {
    const request = buildGenerateContentRequest('gemini-3.6-flash', context(), PROMPT_VERSION, {
      violations: [{ kind: 'symbol', token: 'com.acme.FakeService', section: 'whatChanged' }],
    });
    expect(request.contents).toContain('com.acme.FakeService');
    expect(request.contents.toLowerCase()).toContain('rewrite');
  });
});

describe('parseGenerateContentResponse', () => {
  it('parses a well-formed JSON response into sections and usage', () => {
    const response: GenerateContentResponseLike = {
      text: JSON.stringify({
        whatChanged: 'a',
        whoIsAffected: 'b',
        whatToCheck: 'c',
      }),
      usageMetadata: { promptTokenCount: 100, candidatesTokenCount: 50 },
    };
    const result = parseGenerateContentResponse(response);
    expect(result.sections).toEqual({ whatChanged: 'a', whoIsAffected: 'b', whatToCheck: 'c' });
    expect(result.usage).toEqual({ inputTokens: 100, outputTokens: 50 });
  });

  it('defaults usage to zero when usageMetadata is absent', () => {
    const response: GenerateContentResponseLike = {
      text: JSON.stringify({ whatChanged: 'a', whoIsAffected: 'b', whatToCheck: 'c' }),
    };
    expect(parseGenerateContentResponse(response).usage).toEqual({ inputTokens: 0, outputTokens: 0 });
  });

  it('throws on a missing text part rather than silently returning empty sections', () => {
    expect(() => parseGenerateContentResponse({ text: undefined })).toThrow(/no text part/);
  });

  it('throws on malformed JSON', () => {
    expect(() => parseGenerateContentResponse({ text: '{not json' })).toThrow(/not valid JSON/);
  });

  it('throws when a required section is missing', () => {
    expect(() =>
      parseGenerateContentResponse({ text: JSON.stringify({ whatChanged: 'a' }) }),
    ).toThrow(/missing string field/);
  });
});
