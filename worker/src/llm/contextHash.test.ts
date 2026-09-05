import type { ContextObject } from '@impact/shared';
import { describe, expect, it } from 'vitest';

import { canonicalJson, contextHash } from './contextHash.js';

function sampleContext(): ContextObject {
  return {
    schemaVersion: 1,
    repo: { owner: 'acme', name: 'billing', prNumber: 412 },
    changedMethod: {
      key: 'fn:com.acme.service.FooService#findById(java.lang.Long)',
      displayName: 'FooService.findById(Long)',
      changeKind: 'signature_changed',
      filePath: 'src/main/java/com/acme/service/FooService.java',
      signatureDiff: {
        base: 'public Foo findById(Long id)',
        head: 'public Optional<Foo> findById(Long id)',
        returnTypeChanged: true,
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

describe('canonicalJson', () => {
  it('sorts object keys recursively so key order does not affect the string', () => {
    const a = { b: 1, a: { d: 2, c: 3 } };
    const b = { a: { c: 3, d: 2 }, b: 1 };
    expect(canonicalJson(a)).toBe(canonicalJson(b));
  });

  it('preserves array order — position is meaningful (e.g. directCallers ranking)', () => {
    expect(canonicalJson([1, 2, 3])).not.toBe(canonicalJson([3, 2, 1]));
  });
});

describe('contextHash', () => {
  it('is deterministic for the same context object', () => {
    expect(contextHash(sampleContext())).toBe(contextHash(sampleContext()));
  });

  it('is unaffected by object key insertion order', () => {
    const ctx = sampleContext();
    const reordered: ContextObject = {
      ...ctx,
      repo: { prNumber: ctx.repo.prNumber, name: ctx.repo.name, owner: ctx.repo.owner },
    };
    expect(contextHash(ctx)).toBe(contextHash(reordered));
  });

  it('differs when a field changes', () => {
    const ctx = sampleContext();
    const changed: ContextObject = {
      ...ctx,
      affectedBy: { ...ctx.affectedBy, directCallerTotal: 1 },
    };
    expect(contextHash(ctx)).not.toBe(contextHash(changed));
  });
});
