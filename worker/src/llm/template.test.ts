import type { ContextObject } from '@impact/shared';
import { describe, expect, it } from 'vitest';

import { buildAllowlists } from './allowlist.js';
import { buildTemplateSections } from './template.js';
import { validateOutput } from './validator.js';

function context(overrides: Partial<ContextObject> = {}): ContextObject {
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
        throwsAdded: ['java.io.IOException'],
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
          usage: 'return value assigned and dereferenced',
          signatureCompatible: false,
          edgeConfidence: 'exact',
          inferred: false,
        },
      ],
      directCallerTotal: 1,
      directCallersTruncated: false,
      reachableSurfaces: {
        entrypoints: [
          { key: 'route:GET /api/foos/{id}', kind: 'http_route', minHops: 2, viaInferredEdge: true },
        ],
        data: [
          { key: 'table:foo', kind: 'table', access: 'read', viaInferredEdge: true, confidence: 'exact' },
        ],
      },
      traversal: { maxDepth: 5, depthCapHit: true, nodesVisited: 6 },
    },
    nowDependsOn: {
      callees: [
        {
          key: 'fn:com.acme.cache.FooCache#get(java.lang.Long)',
          displayName: 'FooCache.get(Long)',
          isNew: true,
          edgeConfidence: 'exact',
          inferred: false,
        },
      ],
    },
    changeHistory: { commits: [], truncatedAtRename: false },
    quality: { unresolvedRate: 0.08, ambiguousEdgesOnPath: 1, parseErrorsInTouchedFiles: 1 },
    ...overrides,
  };
}

describe('buildTemplateSections', () => {
  it('is always allowlist-clean — it never triggers its own validator', () => {
    const ctx = context();
    const sections = buildTemplateSections(ctx);
    const violations = validateOutput(sections, buildAllowlists(ctx));
    expect(violations).toEqual([]);
  });

  it('states the signature change, the caller, and the quality caveats', () => {
    const sections = buildTemplateSections(context());
    expect(sections.whatChanged).toContain('FooService.findById(Long)');
    expect(sections.whatChanged).toContain('changed with a signature change');
    expect(sections.whoIsAffected).toContain('FooController.get(Long)');
    expect(sections.whoIsAffected).toContain('1 direct caller');
    expect(sections.whatToCheck).toContain('FooCache.get(Long)');
    expect(sections.whatToCheck).toMatch(/ambiguous edge/);
    expect(sections.whatToCheck).toMatch(/depth cap/);
  });

  it('never invents a caller count beyond the precomputed directCallerTotal', () => {
    const sections = buildTemplateSections(context());
    // Only the true, precomputed total appears — no derived "N signature-incompatible" count.
    expect(sections.whoIsAffected).not.toMatch(/\d+ signature-incompatible/);
  });
});
