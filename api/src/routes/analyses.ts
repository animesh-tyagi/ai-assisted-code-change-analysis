/**
 * The §9.6 read endpoints: `GET /api/analyses/:id` (the frontend's poll
 * target) and `GET /api/repos/:repoId/pulls/:number/latest` (resolves the
 * newest non-superseded analysis for a PR, so a page reload finds the run
 * without holding an id).
 *
 * Both return the same shape. `result.changedFunctions` embeds each changed
 * function's explanation prose inline (a join against `explanations`) rather
 * than making the frontend do a second round-trip per function — and is
 * populated progressively as `runAnalyze` appends to `analyses.changedFunctions`
 * mid-run, not only once `status` reaches `ready`, so a poller can render
 * completed functions while later ones are still being explained.
 */

import express, { type Router } from 'express';
import type { Db } from 'mongodb';

import type {
  AnalysisChangedFunction,
  AnalysisProgress,
  AnalysisStatus,
  AnalysisTrigger,
  ExplanationSections,
  Sha,
} from '@impact/shared';

import {
  ObjectId,
  analysesCollection,
  explanationsCollection,
} from '../db/collections.js';
import type { MongoDoc } from '../db/collections.js';

export interface AnalysesRouterDeps {
  db: Db;
}

interface ChangedFunctionResult {
  functionKey: string;
  changeKind: string;
  /** `null` if the explanation row is somehow missing (should not happen — disclosed, not hidden). */
  sections: ExplanationSections | null;
  degraded: boolean | null;
}

interface AnalysisResponseBody {
  analysisId: string;
  repoId: string;
  trigger: AnalysisTrigger;
  prNumber?: number;
  baseSha: Sha;
  headSha: Sha;
  status: AnalysisStatus;
  progress: AnalysisProgress;
  error?: string;
  result: { changedFunctions: ChangedFunctionResult[] };
}

export function createAnalysesRouter(deps: AnalysesRouterDeps): Router {
  const router = express.Router();

  router.get('/analyses/:id', (req, res) => {
    handleGetAnalysis(deps, req.params.id, res).catch((err: unknown) => {
      console.error('[analyses] unhandled error:', err);
      if (!res.headersSent) res.status(500).json({ error: 'internal error' });
    });
  });

  router.get('/repos/:repoId/pulls/:number/latest', (req, res) => {
    handleGetLatestForPull(deps, req.params.repoId, req.params.number, res).catch(
      (err: unknown) => {
        console.error('[analyses] unhandled error:', err);
        if (!res.headersSent) res.status(500).json({ error: 'internal error' });
      },
    );
  });

  return router;
}

async function handleGetAnalysis(
  deps: AnalysesRouterDeps,
  id: string,
  res: express.Response,
): Promise<void> {
  let objectId: ObjectId;
  try {
    objectId = new ObjectId(id);
  } catch {
    res.status(400).json({ error: 'invalid analysis id' });
    return;
  }

  const analysis = await analysesCollection(deps.db).findOne({ _id: objectId });
  if (analysis === null) {
    res.status(404).json({ error: 'analysis not found' });
    return;
  }

  res.json(await serializeAnalysis(deps.db, analysis));
}

async function handleGetLatestForPull(
  deps: AnalysesRouterDeps,
  repoId: string,
  numberParam: string,
  res: express.Response,
): Promise<void> {
  const prNumber = Number(numberParam);
  if (!Number.isInteger(prNumber)) {
    res.status(400).json({ error: 'invalid pull request number' });
    return;
  }

  const analysis = await analysesCollection(deps.db)
    .find({ repoId, prNumber, status: { $ne: 'superseded' } })
    .sort({ createdAt: -1 })
    .limit(1)
    .next();
  if (analysis === null) {
    res.status(404).json({ error: 'no analysis found for this pull request' });
    return;
  }

  res.json(await serializeAnalysis(deps.db, analysis));
}

async function serializeAnalysis(
  db: Db,
  analysis: MongoDoc<{
    _id: string;
    repoId: string;
    trigger: AnalysisTrigger;
    prNumber?: number;
    baseSha: Sha;
    headSha: Sha;
    status: AnalysisStatus;
    progress: AnalysisProgress;
    error?: string;
    changedFunctions: AnalysisChangedFunction[];
  }>,
): Promise<AnalysisResponseBody> {
  const changedFunctions = await Promise.all(
    analysis.changedFunctions.map(async (cf): Promise<ChangedFunctionResult> => {
      const explanation =
        cf.explanationId === null
          ? null
          : await explanationsCollection(db).findOne({
              _id: new ObjectId(cf.explanationId),
            });
      return {
        functionKey: cf.functionKey,
        changeKind: cf.changeKind,
        sections: explanation?.sections ?? null,
        degraded: explanation?.degraded ?? null,
      };
    }),
  );

  return {
    analysisId: analysis._id.toHexString(),
    repoId: analysis.repoId,
    trigger: analysis.trigger,
    ...(analysis.prNumber !== undefined ? { prNumber: analysis.prNumber } : {}),
    baseSha: analysis.baseSha,
    headSha: analysis.headSha,
    status: analysis.status,
    progress: analysis.progress,
    ...(analysis.error !== undefined ? { error: analysis.error } : {}),
    result: { changedFunctions },
  };
}
