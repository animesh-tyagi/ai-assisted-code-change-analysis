/**
 * §5.2 step 2 / §9.4: resolve the analysis's base graph version. If it isn't
 * indexed yet, enqueue an `index` job for the base SHA (idempotent — BullMQ's
 * own jobId dedupe means calling this on every retry never double-enqueues)
 * and re-delay this analyze job rather than treating "not ready yet" as a
 * failure — a missing base graph is a dependency to wait on, not a defect.
 *
 * A graph version with status `ready` *or* `superseded` is usable: rows for
 * a `superseded` version are only ever kept when something still has it
 * pinned (`pruneSuperseded` in `runIndex.ts` deletes the doc entirely
 * otherwise), so if the doc still exists its rows do too.
 *
 * BullMQ's own pattern for a job delaying itself without burning a retry
 * attempt: call `job.moveToDelayed`, then throw `DelayedError` so the
 * `Worker` knows not to complete/fail the job it just delayed. `DelayableJob`
 * is the minimal slice of the real `Job` this needs, so the wait/backoff
 * logic is unit-testable without constructing a real BullMQ `Job`.
 */

import { DelayedError } from 'bullmq';
import type { Db } from 'mongodb';

import {
  BASE_GRAPH_WAIT_DELAYS_MS,
  BASE_GRAPH_WAIT_TIMEOUT_MS,
  indexJobId,
  type GraphVersionDoc,
  type IndexJobData,
  type ObjectIdString,
  type Sha,
} from '@impact/shared';

import { graphVersionsCollection } from '../db/collections.js';

export interface DelayableJob {
  /** BullMQ's own job-creation timestamp (ms since epoch) — the wait-budget clock. */
  timestamp: number;
  /** A property function type, not method shorthand — plays nicer with `vi.fn()` fakes and `expect(job.moveToDelayed)`. */
  moveToDelayed: (timestamp: number, token?: string) => Promise<void>;
}

export interface ResolveBaseGraphDeps {
  enqueueIndex: (jobId: string, data: IndexJobData) => Promise<void>;
}

export class BaseGraphNeverIndexedError extends Error {}

export async function resolveBaseGraph(
  db: Db,
  deps: ResolveBaseGraphDeps,
  job: DelayableJob,
  token: string | undefined,
  repoId: ObjectIdString,
  baseSha: Sha,
): Promise<GraphVersionDoc> {
  const existing = await graphVersionsCollection(db).findOne({
    repoId,
    sha: baseSha,
    kind: 'branch',
  });

  if (
    existing !== null &&
    (existing.status === 'ready' || existing.status === 'superseded')
  ) {
    return { ...existing, _id: existing._id.toHexString() };
  }

  const elapsedMs = Date.now() - job.timestamp;
  if (elapsedMs >= BASE_GRAPH_WAIT_TIMEOUT_MS) {
    throw new BaseGraphNeverIndexedError(`base commit ${baseSha} was never indexed`);
  }

  if (existing === null || existing.status === 'failed') {
    await deps.enqueueIndex(indexJobId(repoId, baseSha), { repoId, sha: baseSha });
  }

  const delayMs = pickWaitDelayMs(elapsedMs);
  await job.moveToDelayed(Date.now() + delayMs, token);
  throw new DelayedError();
}

/** Which rung of the §9.4 schedule (10s → 30s → 60s) we're on, purely from elapsed time. */
function pickWaitDelayMs(elapsedMs: number): number {
  let cumulative = 0;
  for (const delay of BASE_GRAPH_WAIT_DELAYS_MS) {
    cumulative += delay;
    if (elapsedMs < cumulative) return delay;
  }
  return BASE_GRAPH_WAIT_DELAYS_MS[BASE_GRAPH_WAIT_DELAYS_MS.length - 1] ?? 60_000;
}
