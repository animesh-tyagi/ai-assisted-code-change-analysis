/**
 * The `analyze` queue consumer (§5.2, §9.2, §9.4). Loads the `analyses` doc,
 * resolves the base graph (waiting on it via `resolveBaseGraph` if it isn't
 * ready yet — no git touched while merely waiting), clones the repo's
 * workspace, then runs `runAnalyze` for steps 3-11.
 *
 * `processAnalyzeJob` is kept separate from the BullMQ `Worker` wiring
 * (`createAnalyzeWorker`), with every real dependency injectable, so the
 * whole orchestration — including the base-graph-missing/delay path and the
 * superseded-analysis short-circuit — is testable with fakes.
 */

import type { Job, Worker as BullWorker } from 'bullmq';
import { Worker } from 'bullmq';
import type { Redis } from 'ioredis';
import type { Db } from 'mongodb';

import { QUEUE_NAMES, type AnalyzeJobData } from '@impact/shared';

import type { WorkerConfig } from '../config.js';
import { ObjectId, analysesCollection } from '../db/collections.js';
import type { InstallationAuthFn } from '../github/appAuth.js';
import { resolveGithubWorkspace } from '../github/resolveWorkspace.js';
import type { ExplanationStore } from '../llm/explanationStore.js';
import type { LLMProvider } from '../llm/provider.js';
import {
  BaseGraphNeverIndexedError,
  resolveBaseGraph,
  type DelayableJob,
} from '../analyzeFlow/resolveBaseGraph.js';
import { runAnalyze } from '../analyzeFlow/runAnalyze.js';
import { fixedScheduleBackoff, PermanentJobError } from './backoff.js';
import { enqueueIndexJob, type Queues } from './producer.js';

export interface AnalyzeJobDeps {
  db: Db;
  redis: Redis;
  config: WorkerConfig;
  authFn: InstallationAuthFn;
  llmProvider: LLMProvider;
  explanationStore: ExplanationStore;
  queues: Queues;
  /** Injectable for tests — default to the real implementations. */
  resolveWorkspace?: typeof resolveGithubWorkspace;
  resolveBaseGraphFn?: typeof resolveBaseGraph;
  runAnalyzeFn?: typeof runAnalyze;
}

export async function processAnalyzeJob(
  deps: AnalyzeJobDeps,
  job: DelayableJob & { data: AnalyzeJobData },
  token: string | undefined,
): Promise<void> {
  const resolveWorkspace = deps.resolveWorkspace ?? resolveGithubWorkspace;
  const resolveBaseGraphFn = deps.resolveBaseGraphFn ?? resolveBaseGraph;
  const runAnalyzeFn = deps.runAnalyzeFn ?? runAnalyze;

  const analysis = await analysesCollection(deps.db).findOne({
    _id: new ObjectId(job.data.analysisId),
  });
  if (analysis === null) {
    throw new PermanentJobError(`analyze job: analysis ${job.data.analysisId} not found`);
  }
  // A newer push/commit already superseded this one (§5.2 step 1) — nothing to do.
  if (analysis.status === 'superseded') {
    return;
  }

  const baseGraph = await resolveBaseGraphFn(
    deps.db,
    { enqueueIndex: (jobId, data) => enqueueIndexJob(deps.queues, jobId, data) },
    job,
    token,
    analysis.repoId,
    analysis.baseSha,
  ).catch(async (err: unknown) => {
    if (err instanceof BaseGraphNeverIndexedError) {
      await analysesCollection(deps.db).updateOne(
        { _id: new ObjectId(job.data.analysisId) },
        { $set: { status: 'failed', error: err.message, updatedAt: new Date() } },
      );
      throw new PermanentJobError(err.message);
    }
    throw err; // DelayedError (waiting) or a transient error — propagate as-is
  });

  const workspace = await resolveWorkspace(
    {
      db: deps.db,
      redis: deps.redis,
      authFn: deps.authFn,
      workspaceRoot: deps.config.workspaceRoot,
    },
    analysis.repoId,
  );

  await runAnalyzeFn(
    {
      db: deps.db,
      config: deps.config,
      llmProvider: deps.llmProvider,
      explanationStore: deps.explanationStore,
    },
    {
      analysisId: job.data.analysisId,
      repoId: analysis.repoId,
      baseSha: analysis.baseSha,
      headSha: analysis.headSha,
      trigger: analysis.trigger,
      prNumber: analysis.prNumber ?? null,
      baseGraphVersionId: baseGraph._id,
      baseUnresolvedRate: baseGraph.stats.unresolvedRate,
      workspace: {
        repoPath: workspace.repoPath,
        owner: workspace.owner,
        name: workspace.name,
      },
    },
  );
}

/** §9.2: "N, but blocks on the repo lock while cloning" — the lock (inside `resolveGithubWorkspace`) is what serializes per repo, not this. */
const ANALYZE_WORKER_CONCURRENCY = 5;

export function createAnalyzeWorker(deps: AnalyzeJobDeps): BullWorker<AnalyzeJobData> {
  return new Worker<AnalyzeJobData>(
    QUEUE_NAMES.analyze,
    async (job: Job<AnalyzeJobData>, token?: string) => {
      await processAnalyzeJob(deps, job, token);
    },
    {
      connection: deps.redis,
      concurrency: ANALYZE_WORKER_CONCURRENCY,
      settings: { backoffStrategy: fixedScheduleBackoff },
    },
  );
}
