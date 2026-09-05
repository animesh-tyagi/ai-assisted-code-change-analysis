/**
 * §9.3's retry schedule (5s → 30s → 2m) as a BullMQ custom backoff strategy,
 * registered on each `Worker`'s `settings.backoffStrategy`. Jobs opt in with
 * `backoff: { type: 'custom' }` (see `queues/producer.ts` on both `api` and
 * `worker`) — BullMQ's own built-in `exponential`/`fixed` strategies don't
 * hit these exact numbers, so a named custom one is registered instead.
 *
 * Also the §9.3 error classification: `PermanentJobError` is BullMQ's own
 * `UnrecoverableError` under a domain name — thrown for a failure no retry
 * can fix ("repo has no Java sources", "installation suspended", a parser
 * 4xx), it stops the job immediately instead of burning three attempts on a
 * flaw that will never resolve itself. Everything else (network blips, a busy
 * parser) is a plain `Error`, which retries through the normal attempts/backoff.
 */

import { UnrecoverableError } from 'bullmq';

import { BACKOFF_DELAYS_MS } from '@impact/shared';

export class PermanentJobError extends UnrecoverableError {}

/** `attemptsMade` is 1 on the first retry (the job's first *attempt* already failed once). */
export function fixedScheduleBackoff(attemptsMade: number): number {
  const index = Math.min(Math.max(attemptsMade - 1, 0), BACKOFF_DELAYS_MS.length - 1);
  // `noUncheckedIndexedAccess` can't see that `index` is always in bounds — the
  // fallback is the schedule's own last entry, never reached in practice.
  return BACKOFF_DELAYS_MS[index] ?? 120_000;
}
