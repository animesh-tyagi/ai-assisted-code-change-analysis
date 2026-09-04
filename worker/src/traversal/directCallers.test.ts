import type { EdgeDoc } from '@impact/shared';
import { describe, expect, it } from 'vitest';

import { computeDirectCallers } from './directCallers.js';
import { InMemoryGraphReader } from './inMemoryGraphReader.js';

const CHANGED = 'fn:com.acme.Base#run()';
const IMPL_A = 'fn:com.acme.ImplA#run()';
const IMPL_B = 'fn:com.acme.ImplB#run()';
const CALLER_1 = 'fn:com.acme.Caller1#invoke()';
const CALLER_2 = 'fn:com.acme.Caller2#invoke()';

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
    callSites: [{ filePath: 'src/main/java/com/acme/X.java', line: 1 }],
    ...overrides,
  };
}

function fixtureEdges(): EdgeDoc[] {
  return [
    // Hop 1: two implementations dispatch through the interface method.
    edge({
      from: IMPL_A,
      to: CHANGED,
      type: 'implements',
      confidence: 'exact',
      inferred: false,
    }),
    edge({
      from: IMPL_B,
      to: CHANGED,
      type: 'implements',
      confidence: 'ambiguous',
      inferred: true,
    }),
    // Hop 2: callers of each impl.
    edge({
      from: CALLER_1,
      to: IMPL_A,
      type: 'calls',
      confidence: 'exact',
      inferred: false,
    }),
    edge({
      from: CALLER_2,
      to: IMPL_B,
      type: 'calls',
      confidence: 'exact',
      inferred: false,
    }),
  ];
}

describe('computeDirectCallers', () => {
  it('finds hop-1 and hop-2 callers, ranked by hops then confidence', async () => {
    const reader = new InMemoryGraphReader(fixtureEdges());
    const result = await computeDirectCallers(reader, CHANGED, {
      signatureCompatible: true,
    });

    expect(result.directCallerTotal).toBe(4);
    expect(result.directCallersTruncated).toBe(false);
    expect(result.directCallers.map((c) => c.key)).toEqual([
      IMPL_A,
      IMPL_B,
      CALLER_1,
      CALLER_2,
    ]);
    expect(result.directCallers[0]).toMatchObject({
      hops: 1,
      edgeConfidence: 'exact',
      usage: 'implements this interface method',
    });
    expect(result.directCallers[2]).toMatchObject({
      hops: 2,
      usage: 'calls this method',
    });
  });

  it('weakest-links confidence/inferred across a 2-hop path through an ambiguous hop-1 edge', async () => {
    const reader = new InMemoryGraphReader(fixtureEdges());
    const result = await computeDirectCallers(reader, CHANGED, {
      signatureCompatible: true,
    });
    const caller2 = result.directCallers.find((c) => c.key === CALLER_2);
    expect(caller2).toMatchObject({ edgeConfidence: 'ambiguous', inferred: true });
    expect(result.ambiguousCount).toBe(2); // ImplB itself, and Caller2's path through it
  });

  it('caps the returned list but keeps the true total', async () => {
    const reader = new InMemoryGraphReader(fixtureEdges());
    const result = await computeDirectCallers(reader, CHANGED, {
      signatureCompatible: true,
      cap: 2,
    });
    expect(result.directCallers).toHaveLength(2);
    expect(result.directCallerTotal).toBe(4);
    expect(result.directCallersTruncated).toBe(true);
  });

  it('applies the same signatureCompatible value to every caller (v1 has no per-call-site re-resolution)', async () => {
    const reader = new InMemoryGraphReader(fixtureEdges());
    const result = await computeDirectCallers(reader, CHANGED, {
      signatureCompatible: false,
    });
    expect(result.directCallers.every((c) => !c.signatureCompatible)).toBe(true);
  });

  it('returns nothing for a function with no callers', async () => {
    const reader = new InMemoryGraphReader([]);
    const result = await computeDirectCallers(reader, CHANGED, {
      signatureCompatible: true,
    });
    expect(result).toMatchObject({
      directCallers: [],
      directCallerTotal: 0,
      directCallersTruncated: false,
    });
  });
});
