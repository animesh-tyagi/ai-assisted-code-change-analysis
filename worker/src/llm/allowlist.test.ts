import type { ContextObject } from '@impact/shared';
import { describe, expect, it } from 'vitest';

import { buildAllowlists, extractDottedTokens } from './allowlist.js';

function fullContext(): ContextObject {
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
          {
            key: 'route:GET /api/foos/{id}',
            kind: 'http_route',
            minHops: 2,
            viaInferredEdge: true,
          },
        ],
        data: [
          {
            key: 'table:foo',
            kind: 'table',
            access: 'read',
            viaInferredEdge: true,
            confidence: 'exact',
          },
          {
            key: 'entity:com.acme.Foo',
            kind: 'entity',
            access: 'read',
            viaInferredEdge: true,
            confidence: 'exact',
          },
        ],
      },
      traversal: { maxDepth: 5, depthCapHit: false, nodesVisited: 6 },
    },
    nowDependsOn: {
      callees: [
        {
          key: 'fn:com.acme.repo.FooRepository#findById(java.lang.Long)',
          displayName: 'FooRepository.findById(Long)',
          isNew: true,
          edgeConfidence: 'exact',
          inferred: false,
        },
      ],
    },
    changeHistory: {
      commits: [
        {
          sha: 'a1b2c3d',
          authorName: 'Jordan Lee',
          authoredAt: '2026-07-14T10:32:00Z',
          subject: 'Make findById null-safe',
          insertions: 6,
          deletions: 2,
        },
      ],
      truncatedAtRename: false,
    },
    quality: { unresolvedRate: 0.052, ambiguousEdgesOnPath: 1, parseErrorsInTouchedFiles: 2 },
  };
}

describe('extractDottedTokens', () => {
  it('extracts dotted identifier chains and ignores bare words', () => {
    expect(extractDottedTokens('com.acme.user.UserService and UserService.findById plain')).toEqual([
      'com.acme.user.UserService',
      'UserService.findById',
    ]);
  });
});

describe('buildAllowlists', () => {
  it('decomposes a fn: key into fqcn, class name, method name, param types, and display name', () => {
    const { symbols } = buildAllowlists(fullContext());
    expect(symbols.has('com.acme.service.FooService')).toBe(true);
    expect(symbols.has('FooService')).toBe(true);
    expect(symbols.has('findById')).toBe(true);
    expect(symbols.has('java.lang.Long')).toBe(true);
    expect(symbols.has('Long')).toBe(true);
    expect(symbols.has('FooService.findById(Long)')).toBe(true);
  });

  it('decomposes a route: key into httpMethod and path', () => {
    const { symbols } = buildAllowlists(fullContext());
    expect(symbols.has('GET')).toBe(true);
    expect(symbols.has('/api/foos/{id}')).toBe(true);
  });

  it('decomposes an entity: key into fqcn and simple name, and a table: key as-is', () => {
    const { symbols } = buildAllowlists(fullContext());
    expect(symbols.has('com.acme.Foo')).toBe(true);
    expect(symbols.has('Foo')).toBe(true);
    expect(symbols.has('foo')).toBe(true);
  });

  it('allows both the full file path and its basename', () => {
    const { symbols } = buildAllowlists(fullContext());
    expect(symbols.has('src/main/java/com/acme/service/FooService.java')).toBe(true);
    expect(symbols.has('FooService.java')).toBe(true);
  });

  it('mines dotted tokens out of signatureDiff base/head and throwsAdded', () => {
    const { symbols } = buildAllowlists(fullContext());
    expect(symbols.has('java.io.IOException')).toBe(true);
    expect(symbols.has('IOException')).toBe(true);
  });

  it('allows commit sha and author name', () => {
    const { symbols } = buildAllowlists(fullContext());
    expect(symbols.has('a1b2c3d')).toBe(true);
    expect(symbols.has('Jordan Lee')).toBe(true);
  });

  it('collects every integer field into the numeric allowlist', () => {
    const { numbers } = buildAllowlists(fullContext());
    for (const n of ['412', '1', '28', '2', '5', '6', '2', '6']) {
      expect(numbers.has(n)).toBe(true);
    }
  });

  it('excludes quality.unresolvedRate — it is a fraction, not an integer', () => {
    const { numbers } = buildAllowlists(fullContext());
    expect(numbers.has('0.052')).toBe(false);
    expect(numbers.has('0')).toBe(false);
    expect(numbers.has('052')).toBe(false);
  });
});
