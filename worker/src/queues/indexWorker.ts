/**
 * The `index` queue consumer (§5.1, §9.2). Wraps the existing `runIndex`
 * (M3's full-parse flow, unchanged) with the GitHub-cloning step M6 adds:
 * resolve the repo's cache clone via `resolveGithubWorkspace` (which itself
 * takes the per-repo lock for the clone/fetch), then hand the resulting
 * workspace path to `runIndex` exactly as the CLI (`worker:index`) always has.
 *
 * `processIndexJob` is kept separate from the BullMQ `Worker` wiring
 * (`createIndexWorker`) so the orchestration itself is testable with fakes,
 * with no live Redis/Mongo/parser needed.
 */

import type { Job, Worker as BullWorker } from 'bullmq';
import { Worker } from 'bullmq';
import type { Redis } from 'ioredis';
import type { Db } from 'mongodb';

import { QUEUE_NAMES, type IndexJobData } from '@impact/shared';

import type { WorkerConfig } from '../config.js';
import type { InstallationAuthFn } from '../github/appAuth.js';
import { resolveGithubWorkspace } from '../github/resolveWorkspace.js';
import { runIndex } from '../indexFlow/runIndex.js';
import { fixedScheduleBackoff } from './backoff.js';

export interface IndexJobDeps {
  db: Db;
  redis: Redis;
  config: WorkerConfig;
  authFn: InstallationAuthFn;
  /** Injectable for tests — defaults to the real implementation. */
  resolveWorkspace?: typeof resolveGithubWorkspace;
  /** Injectable for tests — defaults to the real implementation. */
  runIndexFn?: typeof runIndex;
}

export async function processIndexJob(
  deps: IndexJobDeps,
  data: IndexJobData,
): Promise<void> {
  const resolveWorkspace = deps.resolveWorkspace ?? resolveGithubWorkspace;
  const runIndexFn = deps.runIndexFn ?? runIndex;

  const workspace = await resolveWorkspace(
    {
      db: deps.db,
      redis: deps.redis,
      authFn: deps.authFn,
      workspaceRoot: deps.config.workspaceRoot,
    },
    data.repoId,
  );

  const result = await runIndexFn(deps.db, deps.config, {
    repoPath: workspace.repoPath,
    sha: data.sha,
    owner: workspace.owner,
    name: workspace.name,
    defaultBranch: workspace.defaultBranch,
    includeTestSources: false,
    repoId: data.repoId,
  });

  if (!result.ok) {
    throw new Error(
      result.error ?? `index failed for repo ${data.repoId} at ${data.sha}`,
    );
  }
}

/**
 * §9.2's "1 per repo" is enforced by the Redis lock inside
 * `resolveGithubWorkspace`, not by this number — a *global* concurrency of 1
 * would wrongly serialize indexing across different repos too. This is how
 * many different repos can index in parallel.
 */
const INDEX_WORKER_CONCURRENCY = 5;

export function createIndexWorker(deps: IndexJobDeps): BullWorker<IndexJobData> {
  return new Worker<IndexJobData>(
    QUEUE_NAMES.index,
    async (job: Job<IndexJobData>) => {
      await processIndexJob(deps, job.data);
    },
    {
      connection: deps.redis,
      concurrency: INDEX_WORKER_CONCURRENCY,
      settings: { backoffStrategy: fixedScheduleBackoff },
    },
  );
}
