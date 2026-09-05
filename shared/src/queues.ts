/**
 * BullMQ queue names, job-data shapes, and deterministic job-id derivation
 * (ARCHITECTURE §9.2). Shared because `api` (producer — the webhook handler
 * enqueues) and `worker` (consumer — the `Worker`s process) must agree on the
 * exact job id a given event maps to, or a redelivered webhook / a
 * double-triggered run could enqueue a duplicate instead of colliding with
 * the existing job the way §9.2 relies on.
 *
 * The `history` queue (C7/§12, `git log -L`) is deferred to a follow-up — see
 * DECISIONS.md / BUILD_PLAN Step 6 — so it is not defined here yet.
 *
 * Job *data* stays minimal (ids, not denormalised copies of Mongo documents):
 * a job looks up everything else it needs from the `repos` / `analyses`
 * collections at process time, so the job payload can never go stale relative
 * to the document it refers to.
 */

import type { ObjectIdString, Sha } from './graph.js';

export const QUEUE_NAMES = {
  index: 'index',
  analyze: 'analyze',
} as const;

export type QueueName = (typeof QUEUE_NAMES)[keyof typeof QUEUE_NAMES];

/** `index:{repoId}:{sha}` — one in-flight index per `(repo, sha)` (§9.2). */
export function indexJobId(repoId: ObjectIdString, sha: Sha): string {
  return `index:${repoId}:${sha}`;
}

/**
 * `analyze:{repoId}:{pr|push}:{headSha}` — one in-flight analysis per
 * `(repo, unit, headSha)`. `unit` is the PR number for a `pull_request`
 * trigger, or the literal `push` for a push-to-default-branch trigger (D9) —
 * a repo has only one active push-analysis stream, so `push` alone
 * disambiguates it from any PR unit on the same repo.
 */
export function analyzeJobId(
  repoId: ObjectIdString,
  unit: number | 'push',
  headSha: Sha,
): string {
  return `analyze:${repoId}:${String(unit)}:${headSha}`;
}

export interface IndexJobData {
  repoId: ObjectIdString;
  sha: Sha;
}

export interface AnalyzeJobData {
  analysisId: ObjectIdString;
}

/** §9.3 — 3 attempts, backoff 5s → 30s → 2m (not BullMQ's built-in exponential curve). */
export const JOB_ATTEMPTS = 3;
export const BACKOFF_DELAYS_MS = [5_000, 30_000, 120_000] as const;

/**
 * §9.4 — an `analyze` job waiting on its base graph re-delays itself with this
 * schedule, capped at 10 minutes total, rather than retrying via the ordinary
 * failure/backoff path (waiting on a dependency is not a failure).
 */
export const BASE_GRAPH_WAIT_DELAYS_MS = [10_000, 30_000, 60_000] as const;
export const BASE_GRAPH_WAIT_TIMEOUT_MS = 10 * 60 * 1000;
