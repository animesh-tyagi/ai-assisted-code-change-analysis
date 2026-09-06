import { describe, expect, it } from 'vitest';

import { analyzeJobId, indexJobId } from './queues.js';

/**
 * BullMQ rejects any custom `jobId` containing `:` unless it splits into
 * *exactly* three parts (`Job.validateOptions` in `bullmq` — a backward-compat
 * quirk for its own old repeatable-job id format). Caught live in M6 phase 6
 * field-testing: `analyzeJobId` originally produced four `:`-segments, which
 * made every real `queues.analyze.add()` call throw at runtime — nothing here
 * (typecheck, lint, the rest of the test suite) had caught it, because the
 * jobId was never round-tripped through a real `Queue.add()` in a unit test.
 */
function isValidBullmqCustomId(id: string): boolean {
  return !id.includes(':') || id.split(':').length === 3;
}

describe('indexJobId', () => {
  it('produces a BullMQ-valid custom id', () => {
    const id = indexJobId('repo-1', 'a'.repeat(40));
    expect(isValidBullmqCustomId(id)).toBe(true);
  });

  it('is deterministic for the same (repoId, sha)', () => {
    expect(indexJobId('repo-1', 'sha-1')).toBe(indexJobId('repo-1', 'sha-1'));
  });
});

describe('analyzeJobId', () => {
  it('produces a BullMQ-valid custom id for a push trigger', () => {
    const id = analyzeJobId('repo-1', 'push', 'b'.repeat(40));
    expect(isValidBullmqCustomId(id)).toBe(true);
  });

  it('produces a BullMQ-valid custom id for a pull_request trigger', () => {
    const id = analyzeJobId('repo-1', 42, 'b'.repeat(40));
    expect(isValidBullmqCustomId(id)).toBe(true);
  });

  it('disambiguates a push stream from a PR unit on the same repo/headSha', () => {
    const pushId = analyzeJobId('repo-1', 'push', 'b'.repeat(40));
    const prId = analyzeJobId('repo-1', 7, 'b'.repeat(40));
    expect(pushId).not.toBe(prId);
  });

  it('is deterministic for the same (repoId, unit, headSha)', () => {
    expect(analyzeJobId('repo-1', 7, 'sha-1')).toBe(analyzeJobId('repo-1', 7, 'sha-1'));
  });
});
