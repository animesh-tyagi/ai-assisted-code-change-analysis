import type { EdgeDoc, SurfaceDoc } from '@impact/shared';
import { describe, expect, it } from 'vitest';

import { InMemoryGraphReader } from './inMemoryGraphReader.js';
import { computeDataSurfaces, computeEntrypoints } from './reachableSurfaces.js';

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
    callSites: [],
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

describe('computeEntrypoints', () => {
  const REPO = 'fn:com.acme.repo.FooRepository#save(com.acme.Foo)';
  const SERVICE = 'fn:com.acme.service.FooService#create(com.acme.Foo)';
  const CONTROLLER = 'fn:com.acme.web.FooController#create(com.acme.Foo)';
  const ROUTE = 'route:POST /api/foos';

  it('walks past the 1-2 hop zone to find a terminal route, reporting minHops as function-hops + 1', async () => {
    const reader = new InMemoryGraphReader(
      [
        edge({ from: SERVICE, to: REPO, type: 'calls' }),
        edge({ from: CONTROLLER, to: SERVICE, type: 'calls' }),
        edge({ from: ROUTE, to: CONTROLLER, type: 'handles', inferred: true }),
      ],
      [],
      [surface({ key: ROUTE, kind: 'http_route' })],
    );

    const { entrypoints, traversal } = await computeEntrypoints(reader, REPO);

    expect(entrypoints).toEqual([
      { key: ROUTE, kind: 'http_route', minHops: 3, viaInferredEdge: true },
    ]);
    expect(traversal.nodesVisited).toBe(3); // REPO, SERVICE, CONTROLLER
    expect(traversal.depthCapHit).toBe(false);
  });

  it('reports a short entrypoint list for a util method behind a long chain, capping at the depth limit', async () => {
    // f0 (changed) <- f1 <- f2 <- f3 <- f4 <- f5 <- f6, route handles f6 (beyond the depth-5 cap).
    const chain: EdgeDoc[] = [];
    for (let i = 1; i <= 6; i++) {
      chain.push(
        edge({
          from: `fn:com.acme.Chain#f${String(i)}()`,
          to: `fn:com.acme.Chain#f${String(i - 1)}()`,
          type: 'calls',
        }),
      );
    }
    const reader = new InMemoryGraphReader(
      [
        ...chain,
        edge({ from: 'route:GET /deep', to: 'fn:com.acme.Chain#f6()', type: 'handles' }),
      ],
      [],
      [surface({ key: 'route:GET /deep', kind: 'http_route' })],
    );

    const { entrypoints, traversal } = await computeEntrypoints(
      reader,
      'fn:com.acme.Chain#f0()',
    );

    expect(entrypoints).toEqual([]); // f6 is out of reach — short list, not a fan-out
    expect(traversal.depthCapHit).toBe(true);
    expect(traversal.nodesVisited).toBe(6); // f0..f5
  });

  it('finds an entrypoint reachable within the cap in the same chain', async () => {
    const chain: EdgeDoc[] = [];
    for (let i = 1; i <= 3; i++) {
      chain.push(
        edge({
          from: `fn:com.acme.Chain#f${String(i)}()`,
          to: `fn:com.acme.Chain#f${String(i - 1)}()`,
          type: 'calls',
        }),
      );
    }
    const reader = new InMemoryGraphReader(
      [
        ...chain,
        edge({
          from: 'route:GET /shallow',
          to: 'fn:com.acme.Chain#f3()',
          type: 'handles',
        }),
      ],
      [],
      [surface({ key: 'route:GET /shallow', kind: 'http_route' })],
    );

    const { entrypoints } = await computeEntrypoints(reader, 'fn:com.acme.Chain#f0()');
    expect(entrypoints).toEqual([
      {
        key: 'route:GET /shallow',
        kind: 'http_route',
        minHops: 4,
        viaInferredEdge: false,
      },
    ]);
  });
});

describe('computeDataSurfaces', () => {
  const CONTROLLER = 'fn:com.acme.web.FooController#create(com.acme.Foo)';
  const SERVICE = 'fn:com.acme.service.FooService#create(com.acme.Foo)';
  const REPO_SAVE = 'fn:com.acme.repo.FooRepository#save(com.acme.Foo)';
  const ENTITY = 'entity:com.acme.Foo';
  const TABLE = 'table:foo';

  it('collapses entity -> table two calls-hops downstream (the layered controller/service/repository shape)', async () => {
    const reader = new InMemoryGraphReader([
      edge({ from: CONTROLLER, to: SERVICE, type: 'calls' }),
      edge({ from: SERVICE, to: REPO_SAVE, type: 'calls' }),
      edge({
        from: REPO_SAVE,
        to: ENTITY,
        type: 'queries',
        confidence: 'single_impl',
        inferred: true,
      }),
      edge({ from: ENTITY, to: TABLE, type: 'maps_to', confidence: 'exact' }),
    ]);

    const data = await computeDataSurfaces(reader, CONTROLLER);

    expect(data).toEqual([
      {
        key: TABLE,
        kind: 'table',
        access: 'write',
        viaInferredEdge: true,
        confidence: 'single_impl',
      },
    ]);
  });

  it('falls back to the entity when it has no maps_to edge', async () => {
    const reader = new InMemoryGraphReader([
      edge({ from: REPO_SAVE, to: ENTITY, type: 'queries' }),
    ]);
    const data = await computeDataSurfaces(reader, REPO_SAVE);
    expect(data).toEqual([
      {
        key: ENTITY,
        kind: 'entity',
        access: 'write',
        viaInferredEdge: false,
        confidence: 'exact',
      },
    ]);
  });

  it('combines read and write verbs on the same entity into read_write', async () => {
    const finder = 'fn:com.acme.repo.FooRepository#findById(java.lang.Long)';
    const reader = new InMemoryGraphReader([
      edge({ from: CONTROLLER, to: REPO_SAVE, type: 'calls' }),
      edge({ from: CONTROLLER, to: finder, type: 'calls' }),
      edge({ from: REPO_SAVE, to: ENTITY, type: 'queries' }),
      edge({ from: finder, to: ENTITY, type: 'queries' }),
    ]);
    const data = await computeDataSurfaces(reader, CONTROLLER);
    expect(data).toEqual([
      {
        key: ENTITY,
        kind: 'entity',
        access: 'read_write',
        viaInferredEdge: false,
        confidence: 'exact',
      },
    ]);
  });
});
