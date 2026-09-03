import { describe, expect, it } from 'vitest';

import { syntheticGithubRepoId } from './repos.js';

describe('syntheticGithubRepoId', () => {
  it('is deterministic for the same owner/name', () => {
    expect(syntheticGithubRepoId('local', 'observability-final')).toBe(
      syntheticGithubRepoId('local', 'observability-final'),
    );
  });

  it('differs for different owner/name pairs', () => {
    const a = syntheticGithubRepoId('local', 'observability-final');
    const b = syntheticGithubRepoId('local', 'petclinic-rest');
    const c = syntheticGithubRepoId('someone-else', 'observability-final');
    expect(a).not.toBe(b);
    expect(a).not.toBe(c);
  });

  it('is always negative, so it never collides with a real GitHub repo id', () => {
    // Real GitHub repo ids are positive. Spot-check a handful of inputs rather
    // than trying to prove it for all inputs.
    for (const [owner, name] of [
      ['local', 'a'],
      ['local', 'b'],
      ['x', 'y'],
      ['', ''],
      ['🙂', 'unicode'],
    ]) {
      expect(syntheticGithubRepoId(owner ?? '', name ?? '')).toBeLessThan(0);
    }
  });

  it('is a safe integer', () => {
    const id = syntheticGithubRepoId('local', 'observability-final');
    expect(Number.isSafeInteger(id)).toBe(true);
  });
});
