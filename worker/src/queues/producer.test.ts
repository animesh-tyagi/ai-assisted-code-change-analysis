import type { Queue } from 'bullmq';
import { describe, expect, it, vi } from 'vitest';

import type { IndexJobData } from '@impact/shared';

import { enqueueIndexJob, type Queues } from './producer.js';

/**
 * A fake job with a mutable state, so a test can simulate "this job already
 * reached a terminal state" without a real Redis/BullMQ instance.
 */
function fakeJob(state: string) {
  return {
    getState: async () => Promise.resolve(state),
    remove: vi.fn().mockResolvedValue(undefined),
  };
}

function fakeQueueWithExistingJob(existing: ReturnType<typeof fakeJob> | undefined) {
  const add = vi.fn().mockResolvedValue({});
  const getJob = vi.fn().mockResolvedValue(existing);
  const queue = { add, getJob } as unknown as Queue<IndexJobData>;
  return { queue, add, getJob };
}

function queuesWith(index: Queue<IndexJobData>): Queues {
  return {
    index,
    analyze: {} as never,
    close: async () => Promise.resolve(),
  };
}

describe('enqueueIndexJob / ensureFreshJobSlot', () => {
  it('adds normally when no job with that id exists yet', async () => {
    const { queue, add, getJob } = fakeQueueWithExistingJob(undefined);

    await enqueueIndexJob(queuesWith(queue), 'index:repo-1:sha-1', {
      repoId: 'repo-1',
      sha: 'sha-1',
    });

    expect(getJob).toHaveBeenCalledWith('index:repo-1:sha-1');
    expect(add).toHaveBeenCalledTimes(1);
  });

  it('removes a completed job before re-adding, so it actually re-runs', async () => {
    const existing = fakeJob('completed');
    const { queue, add } = fakeQueueWithExistingJob(existing);

    await enqueueIndexJob(queuesWith(queue), 'index:repo-1:sha-1', {
      repoId: 'repo-1',
      sha: 'sha-1',
    });

    expect(existing.remove).toHaveBeenCalledTimes(1);
    expect(add).toHaveBeenCalledTimes(1);
  });

  it('removes a failed job before re-adding', async () => {
    const existing = fakeJob('failed');
    const { queue, add } = fakeQueueWithExistingJob(existing);

    await enqueueIndexJob(queuesWith(queue), 'index:repo-1:sha-1', {
      repoId: 'repo-1',
      sha: 'sha-1',
    });

    expect(existing.remove).toHaveBeenCalledTimes(1);
    expect(add).toHaveBeenCalledTimes(1);
  });

  it('leaves an in-flight job (waiting/active/delayed) alone', async () => {
    for (const state of ['waiting', 'active', 'delayed']) {
      const existing = fakeJob(state);
      const { queue, add } = fakeQueueWithExistingJob(existing);

      await enqueueIndexJob(queuesWith(queue), 'index:repo-1:sha-1', {
        repoId: 'repo-1',
        sha: 'sha-1',
      });

      expect(existing.remove).not.toHaveBeenCalled();
      // add() is still called — BullMQ's own dedupe (not ours) is what makes
      // this a no-op for an in-flight job, so we don't need to skip calling it.
      expect(add).toHaveBeenCalledTimes(1);
    }
  });
});
