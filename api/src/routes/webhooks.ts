/**
 * `POST /api/webhooks/github` (ARCHITECTURE §9.1). Verify → dedupe → switch on
 * event → enqueue → `202`, in that order, with no clone/parse/collection scan
 * on this path — the budget is p99 < 500ms against GitHub's ~10s delivery
 * timeout.
 *
 * Needs the *raw* request body to verify `X-Hub-Signature-256`, so
 * `express.json()` is mounted here, scoped to this route only, with a
 * `verify` callback that stashes the buffer — never applied globally ahead of
 * this route (see the note this replaces in `api/src/index.ts`).
 */

import express, { type Request, type Response, type Router } from 'express';
import type { Db } from 'mongodb';

import { analyzeJobId, indexJobId, type ObjectIdString } from '@impact/shared';

import { installationsCollection } from '../db/collections.js';
import {
  createOrGetAnalysis,
  markAnalysisFailed,
  supersedePriorPullRequestAnalyses,
  supersedePriorPushAnalyses,
} from '../github/analyses.js';
import { insertDeliveryIfNew, markDeliveryProcessed } from '../github/deliveries.js';
import {
  ZERO_SHA,
  type InstallationEventPayload,
  type InstallationRepositoriesEventPayload,
  type PullRequestEventPayload,
  type PushEventPayload,
} from '../github/events.js';
import {
  upsertInstallation,
  upsertRepoFull,
  upsertRepoMinimal,
} from '../github/repos.js';
import { verifyGithubSignature } from '../github/verifySignature.js';
import { enqueueAnalyzeJob, enqueueIndexJob, type Queues } from '../queues/producer.js';

interface RequestWithRawBody extends Request {
  rawBody?: Buffer;
}

export interface WebhooksRouterDeps {
  db: Db;
  queues: Queues;
  webhookSecret: string;
}

export function createWebhooksRouter(deps: WebhooksRouterDeps): Router {
  const router = express.Router();

  router.post(
    '/github',
    express.json({
      limit: '2mb',
      verify: (req, _res, buf) => {
        (req as RequestWithRawBody).rawBody = buf;
      },
    }),
    (req, res) => {
      handleWebhook(deps, req as RequestWithRawBody, res).catch((err: unknown) => {
        console.error('[webhooks] unhandled error:', err);
        if (!res.headersSent) res.status(500).json({ error: 'internal error' });
      });
    },
  );

  return router;
}

async function handleWebhook(
  deps: WebhooksRouterDeps,
  req: RequestWithRawBody,
  res: Response,
): Promise<void> {
  const rawBody = req.rawBody;
  if (rawBody === undefined) {
    res.status(400).json({ error: 'missing body' });
    return;
  }

  const signature = req.header('X-Hub-Signature-256');
  if (!verifyGithubSignature(deps.webhookSecret, rawBody, signature)) {
    res.status(401).json({ error: 'invalid signature' });
    return;
  }

  const deliveryId = req.header('X-GitHub-Delivery');
  const eventName = req.header('X-GitHub-Event');
  if (deliveryId === undefined || eventName === undefined) {
    res.status(400).json({ error: 'missing delivery headers' });
    return;
  }

  const action =
    typeof req.body === 'object' && req.body !== null && 'action' in req.body
      ? String((req.body as { action: unknown }).action)
      : null;

  const isNew = await insertDeliveryIfNew(deps.db, deliveryId, eventName, action);
  if (!isNew) {
    res.status(200).json({ deliveryId, deduped: true });
    return;
  }

  let analysisId: ObjectIdString | undefined;
  try {
    switch (eventName) {
      case 'installation':
        await handleInstallationEvent(deps.db, req.body as InstallationEventPayload);
        break;
      case 'installation_repositories':
        await handleInstallationRepositoriesEvent(
          deps.db,
          req.body as InstallationRepositoriesEventPayload,
        );
        break;
      case 'push':
        analysisId = await handlePushEvent(
          deps,
          deliveryId,
          req.body as PushEventPayload,
        );
        break;
      case 'pull_request':
        analysisId = await handlePullRequestEvent(
          deps,
          deliveryId,
          req.body as PullRequestEventPayload,
        );
        break;
      default:
        break; // ack and ignore
    }
  } finally {
    await markDeliveryProcessed(deps.db, deliveryId);
  }

  res
    .status(202)
    .json({ deliveryId, ...(analysisId !== undefined ? { analysisId } : {}) });
}

/**
 * Enqueues the analyze job for an already-created `analyses` doc. If the
 * enqueue itself throws, the doc is marked `failed` rather than left stuck at
 * `queued` with no job behind it, then the error is rethrown so the outer
 * handler still 500s (a transient Redis blip should still make GitHub retry
 * the delivery — see `handleWebhook`'s catch-all).
 */
async function enqueueAnalyzeJobOrMarkFailed(
  deps: WebhooksRouterDeps,
  jobId: string,
  analysisId: ObjectIdString,
): Promise<void> {
  try {
    await enqueueAnalyzeJob(deps.queues, jobId, { analysisId });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await markAnalysisFailed(
      deps.db,
      analysisId,
      `failed to enqueue analyze job: ${message}`,
    );
    throw err;
  }
}

async function resolveInstallationId(
  db: Db,
  githubInstallationId: number | undefined,
): Promise<ObjectIdString | null> {
  if (githubInstallationId === undefined) return null;
  const doc = await installationsCollection(db).findOne({ githubInstallationId });
  return doc === null ? null : doc._id.toHexString();
}

async function handleInstallationEvent(
  db: Db,
  payload: InstallationEventPayload,
): Promise<void> {
  const { installationId } = await upsertInstallation(db, payload.installation);
  for (const repo of payload.repositories ?? []) {
    await upsertRepoMinimal(db, repo, installationId);
  }
}

async function handleInstallationRepositoriesEvent(
  db: Db,
  payload: InstallationRepositoriesEventPayload,
): Promise<void> {
  const { installationId } = await upsertInstallation(db, payload.installation);
  for (const repo of payload.repositories_added ?? []) {
    await upsertRepoMinimal(db, repo, installationId);
  }
}

/** `push` to the default branch: index always; analyze unless it's a branch-create (§9.1). */
async function handlePushEvent(
  deps: WebhooksRouterDeps,
  deliveryId: string,
  payload: PushEventPayload,
): Promise<ObjectIdString | undefined> {
  const installationId = await resolveInstallationId(deps.db, payload.installation?.id);
  const { repoId } = await upsertRepoFull(deps.db, payload.repository, installationId);

  const defaultRef = `refs/heads/${payload.repository.default_branch}`;
  if (payload.ref !== defaultRef) {
    return undefined; // a push to a non-default branch doesn't index or analyze
  }

  await enqueueIndexJob(deps.queues, indexJobId(repoId, payload.after), {
    repoId,
    sha: payload.after,
  });

  if (payload.before === ZERO_SHA) {
    return undefined; // branch creation — no `before` to diff against
  }

  // The force-push "is `before` an ancestor of `after`" check needs git,
  // which this process doesn't have — the worker's analyze job makes that
  // check once it has a clone (M6 Phase 4) and fails the analysis explicitly
  // rather than this handler silently mis-detecting it from the payload alone.
  await supersedePriorPushAnalyses(deps.db, repoId);
  const jobId = analyzeJobId(repoId, 'push', payload.after);
  const { analysisId } = await createOrGetAnalysis(deps.db, {
    repoId,
    trigger: 'push',
    baseSha: payload.before,
    headSha: payload.after,
    deliveryId,
    jobId,
  });
  await enqueueAnalyzeJobOrMarkFailed(deps, jobId, analysisId);
  return analysisId;
}

/** `pull_request` opened/synchronize/reopened: analyze; any other action is ignored. */
async function handlePullRequestEvent(
  deps: WebhooksRouterDeps,
  deliveryId: string,
  payload: PullRequestEventPayload,
): Promise<ObjectIdString | undefined> {
  if (
    payload.action !== 'opened' &&
    payload.action !== 'synchronize' &&
    payload.action !== 'reopened'
  ) {
    return undefined;
  }

  const installationId = await resolveInstallationId(deps.db, payload.installation?.id);
  const { repoId } = await upsertRepoFull(deps.db, payload.repository, installationId);

  await supersedePriorPullRequestAnalyses(deps.db, repoId, payload.number);
  const jobId = analyzeJobId(repoId, payload.number, payload.pull_request.head.sha);
  const { analysisId } = await createOrGetAnalysis(deps.db, {
    repoId,
    trigger: 'pull_request',
    prNumber: payload.number,
    baseSha: payload.pull_request.base.sha,
    headSha: payload.pull_request.head.sha,
    deliveryId,
    jobId,
  });
  await enqueueAnalyzeJobOrMarkFailed(deps, jobId, analysisId);
  return analysisId;
}
