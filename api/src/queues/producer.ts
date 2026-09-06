/**
 * The BullMQ producer side (§9.2) — the API process only ever enqueues onto
 * `index`/`analyze`, it never processes a job itself (that's `worker/src/serve.ts`,
 * M6 Phase 5). `history` is deferred to a follow-up (see BUILD_PLAN Step 6).
 *
 * `backoff: { type: 'custom' }` on every add — the actual delay schedule
 * (§9.3: 5s → 30s → 2m) is a `backoffStrategy` function registered where the
 * `Worker` is constructed (Phase 3), not here; a producer only needs to name
 * which strategy a job opts into.
 *
 * `ensureFreshJobSlot`: BullMQ's job-id dedupe treats `completed` as terminal
 * the same as `failed` — `queue.add()` with an id that already completed
 * silently no-ops rather than re-running. That's usually right (§9.2's whole
 * point), but D3's retention can later delete a completed index job's own
 * `graphVersions` row (a later index of a different SHA becoming current
 * prunes it as superseded), leaving nothing to redo the no-longer-accurate
 * work under that same id. See the fuller note on the identical helper in
 * `worker/src/queues/producer.ts` — kept duplicated rather than shared across
 * the `api`/`worker` process boundary, matching this file's own established
 * pattern.
 */

import { Queue } from 'bullmq';
import type { Redis } from 'ioredis';

import type { AnalyzeJobData, IndexJobData } from '@impact/shared';
import { JOB_ATTEMPTS, QUEUE_NAMES } from '@impact/shared';

import { createRedisConnection } from './connection.js';

export interface Queues {
  index: Queue<IndexJobData>;
  analyze: Queue<AnalyzeJobData>;
  close(): Promise<void>;
}

export function createQueues(redisUrl: string): Queues {
  const connection: Redis = createRedisConnection(redisUrl);
  const index = new Queue<IndexJobData>(QUEUE_NAMES.index, { connection });
  const analyze = new Queue<AnalyzeJobData>(QUEUE_NAMES.analyze, { connection });

  return {
    index,
    analyze,
    async close() {
      await Promise.all([index.close(), analyze.close()]);
      connection.disconnect();
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
