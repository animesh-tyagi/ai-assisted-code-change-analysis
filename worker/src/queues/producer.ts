/**
 * The worker's own BullMQ producer side (§9.2). The worker is primarily a
 * consumer, but the analyze flow needs to enqueue an `index` job itself when
 * the base graph isn't ready yet (§9.4, `resolveBaseGraph.ts`). Mirrors
 * `api/src/queues/producer.ts`; see that file's doc comment for the
 * `backoff: { type: 'custom' }` reasoning.
 *
 * `ensureFreshJobSlot` matters specifically for the §9.4 wait loop: BullMQ's
 * job-id dedupe treats *any* terminal state — `completed` as well as `failed`
 * — as "don't run this again", so `queue.add()` with a jobId that already
 * completed silently no-ops instead of re-running. That's fine the instant
 * after a job finishes, but D3's retention (`pruneSuperseded` in
 * `runIndex.ts`) can later delete the very `graphVersions` row that
 * completed job produced — e.g. a base commit's graph gets indexed, then a
 * *later* index (of a different SHA becoming current) prunes it away as
 * superseded. `resolveBaseGraph` then correctly sees the graph is missing
 * and calls `enqueueIndex` again, but without this, that call is a no-op
 * forever: the job "completed" once, BullMQ won't run it a second time under
 * the same id, and nothing ever repairs the missing row until the analysis
 * times out at `BASE_GRAPH_WAIT_TIMEOUT_MS`. Found live, M6 phase 6
 * field-testing. Removing a job in a terminal state before re-adding it
 * leaves the "don't duplicate in-flight work" half of the dedupe intact
 * (waiting/active/delayed jobs are left alone) while making "the caller has
 * independently verified this needs to be redone" actually able to redo it.
 */

import { Queue } from 'bullmq';
import type { Redis } from 'ioredis';

import type { AnalyzeJobData, IndexJobData } from '@impact/shared';
import { JOB_ATTEMPTS, QUEUE_NAMES } from '@impact/shared';

export interface Queues {
  index: Queue<IndexJobData>;
  analyze: Queue<AnalyzeJobData>;
  close(): Promise<void>;
}

export function createQueues(connection: Redis): Queues {
  const index = new Queue<IndexJobData>(QUEUE_NAMES.index, { connection });
  const analyze = new Queue<AnalyzeJobData>(QUEUE_NAMES.analyze, { connection });

  return {
    index,
    analyze,
    async close() {
      await Promise.all([index.close(), analyze.close()]);
    },
  };
}

const DEFAULT_JOB_OPTS = {
  attempts: JOB_ATTEMPTS,
  backoff: { type: 'custom' as const },
  removeOnComplete: { age: 7 * 24 * 60 * 60 },
  removeOnFail: { age: 30 * 24 * 60 * 60 },
};

/** Terminal states in BullMQ's own sense — anything else (waiting/active/delayed) is left alone. */
async function ensureFreshJobSlot(
  queue: Queue<IndexJobData> | Queue<AnalyzeJobData>,
  jobId: string,
): Promise<void> {
  const existing = await queue.getJob(jobId);
  if (existing === undefined) return;
  const state = await existing.getState();
  if (state === 'completed' || state === 'failed') {
    await existing.remove();
  }
}

export async function enqueueIndexJob(
  queues: Queues,
  jobId: string,
  data: IndexJobData,
): Promise<void> {
  await ensureFreshJobSlot(queues.index, jobId);
  await queues.index.add(QUEUE_NAMES.index, data, { ...DEFAULT_JOB_OPTS, jobId });
}

export async function enqueueAnalyzeJob(
  queues: Queues,
  jobId: string,
  data: AnalyzeJobData,
): Promise<void> {
  await ensureFreshJobSlot(queues.analyze, jobId);
  await queues.analyze.add(QUEUE_NAMES.analyze, data, { ...DEFAULT_JOB_OPTS, jobId });
}
