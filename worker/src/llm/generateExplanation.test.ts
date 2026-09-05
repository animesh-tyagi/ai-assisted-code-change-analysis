import type { ContextObject, LLMUsage } from '@impact/shared';
import { describe, expect, it, vi, type Mock } from 'vitest';

import { buildTemplateSections } from './template.js';
import { getOrGenerateExplanation } from './generateExplanation.js';
import { InMemoryExplanationStore } from './inMemoryExplanationStore.js';
import type { LLMGenerateResult, LLMProvider } from './provider.js';

const PROMPT_VERSION = 'v1';
const USAGE: LLMUsage = { inputTokens: 10, outputTokens: 5 };

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
      directCallers: [
        {
          key: 'fn:com.acme.web.FooController#get(java.lang.Long)',
          displayName: 'FooController.get(Long)',
          hops: 1,
          callSite: { filePath: 'src/main/java/com/acme/web/FooController.java', line: 28 },
          usage: 'calls this method',
          signatureCompatible: true,
          edgeConfidence: 'exact',
          inferred: false,
        },
      ],
      directCallerTotal: 1,
      directCallersTruncated: false,
      reachableSurfaces: { entrypoints: [], data: [] },
      traversal: { maxDepth: 5, depthCapHit: false, nodesVisited: 2 },
    },
    nowDependsOn: { callees: [] },
    changeHistory: { commits: [], truncatedAtRename: false },
    quality: { unresolvedRate: 0, ambiguousEdgesOnPath: 0, parseErrorsInTouchedFiles: 0 },
  };
}

const CLEAN_RESULT: LLMGenerateResult = {
  sections: {
    whatChanged: 'FooService.findById(Long) was modified.',
    whoIsAffected: 'FooController.get(Long) calls this method.',
    whatToCheck: 'No further concerns from the graph.',
  },
  raw: '{"clean":true}',
  usage: USAGE,
};

const POISONED_RESULT: LLMGenerateResult = {
  sections: {
    whatChanged: 'com.acme.FakeService.doStuff() was also touched.',
    whoIsAffected: 'FooController.get(Long) calls this method.',
    whatToCheck: 'There are 999 callers.',
  },
  raw: '{"poisoned":true}',
  usage: USAGE,
};

interface StubProvider extends LLMProvider {
  generate: Mock;
  repair: Mock;
}

function stubProvider(): StubProvider {
  return {
    model: 'stub-model',
    generate: vi.fn(),
    repair: vi.fn(),
  };
}

describe('getOrGenerateExplanation', () => {
  it('produces sane, validator-passing output on the first attempt', async () => {
    const store = new InMemoryExplanationStore();
    const provider = stubProvider();
    provider.generate.mockResolvedValue(CLEAN_RESULT);

    const { doc, fromCache } = await getOrGenerateExplanation(store, provider, {
      contextObject: context(),
      promptVersion: PROMPT_VERSION,
    });

    expect(fromCache).toBe(false);
    expect(doc.degraded).toBe(false);
    expect(doc.validation).toEqual({ passed: true, attempts: 1, violations: [] });
    expect(doc.sections).toEqual(CLEAN_RESULT.sections);
    expect(provider.generate).toHaveBeenCalledTimes(1);
    expect(provider.repair).not.toHaveBeenCalled();
  });

  it('re-running an identical analysis hits the cache and makes zero further provider calls', async () => {
    const store = new InMemoryExplanationStore();
    const provider = stubProvider();
    provider.generate.mockResolvedValue(CLEAN_RESULT);
    const input = { contextObject: context(), promptVersion: PROMPT_VERSION };

    const first = await getOrGenerateExplanation(store, provider, input);
    const second = await getOrGenerateExplanation(store, provider, input);

    expect(first.fromCache).toBe(false);
    expect(second.fromCache).toBe(true);
    expect(second.doc._id).toBe(first.doc._id);
    expect(second.doc.sections).toEqual(first.doc.sections);
    expect(provider.generate).toHaveBeenCalledTimes(1);
  });

  it('repairs a symbol-injecting first attempt and passes on the repair attempt', async () => {
    const store = new InMemoryExplanationStore();
    const provider = stubProvider();
    provider.generate.mockResolvedValue(POISONED_RESULT);
    provider.repair.mockResolvedValue(CLEAN_RESULT);

    const { doc } = await getOrGenerateExplanation(store, provider, {
      contextObject: context(),
      promptVersion: PROMPT_VERSION,
    });

    expect(doc.degraded).toBe(false);
    expect(doc.validation.passed).toBe(true);
    expect(doc.validation.attempts).toBe(2);
    expect(doc.sections).toEqual(CLEAN_RESULT.sections);
    expect(provider.generate).toHaveBeenCalledTimes(1);
    expect(provider.repair).toHaveBeenCalledTimes(1);

    const [, , violations] = provider.repair.mock.calls[0] as [unknown, unknown, unknown];
    expect(violations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: 'symbol', token: 'com.acme.FakeService.doStuff()' }),
        expect.objectContaining({ kind: 'number', token: '999' }),
      ]),
    );
  });

  it('degrades to the deterministic template when both attempts fail validation', async () => {
    const store = new InMemoryExplanationStore();
    const provider = stubProvider();
    provider.generate.mockResolvedValue(POISONED_RESULT);
    provider.repair.mockResolvedValue(POISONED_RESULT);

    const ctx = context();
    const { doc } = await getOrGenerateExplanation(store, provider, {
      contextObject: ctx,
      promptVersion: PROMPT_VERSION,
    });

    expect(doc.degraded).toBe(true);
    expect(doc.validation.passed).toBe(false);
    expect(doc.validation.attempts).toBe(2);
    expect(doc.validation.violations.length).toBeGreaterThan(0);
    expect(doc.sections).toEqual(buildTemplateSections(ctx));
    expect(doc.raw).toBe('');
    expect(provider.generate).toHaveBeenCalledTimes(1);
    expect(provider.repair).toHaveBeenCalledTimes(1);
  });
});
