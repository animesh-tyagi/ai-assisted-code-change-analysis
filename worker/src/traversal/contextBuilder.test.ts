import type { EdgeDoc, SurfaceDoc } from '@impact/shared';
import { describe, expect, it } from 'vitest';

import type { FunctionFacts } from './changeDetection.js';
import { buildContextObject } from './contextBuilder.js';
import { InMemoryGraphReader } from './inMemoryGraphReader.js';

function edge(overrides: Partial<EdgeDoc>): EdgeDoc {
  return {
    _id: 'e',
    repoId: 'r1',
    graphVersionId: 'g1',
    from: 'fn:x#x()',
    to: 'fn:y#y()',
    type: 'calls',
    inferred: false,
    confidence: 'exact',
    callSites: [{ filePath: 'src/main/java/X.java', line: 1 }],
    ...overrides,
  };
}

function surface(overrides: Partial<SurfaceDoc>): SurfaceDoc {
  return {
    _id: 's',
    repoId: 'r1',
    graphVersionId: 'g1',
    key: 'route:x',
    kind: 'http_route',
    attrs: {},
    ...overrides,
  };
}

function facts(overrides: Partial<FunctionFacts> = {}): FunctionFacts {
  return {
    filePath: 'src/main/java/com/acme/service/FooService.java',
    bodyHash: 'sha256:body',
    returnType: 'com.acme.Foo',
    paramNames: ['id'],
    modifiers: ['public'],
    ...overrides,
  };
}

// The canonical layered Spring shape: controller/job -> service (changed) -> repository -> entity -> table,
// mirroring ARCHITECTURE §10's own worked example.
const CONTROLLER = 'fn:com.acme.web.FooController#get(java.lang.Long)';
const SERVICE = 'fn:com.acme.service.FooService#findById(java.lang.Long)';
const JOB_CALLER = 'fn:com.acme.jobs.FooRefresher#refresh()';
const REPO = 'fn:com.acme.repo.FooRepository#findById(java.lang.Long)';
const ENTITY = 'entity:com.acme.Foo';
const TABLE = 'table:foo';
const ROUTE = 'route:GET /api/foos/{id}';
const JOB = 'job:com.acme.billing.NightlyJob#run()';
const CACHE = 'fn:com.acme.cache.FooCache#get(java.lang.Long)';

function layeredBaseGraph(): InMemoryGraphReader {
  return new InMemoryGraphReader(
    [
      edge({ from: CONTROLLER, to: SERVICE, type: 'calls' }),
      edge({ from: JOB_CALLER, to: SERVICE, type: 'calls' }),
      edge({ from: ROUTE, to: CONTROLLER, type: 'handles', inferred: true }),
      edge({ from: JOB, to: JOB_CALLER, type: 'triggers', inferred: true }),
      edge({ from: SERVICE, to: REPO, type: 'calls' }),
      edge({ from: REPO, to: ENTITY, type: 'queries', inferred: true }),
      edge({ from: ENTITY, to: TABLE, type: 'maps_to', inferred: true }),
    ],
    [],
    [
      surface({ key: ROUTE, kind: 'http_route' }),
      surface({ key: JOB, kind: 'scheduled_job' }),
    ],
  );
}

describe('buildContextObject — signature_changed on a layered Spring app', () => {
  it('produces the full ContextObject, matching ARCHITECTURE §10 field-for-field', async () => {
    const reader = layeredBaseGraph();

    const result = await buildContextObject(reader, {
      repo: { owner: 'acme', name: 'billing', prNumber: 412 },
      changedFunctionKey: SERVICE,
      changeKind: 'signature_changed',
      baseFacts: facts({ returnType: 'com.acme.Foo' }),
      headFacts: facts({ returnType: 'java.util.Optional', bodyHash: 'sha256:body2' }),
      sourceDiff: '@@ -41,7 +41,7 @@ …',
      overlayOutgoingEdges: [
        edge({ from: SERVICE, to: REPO }),
        edge({ from: SERVICE, to: CACHE }),
      ],
      baseOutgoingTargets: new Set([REPO]),
      baseUnresolvedRate: 0.052,
      parseErrorsInTouchedFiles: 0,
    });

    expect(result).toEqual({
      schemaVersion: 1,
      repo: { owner: 'acme', name: 'billing', prNumber: 412 },
      changedMethod: {
        key: SERVICE,
        displayName: 'FooService.findById(Long)',
        changeKind: 'signature_changed',
        filePath: 'src/main/java/com/acme/service/FooService.java',
        signatureDiff: {
          base: 'public Foo findById(Long id)',
          head: 'public Optional findById(Long id)',
          returnTypeChanged: true,
          paramsChanged: false,
          throwsAdded: [],
          visibilityChanged: false,
        },
        sourceDiff: '@@ -41,7 +41,7 @@ …',
      },
      affectedBy: {
        directCallers: [
          {
            key: CONTROLLER,
            displayName: 'FooController.get(Long)',
            hops: 1,
            callSite: { filePath: 'src/main/java/X.java', line: 1 },
            usage: 'calls this method',
            signatureCompatible: false,
            edgeConfidence: 'exact',
            inferred: false,
          },
          {
            key: JOB_CALLER,
            displayName: 'FooRefresher.refresh()',
            hops: 1,
            callSite: { filePath: 'src/main/java/X.java', line: 1 },
            usage: 'calls this method',
            signatureCompatible: false,
            edgeConfidence: 'exact',
            inferred: false,
          },
        ],
        directCallerTotal: 2,
        directCallersTruncated: false,
        reachableSurfaces: {
          entrypoints: [
            { key: ROUTE, kind: 'http_route', minHops: 2, viaInferredEdge: true },
            { key: JOB, kind: 'scheduled_job', minHops: 2, viaInferredEdge: true },
          ],
          data: [
            {
              key: TABLE,
              kind: 'table',
              access: 'read',
              viaInferredEdge: true,
              confidence: 'exact',
            },
          ],
        },
        traversal: { maxDepth: 5, depthCapHit: false, nodesVisited: 3 },
      },
      nowDependsOn: {
        callees: [
          {
            key: REPO,
            displayName: 'FooRepository.findById(Long)',
            isNew: false,
            edgeConfidence: 'exact',
            inferred: false,
          },
          {
            key: CACHE,
            displayName: 'FooCache.get(Long)',
            isNew: true,
            edgeConfidence: 'exact',
            inferred: false,
          },
        ],
      },
      changeHistory: { commits: [], truncatedAtRename: false },
      quality: {
        unresolvedRate: 0.052,
        ambiguousEdgesOnPath: 0,
        parseErrorsInTouchedFiles: 0,
      },
    });
  });
});

describe('buildContextObject — a util method behind a long chain', () => {
  it('stays short: no entrypoints/data beyond the depth cap, not a fan-out', async () => {
    const UTIL = 'fn:com.acme.util.StringUtils#normalize(java.lang.String)';
    // UTIL <- f1 <- f2 <- ... <- f6, route only reachable at f6 (beyond the depth-5 cap).
    const edges: EdgeDoc[] = [
      edge({ from: 'fn:com.acme.Chain#f1()', to: UTIL, type: 'calls' }),
    ];
    for (let i = 2; i <= 6; i++) {
      edges.push(
        edge({
          from: `fn:com.acme.Chain#f${String(i)}()`,
          to: `fn:com.acme.Chain#f${String(i - 1)}()`,
          type: 'calls',
        }),
      );
    }
    edges.push(
      edge({ from: 'route:GET /deep', to: 'fn:com.acme.Chain#f6()', type: 'handles' }),
    );

    const reader = new InMemoryGraphReader(
      edges,
      [],
      [surface({ key: 'route:GET /deep', kind: 'http_route' })],
    );

    const result = await buildContextObject(reader, {
      repo: { owner: 'acme', name: 'billing', prNumber: 1 },
      changedFunctionKey: UTIL,
      changeKind: 'modified',
      baseFacts: facts({ filePath: 'src/main/java/com/acme/util/StringUtils.java' }),
      headFacts: facts({
        filePath: 'src/main/java/com/acme/util/StringUtils.java',
        bodyHash: 'sha256:new',
      }),
      sourceDiff: '',
      overlayOutgoingEdges: [],
      baseOutgoingTargets: new Set(),
      baseUnresolvedRate: 0,
      parseErrorsInTouchedFiles: 0,
    });

    expect(result.affectedBy.reachableSurfaces.entrypoints).toEqual([]);
    expect(result.affectedBy.reachableSurfaces.data).toEqual([]);
    expect(result.affectedBy.traversal.depthCapHit).toBe(true);
    expect(result.affectedBy.traversal.nodesVisited).toBe(6); // UTIL + f1..f5, not hundreds of nodes
    expect(result.affectedBy.directCallers).toHaveLength(2); // Zone 1 stays capped at 1-2 hops: f1, f2
  });
});

describe('buildContextObject — added and removed', () => {
  it('an added function has no base-graph callers and every overlay callee is new', async () => {
    const NEW_FN = 'fn:com.acme.service.FooService#patch(java.lang.Long)';
    const reader = new InMemoryGraphReader([]); // nothing in the base graph yet
    const result = await buildContextObject(reader, {
      repo: { owner: 'acme', name: 'billing', prNumber: 2 },
      changedFunctionKey: NEW_FN,
      changeKind: 'added',
      baseFacts: null,
      headFacts: facts({ filePath: 'src/main/java/com/acme/service/FooService.java' }),
      sourceDiff: '',
      overlayOutgoingEdges: [edge({ from: NEW_FN, to: REPO })],
      baseOutgoingTargets: new Set(),
      baseUnresolvedRate: 0,
      parseErrorsInTouchedFiles: 0,
    });

    expect(result.affectedBy.directCallers).toEqual([]);
    expect(result.affectedBy.directCallerTotal).toBe(0);
    expect(result.nowDependsOn.callees).toEqual([
      {
        key: REPO,
        displayName: 'FooRepository.findById(Long)',
        isNew: true,
        edgeConfidence: 'exact',
        inferred: false,
      },
    ]);
    expect(result.changedMethod.signatureDiff.base).toBe('');
  });

  it('a removed function is always signature-incompatible for its base-graph callers', async () => {
    const reader = layeredBaseGraph();
    const result = await buildContextObject(reader, {
      repo: { owner: 'acme', name: 'billing', prNumber: 3 },
      changedFunctionKey: SERVICE,
      changeKind: 'removed',
      baseFacts: facts(),
      headFacts: null,
      sourceDiff: '',
      overlayOutgoingEdges: [], // the function no longer exists at head
      baseOutgoingTargets: new Set([REPO]),
      baseUnresolvedRate: 0,
      parseErrorsInTouchedFiles: 0,
    });

    expect(result.affectedBy.directCallers.every((c) => !c.signatureCompatible)).toBe(
      true,
    );
    expect(result.affectedBy.directCallers).toHaveLength(2); // CONTROLLER, JOB_CALLER — still reported: the base graph still shows who depended on it
    expect(result.nowDependsOn.callees).toEqual([]);
    expect(result.changedMethod.signatureDiff.head).toBe('');
  });
});
