/**
 * The analyze flow (ARCHITECTURE §5.2), steps 3–11 — everything after the
 * base graph is resolved (`resolveBaseGraph.ts` handles steps 1–2/§9.4) and
 * the repo's cache clone is ready (`resolveGithubWorkspace`, M6 Phase 3).
 *
 * Wires together building blocks that already existed in isolation before
 * this milestone: `runIndex`'s own mappers (M3), `detectChangedFunctions`
 * and `buildContextObject` (M4), and `getOrGenerateExplanation` (M5). This
 * function is what `contextBuilder.ts`'s own doc comment flagged as missing:
 * "Step 6 ... is what will produce [sourceDiff/changeHistory] for real and
 * call this function per changed key from the analyze flow."
 *
 * `changeHistory` (C7/§12, `git log -L`) is deferred to a follow-up — see
 * BUILD_PLAN Step 6 — so every context object here carries the default empty
 * `changeHistory` `buildContextObject` already falls back to.
 */

import { randomUUID } from 'node:crypto';
import path from 'node:path';

import type { Db } from 'mongodb';

import type {
  AnalysisChangedFunction,
  AnalysisStatus,
  EdgeDoc,
  FunctionVersionDoc,
  NodeKey,
  ObjectIdString,
  Sha,
} from '@impact/shared';

import type { WorkerConfig } from '../config.js';
import {
  ObjectId,
  analysesCollection,
  edgesCollection,
  functionVersionsCollection,
  graphVersionsCollection,
  surfacesCollection,
} from '../db/collections.js';
import { addWorktree, removeWorktree } from '../git/worktree.js';
import {
  computeStats,
  toEdgeDocs,
  toFunctionVersionDocs,
  toSurfaceDocs,
} from '../indexFlow/mappers.js';
import { getOrGenerateExplanation } from '../llm/generateExplanation.js';
import { PROMPT_VERSION } from '../llm/prompt.js';
import type { ExplanationStore } from '../llm/explanationStore.js';
import type { LLMProvider } from '../llm/provider.js';
import { getVersion, postParse } from '../parser/client.js';
import {
  detectChangedFunctions,
  type FunctionFacts,
} from '../traversal/changeDetection.js';
import { buildContextObject } from '../traversal/contextBuilder.js';
import { MongoGraphReader, type GraphReader } from '../traversal/graphReader.js';
import {
  computeSourceDiff,
  diffNameStatus,
  isAncestor,
  type LineRange,
} from './gitDiff.js';

/** The mapper functions take the parser's own wire response shape (not a Mongo doc). */
type ParseResponse = Parameters<typeof toFunctionVersionDocs>[0];

export class AnalysisFailedError extends Error {}

export interface AnalyzeWorkspace {
  repoPath: string;
  owner: string;
  name: string;
}

export interface RunAnalyzeInput {
  analysisId: ObjectIdString;
  repoId: ObjectIdString;
  baseSha: Sha;
  headSha: Sha;
  trigger: 'push' | 'pull_request';
  prNumber: number | null;
  baseGraphVersionId: ObjectIdString;
  baseUnresolvedRate: number;
  workspace: AnalyzeWorkspace;
}

export interface RunAnalyzeDeps {
  db: Db;
  config: WorkerConfig;
  llmProvider: LLMProvider;
  explanationStore: ExplanationStore;
  // Injectable seams for tests — default to the real implementations.
  postParseFn?: typeof postParse;
  getVersionFn?: typeof getVersion;
  addWorktreeFn?: typeof addWorktree;
  removeWorktreeFn?: typeof removeWorktree;
  diffNameStatusFn?: typeof diffNameStatus;
  isAncestorFn?: typeof isAncestor;
  computeSourceDiffFn?: typeof computeSourceDiff;
  makeGraphReader?: (graphVersionId: ObjectIdString) => GraphReader;
}

export async function runAnalyze(
  deps: RunAnalyzeDeps,
  input: RunAnalyzeInput,
): Promise<void> {
  const postParseFn = deps.postParseFn ?? postParse;
  const getVersionFn = deps.getVersionFn ?? getVersion;
  const addWorktreeFn = deps.addWorktreeFn ?? addWorktree;
  const removeWorktreeFn = deps.removeWorktreeFn ?? removeWorktree;
  const diffNameStatusFn = deps.diffNameStatusFn ?? diffNameStatus;
  const isAncestorFn = deps.isAncestorFn ?? isAncestor;
  const computeSourceDiffFn = deps.computeSourceDiffFn ?? computeSourceDiff;
  const makeGraphReader =
    deps.makeGraphReader ??
    ((graphVersionId: ObjectIdString) => new MongoGraphReader(deps.db, graphVersionId));

  const { analysisId, repoId, baseSha, headSha, baseGraphVersionId } = input;
  let overlayGraphVersionId: ObjectIdString | null = null;
  let headWorkDir: string | null = null;

  try {
    // Step 3 (§5.2) — pin the base graph so D3's retention sweep can't delete
    // it out from under this run.
    await graphVersionsCollection(deps.db).updateOne(
      { _id: new ObjectId(baseGraphVersionId) },
      { $addToSet: { pinnedBy: analysisId } },
    );
    await updateAnalysis(deps.db, analysisId, {
      status: 'cloning',
      baseGraphVersionId,
      progress: { step: 'cloning', pct: 5 },
    });

    // Step 4 — worktree at head. For a push, this is also where the
    // force-push check §9.1 deferred to the worker (no git in the API
    // process) finally runs.
    if (input.trigger === 'push') {
      const ancestor = await isAncestorFn(input.workspace.repoPath, baseSha, headSha);
      if (!ancestor) {
        throw new AnalysisFailedError(
          `force-push detected (${baseSha} is not an ancestor of ${headSha}) — skipping`,
        );
      }
    }

    // Absolute, not a relative-string join: this path is also sent to the
    // parser in the POST /v1/parse body (§8's `workspacePath`), and the
    // parser is a *separate process* with its own cwd — a relative path
    // resolves against whatever directory happened to start that process,
    // not this one. Found live (M6 phase 6 field-testing) as a `404
    // workspacePath does not exist` from the parser, matching `runIndex.ts`'s
    // own `path.resolve()` for exactly this reason.
    headWorkDir = path.resolve(deps.config.workspaceRoot, 'work', repoId, headSha);
    await addWorktreeFn(input.workspace.repoPath, headSha, headWorkDir);

    // Step 5 — changed files, mode: "subset" parse.
    const changedFiles = await diffNameStatusFn(
      input.workspace.repoPath,
      baseSha,
      headSha,
    );
    await updateAnalysis(deps.db, analysisId, {
      status: 'parsing',
      progress: { step: 'parsing', pct: 20 },
    });

    const version = await getVersionFn(deps.config.parserUrl);
    const subsetResponse = await postParseFn(deps.config.parserUrl, {
      requestId: randomUUID(),
      repoId,
      sha: headSha,
      workspacePath: headWorkDir,
      mode: 'subset',
      files: changedFiles,
      options: { includeTestSources: false },
    });

    const overlay = await writeOverlayGraphVersion(
      deps.db,
      subsetResponse,
      repoId,
      version.parserVersion,
      Number(version.ruleVersion),
    );
    overlayGraphVersionId = overlay.graphVersionId;
    await updateAnalysis(deps.db, analysisId, {
      overlayGraphVersionId,
      status: 'traversing',
      progress: { step: 'traversing', pct: 40 },
    });

    // Step 6-7 — change detection over the touched files.
    const baseVersions = await loadFunctionVersions(
      deps.db,
      baseGraphVersionId,
      changedFiles,
    );
    const overlayVersions = await loadFunctionVersions(deps.db, overlayGraphVersionId);
    const changes = detectChangedFunctions(
      toFactsMap(baseVersions),
      toFactsMap(overlayVersions),
    );

    const baseReader = makeGraphReader(baseGraphVersionId);
    const overlayReader = makeGraphReader(overlayGraphVersionId);

    // Step 8-9 — one context object + explanation per changed function.
    await updateAnalysis(deps.db, analysisId, {
      status: 'explaining',
      progress: { step: 'explaining', pct: 50 },
    });

    const changedFunctions: AnalysisChangedFunction[] = [];
    for (let i = 0; i < changes.length; i++) {
      const change = changes[i];
      if (change === undefined) continue;

      const baseDoc = baseVersions.get(change.functionKey) ?? null;
      const overlayDoc = overlayVersions.get(change.functionKey) ?? null;
      const filePath = overlayDoc?.filePath ?? baseDoc?.filePath ?? '';

      const sourceDiff =
        filePath === ''
          ? ''
          : await computeSourceDiffFn(
              input.workspace.repoPath,
              baseSha,
              headSha,
              filePath,
              lineRangeOf(baseDoc),
              lineRangeOf(overlayDoc),
            );

      const overlayOutgoingEdges = await overlayReader.outgoingEdges(change.functionKey);
      const baseOutgoingEdges = await baseReader.outgoingEdges(change.functionKey);
      const baseOutgoingTargets = new Set(baseOutgoingEdges.map((e: EdgeDoc) => e.to));

      const contextObject = await buildContextObject(baseReader, {
        repo: {
          owner: input.workspace.owner,
          name: input.workspace.name,
          prNumber: input.prNumber,
        },
        changedFunctionKey: change.functionKey,
        changeKind: change.changeKind,
        baseFacts: baseDoc !== null ? toFunctionFacts(baseDoc) : null,
        headFacts: overlayDoc !== null ? toFunctionFacts(overlayDoc) : null,
        sourceDiff,
        overlayOutgoingEdges,
        baseOutgoingTargets,
        baseUnresolvedRate: input.baseUnresolvedRate,
        parseErrorsInTouchedFiles: subsetResponse.diagnostics.parseErrors.length,
      });

      const { doc: explanationDoc } = await getOrGenerateExplanation(
        deps.explanationStore,
        deps.llmProvider,
        {
          contextObject,
          promptVersion: PROMPT_VERSION,
        },
      );

      changedFunctions.push({
        functionKey: change.functionKey,
        changeKind: change.changeKind,
        contextHash: explanationDoc.contextHash,
        explanationId: explanationDoc._id,
      });

      await updateAnalysis(deps.db, analysisId, {
        changedFunctions,
        progress: {
          step: 'explaining',
          pct: 50 + Math.round(((i + 1) / changes.length) * 45),
        },
      });
    }

    // Step 10.
    await updateAnalysis(deps.db, analysisId, {
      status: 'ready',
      changedFunctions,
      progress: { step: 'ready', pct: 100 },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await updateAnalysis(deps.db, analysisId, { status: 'failed', error: message });
    throw err;
  } finally {
    // Step 11 — always: unpin the base graph, delete the overlay, remove the worktree.
    await graphVersionsCollection(deps.db).updateOne(
      { _id: new ObjectId(baseGraphVersionId) },
      { $pull: { pinnedBy: analysisId } },
    );
    if (overlayGraphVersionId !== null) {
      await deleteOverlayGraphVersion(deps.db, overlayGraphVersionId);
    }
    if (headWorkDir !== null) {
      await removeWorktreeFn(input.workspace.repoPath, headWorkDir);
    }
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface AnalysisPatch {
  status?: AnalysisStatus;
  error?: string;
  baseGraphVersionId?: ObjectIdString;
  overlayGraphVersionId?: ObjectIdString;
  progress?: { step: string; pct: number };
  changedFunctions?: AnalysisChangedFunction[];
}

async function updateAnalysis(
  db: Db,
  analysisId: ObjectIdString,
  patch: AnalysisPatch,
): Promise<void> {
  await analysesCollection(db).updateOne(
    { _id: new ObjectId(analysisId) },
    { $set: { ...patch, updatedAt: new Date() } },
  );
}

function lineRangeOf(doc: FunctionVersionDoc | null): LineRange | null {
  return doc === null ? null : { start: doc.startLine, end: doc.endLine };
}

function toFunctionFacts(doc: FunctionVersionDoc): FunctionFacts {
  return {
    filePath: doc.filePath,
    bodyHash: doc.bodyHash,
    returnType: doc.returnType,
    paramNames: doc.paramNames,
    modifiers: doc.modifiers,
  };
}

function toFactsMap(
  versions: Map<NodeKey, FunctionVersionDoc>,
): Map<NodeKey, FunctionFacts> {
  const map = new Map<NodeKey, FunctionFacts>();
  for (const [key, doc] of versions) map.set(key, toFunctionFacts(doc));
  return map;
}

async function loadFunctionVersions(
  db: Db,
  graphVersionId: ObjectIdString,
  filePaths?: string[],
): Promise<Map<NodeKey, FunctionVersionDoc>> {
  const filter: Record<string, unknown> = { graphVersionId };
  if (filePaths !== undefined) filter.filePath = { $in: filePaths };

  const docs = await functionVersionsCollection(db).find(filter).toArray();
  const map = new Map<NodeKey, FunctionVersionDoc>();
  for (const doc of docs) {
    map.set(doc.functionKey, { ...doc, _id: doc._id.toHexString() });
  }
  return map;
}

async function writeOverlayGraphVersion(
  db: Db,
  response: ParseResponse,
  repoId: ObjectIdString,
  parserVersion: string,
  ruleVersion: number,
): Promise<{ graphVersionId: ObjectIdString }> {
  const stats = computeStats(response, response.diagnostics);
  const now = new Date();
  const inserted = await graphVersionsCollection(db).insertOne({
    _id: new ObjectId(),
    repoId,
    sha: response.sha,
    kind: 'pr_overlay',
    status: 'ready',
    parserVersion,
    ruleVersion,
    stats,
    pinnedBy: [],
    startedAt: now,
    completedAt: now,
  });
  const graphVersionId = inserted.insertedId.toHexString();

  const functionVersionDocs = toFunctionVersionDocs(response, repoId, graphVersionId);
  if (functionVersionDocs.length > 0) {
    await functionVersionsCollection(db).insertMany(
      functionVersionDocs.map((d) => ({ _id: new ObjectId(), ...d })),
    );
  }
  const surfaceDocs = toSurfaceDocs(response, repoId, graphVersionId);
  if (surfaceDocs.length > 0) {
    await surfacesCollection(db).insertMany(
      surfaceDocs.map((d) => ({ _id: new ObjectId(), ...d })),
    );
  }
  const edgeDocs = toEdgeDocs(response, repoId, graphVersionId);
  if (edgeDocs.length > 0) {
    await edgesCollection(db).insertMany(
      edgeDocs.map((d) => ({ _id: new ObjectId(), ...d })),
    );
  }

  return { graphVersionId };
}

/** The overlay is single-use and never pinned — always fully deleted, unlike a branch graph. */
async function deleteOverlayGraphVersion(
  db: Db,
  graphVersionId: ObjectIdString,
): Promise<void> {
  await Promise.all([
    functionVersionsCollection(db).deleteMany({ graphVersionId }),
    surfacesCollection(db).deleteMany({ graphVersionId }),
    edgesCollection(db).deleteMany({ graphVersionId }),
  ]);
  await graphVersionsCollection(db).deleteOne({ _id: new ObjectId(graphVersionId) });
}
