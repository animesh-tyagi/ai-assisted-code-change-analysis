/**
 * The worker's own BullMQ producer side (§9.2). The worker is primarily a
 * consumer, but the analyze flow needs to enqueue an `index` job itself when
 * the base graph isn't ready yet (§9.4, `resolveBaseGraph.ts`). Mirrors
 * `api/src/queues/producer.ts`; see that file's doc comment for the
 * `backoff: { type: 'custom' }` reasoning.
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

export async function enqueueIndexJob(
  queues: Queues,
  jobId: string,
  data: IndexJobData,
): Promise<void> {
  await queues.index.add(QUEUE_NAMES.index, data, { ...DEFAULT_JOB_OPTS, jobId });
}

export async function enqueueAnalyzeJob(
  queues: Queues,
  jobId: string,
  data: AnalyzeJobData,
): Promise<void> {
  await queues.analyze.add(QUEUE_NAMES.analyze, data, { ...DEFAULT_JOB_OPTS, jobId });
}
