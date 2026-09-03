import { describe, expect, it } from 'vitest';

import type { ParseResponseWire } from '@impact/shared';

import {
  computeStats,
  toEdgeDocs,
  toFunctionUpserts,
  toFunctionVersionDocs,
  toSurfaceDocs,
} from './mappers.js';

const REPO_ID = '507f1f77bcf86cd799439011';
const GRAPH_VERSION_ID = '507f1f77bcf86cd799439012';

/** A small fixture mirroring the shape of parser/src/test/resources/snapshots/core.json. */
function fixtureResponse(): ParseResponseWire {
  return {
    requestId: 'test',
    sha: 'abc123',
    mode: 'full',
    sourceRoots: ['src/main/java'],
    functions: [
      {
        key: 'fn:com.acme.Foo#bar(java.lang.String)',
        fqcn: 'com.acme.Foo',
        className: 'Foo',
        methodName: 'bar',
        paramTypes: ['java.lang.String'],
        paramNames: ['s'],
        returnType: 'void',
        filePath: 'src/main/java/com/acme/Foo.java',
        startLine: 3,
        endLine: 5,
        bodyHash: 'sha256:deadbeef',
        modifiers: ['public'],
        annotations: [],
        isAbstract: false,
        isInterfaceMethod: false,
        unresolvedParamTypes: 0,
      },
    ],
    surfaces: [{ key: 'table:widgets', kind: 'table', attrs: { tableName: 'widgets' } }],
    edges: [
      {
        from: 'fn:com.acme.Foo#bar(java.lang.String)',
        to: 'fn:com.acme.Baz#qux()',
        type: 'calls',
        inferred: false,
        confidence: 'exact',
        callSites: [{ filePath: 'src/main/java/com/acme/Foo.java', line: 4 }],
        reason: null,
        candidates: [],
      },
      {
        from: 'fn:com.acme.Foo#bar(java.lang.String)',
        to: 'unresolved:com.other.Lib#call()',
        type: 'unresolved',
        inferred: false,
        confidence: 'exact',
        callSites: [{ filePath: 'src/main/java/com/acme/Foo.java', line: 5 }],
        reason: 'external_type',
        candidates: [],
      },
    ],
    diagnostics: {
      durationMs: 12,
      filesParsed: 1,
      parseErrors: [],
      totalEdges: 2,
      unresolvedEdges: 1,
      unresolvedRate: 0.5,
      nonExternalUnresolvedRate: 0,
      externalCalls: 0,
      unresolvedParamTypes: 0,
      ambiguousOverloads: [],
      failedDeclarations: 0,
      guardedFailures: 0,
      targetsMissingFromIndex: 0,
    },
  };
}

describe('toFunctionVersionDocs', () => {
  it('stamps every function with repoId/graphVersionId/sha', () => {
    const docs = toFunctionVersionDocs(fixtureResponse(), REPO_ID, GRAPH_VERSION_ID);
    expect(docs).toHaveLength(1);
    expect(docs[0]).toMatchObject({
      repoId: REPO_ID,
      graphVersionId: GRAPH_VERSION_ID,
      functionKey: 'fn:com.acme.Foo#bar(java.lang.String)',
      sha: 'abc123',
      filePath: 'src/main/java/com/acme/Foo.java',
      startLine: 3,
      endLine: 5,
      bodyHash: 'sha256:deadbeef',
    });
  });
});

describe('toSurfaceDocs', () => {
  it('stamps every surface with repoId/graphVersionId', () => {
    const docs = toSurfaceDocs(fixtureResponse(), REPO_ID, GRAPH_VERSION_ID);
    expect(docs).toEqual([
      {
        repoId: REPO_ID,
        graphVersionId: GRAPH_VERSION_ID,
        key: 'table:widgets',
        kind: 'table',
        attrs: { tableName: 'widgets' },
      },
    ]);
  });
});

describe('toEdgeDocs', () => {
  it('drops the wire-level null `reason` rather than carrying it through', () => {
    const docs = toEdgeDocs(fixtureResponse(), REPO_ID, GRAPH_VERSION_ID);
    const resolved = docs.find((d) => d.type === 'calls');
    expect(resolved).toBeDefined();
    expect(resolved).not.toHaveProperty('reason');
  });

  it('keeps a real reason on an unresolved edge', () => {
    const docs = toEdgeDocs(fixtureResponse(), REPO_ID, GRAPH_VERSION_ID);
    const unresolved = docs.find((d) => d.type === 'unresolved');
    expect(unresolved?.reason).toBe('external_type');
  });

  it('stamps every edge with repoId/graphVersionId', () => {
    const docs = toEdgeDocs(fixtureResponse(), REPO_ID, GRAPH_VERSION_ID);
    for (const doc of docs) {
      expect(doc.repoId).toBe(REPO_ID);
      expect(doc.graphVersionId).toBe(GRAPH_VERSION_ID);
    }
  });
});

describe('toFunctionUpserts', () => {
  it('splits identity fields into $setOnInsert and lastSeenAt into $set', () => {
    const now = new Date('2026-01-01T00:00:00Z');
    const upserts = toFunctionUpserts(fixtureResponse(), REPO_ID, now);
    expect(upserts).toHaveLength(1);
    const upsert = upserts[0];
    expect(upsert).toBeDefined();
    if (upsert === undefined) return;

    expect(upsert.filter).toEqual({
      repoId: REPO_ID,
      key: 'fn:com.acme.Foo#bar(java.lang.String)',
    });
    expect(upsert.setOnInsert).toMatchObject({
      repoId: REPO_ID,
      key: 'fn:com.acme.Foo#bar(java.lang.String)',
      fqcn: 'com.acme.Foo',
      className: 'Foo',
      methodName: 'bar',
      paramTypes: ['java.lang.String'],
      firstSeenAt: now,
    });
    expect(upsert.set).toEqual({ lastSeenAt: now });
  });
});

describe('computeStats', () => {
  it('takes counts from the response arrays and rates from diagnostics', () => {
    const response = fixtureResponse();
    const stats = computeStats(response, response.diagnostics);
    expect(stats).toEqual({
      functions: 1,
      edges: 2,
      surfaces: 1,
      unresolvedRate: 0.5,
      nonExternalUnresolvedRate: 0,
      externalCalls: 0,
      parseErrors: 0,
    });
  });
});
