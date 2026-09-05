/** A fake `Queues` (queues/producer.ts) that records what was enqueued instead of talking to Redis. */

import type { Queue } from 'bullmq';

import type { AnalyzeJobData, IndexJobData } from '@impact/shared';

import type { Queues } from '../queues/producer.js';

export interface RecordedJob<T> {
  jobId: string;
  data: T;
}

export interface FakeQueues extends Queues {
  enqueuedIndex: RecordedJob<IndexJobData>[];
  enqueuedAnalyze: RecordedJob<AnalyzeJobData>[];
}

function fakeQueue<T>(sink: RecordedJob<T>[]): Queue<T> {
  return {
    add: async (_name: string, data: T, opts?: { jobId?: string }) => {
      await Promise.resolve();
      sink.push({ jobId: opts?.jobId ?? '', data });
      return {};
    },
    close: async () => Promise.resolve(),
  } as unknown as Queue<T>;
}

export function createFakeQueues(): FakeQueues {
  const enqueuedIndex: RecordedJob<IndexJobData>[] = [];
  const enqueuedAnalyze: RecordedJob<AnalyzeJobData>[] = [];
  return {
    index: fakeQueue(enqueuedIndex),
    analyze: fakeQueue(enqueuedAnalyze),
    enqueuedIndex,
    enqueuedAnalyze,
    close: async () => Promise.resolve(),
  };
}
