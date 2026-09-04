import type { EdgeDoc } from '@impact/shared';
import { describe, expect, it } from 'vitest';

import { computeNowDependsOn } from './nowDependsOn.js';

function edge(overrides: Partial<EdgeDoc> = {}): EdgeDoc {
  return {
    _id: 'e1',
    repoId: 'r1',
    graphVersionId: 'g1',
    from: 'fn:com.acme.A#a()',
    to: 'fn:com.acme.B#b()',
    type: 'calls',
    inferred: false,
    confidence: 'exact',
    callSites: [],
    ...overrides,
  };
}

describe('computeNowDependsOn', () => {
  it('marks a callee absent from the base graph as new', () => {
    const result = computeNowDependsOn([edge({ to: 'fn:com.acme.B#b()' })], new Set());
    expect(result.callees).toEqual([
      {
        key: 'fn:com.acme.B#b()',
        displayName: 'B.b()',
        isNew: true,
        edgeConfidence: 'exact',
        inferred: false,
      },
    ]);
  });

  it('marks a callee already present in the base graph as not new', () => {
    const result = computeNowDependsOn(
      [edge({ to: 'fn:com.acme.B#b()' })],
      new Set(['fn:com.acme.B#b()']),
    );
    expect(result.callees[0]?.isNew).toBe(false);
  });

  it('returns no callees for a removed function (no overlay edges)', () => {
    expect(computeNowDependsOn([], new Set(['fn:com.acme.B#b()']))).toEqual({
      callees: [],
    });
  });
});
