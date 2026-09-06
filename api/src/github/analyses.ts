/**
 * Creating and superseding `analyses` docs from webhook events (§5.2 step 1,
 * D9). "Any prior non-superseded analysis for the same unit ... is
 * superseded" — a new commit on an open PR, or a new push to the default
 * branch, obsoletes whatever the previous one was computing.
 */

import type { Db } from 'mongodb';

import type { AnalysisTrigger, ObjectIdString, Sha } from '@impact/shared';

import { ObjectId, analysesCollection } from '../db/collections.js';
import { isDuplicateKeyError } from '../db/mongoErrors.js';

/** Same PR: obsolete any prior non-superseded analysis for it. */
export async function supersedePriorPullRequestAnalyses(
  db: Db,
  repoId: ObjectIdString,
  prNumber: number,
): Promise<void> {
  await analysesCollection(db).updateMany(
    { repoId, trigger: 'pull_request', prNumber, status: { $ne: 'superseded' } },
    { $set: { status: 'superseded', updatedAt: new Date() } },
  );
}

/** A repo has one active push-analysis stream: obsolete any prior non-superseded one. */
export async function supersedePriorPushAnalyses(
  db: Db,
  repoId: ObjectIdString,
): Promise<void> {
  await analysesCollection(db).updateMany(
    { repoId, trigger: 'push', status: { $ne: 'superseded' } },
    { $set: { status: 'superseded', updatedAt: new Date() } },
  );
}

export interface CreateAnalysisInput {
  repoId: ObjectIdString;
  trigger: AnalysisTrigger;
  /** Present only for `trigger: 'pull_request'` (D9). */
  prNumber?: number;
  baseSha: Sha;
  headSha: Sha;
  deliveryId: string;
  jobId: string;
}

export interface CreateAnalysisResult {
  analysisId: ObjectIdString;
  /** False when an analysis for this exact `(repoId, baseSha, headSha)` already existed. */
  created: boolean;
}

/**
 * Inserts a new `analyses` doc. The `{repoId, baseSha, headSha}` unique index
 * (§7) is the real guard against a duplicate: if a webhook somehow reaches
 * this code twice for the exact same commit pair (the delivery-id dedupe in
 * §9.1 step 3 should already prevent that, but this is cheap insurance), the
 * insert's duplicate-key error is caught and the existing doc is reused
 * rather than surfaced as a failure.
 */
export async function createOrGetAnalysis(
  db: Db,
  input: CreateAnalysisInput,
): Promise<CreateAnalysisResult> {
  const now = new Date();
  try {
    const result = await analysesCollection(db).insertOne({
      _id: new ObjectId(),
      repoId: input.repoId,
      trigger: input.trigger,
      ...(input.prNumber !== undefined ? { prNumber: input.prNumber } : {}),
      baseSha: input.baseSha,
      headSha: input.headSha,
      baseGraphVersionId: null,
      overlayGraphVersionId: null,
      deliveryId: input.deliveryId,
      jobId: input.jobId,
      status: 'queued',
      progress: { step: 'queued', pct: 0 },
      changedFunctions: [],
      createdAt: now,
      updatedAt: now,
    });
    return { analysisId: result.insertedId.toHexString(), created: true };
  } catch (err) {
    if (isDuplicateKeyError(err)) {
      const existing = await analysesCollection(db).findOne({
        repoId: input.repoId,
        baseSha: input.baseSha,
        headSha: input.headSha,
      });
      if (existing !== null) {
        return { analysisId: existing._id.toHexString(), created: false };
      }
    }
    throw err;
  }
}

/**
 * Marks an `analyses` doc failed directly from the webhook handler — used
 * when `enqueueAnalyzeJob` throws *after* `createOrGetAnalysis` already
 * succeeded, so the doc doesn't sit silently orphaned at `queued` forever
 * with no BullMQ job behind it (found the hard way, M6 phase 6 field-testing:
 * a bad job-id format made exactly this happen).
 */
export async function markAnalysisFailed(
  db: Db,
  analysisId: ObjectIdString,
  error: string,
): Promise<void> {
  await analysesCollection(db).updateOne(
    { _id: new ObjectId(analysisId) },
    { $set: { status: 'failed', error, updatedAt: new Date() } },
  );
}
