/**
 * The index flow (ARCHITECTURE §5.1), `mode: "full"` only — a manually-triggered
 * CLI run, no webhook/queue (BUILD_PLAN Step 3). Builds a `graphVersion`
 * `building` → bulk-inserts stamped rows → flips `repos.currentGraphVersionId`
 * (the atomic swap, D3) → prunes the previous version, respecting `pinnedBy`
 * (§9.5 — always empty pre-M6, so pruning always proceeds).
 */

import { randomUUID } from 'node:crypto';
import path from 'node:path';

import type { Db } from 'mongodb';

import type { GraphVersionStats, ObjectIdString } from '@impact/shared';

import type { WorkerConfig } from '../config.js';
import {
  edgesCollection,
  functionVersionsCollection,
  functionsCollection,
  graphVersionsCollection,
  ObjectId,
  reposCollection,
  surfacesCollection,
} from '../db/collections.js';
import { addWorktree, removeWorktree } from '../git/worktree.js';
import { getVersion, postParse } from '../parser/client.js';
import { resolveRepo } from '../repos.js';
import {
  computeStats,
  toEdgeDocs,
  toFunctionUpserts,
  toFunctionVersionDocs,
  toSurfaceDocs,
} from './mappers.js';

export interface RunIndexInput {
  repoPath: string;
  sha: string;
  owner: string;
  name: string;
  defaultBranch: string;
  includeTestSources: boolean;
}

export interface RunIndexResult {
  ok: boolean;
  repoId: ObjectIdString;
  graphVersionId: ObjectIdString | null;
  stats: GraphVersionStats | null;
  error: string | null;
}

export async function runIndex(
  db: Db,
  config: WorkerConfig,
  input: RunIndexInput,
): Promise<RunIndexResult> {
  const { repoId } = await resolveRepo(db, {
    owner: input.owner,
    name: input.name,
    defaultBranch: input.defaultBranch,
  });

  // Fail fast, before any git or Mongo write, if the parser is unreachable.
  const version = await getVersion(config.parserUrl);

  await deleteExistingGraphVersion(db, repoId, input.sha);

  const workDir = path.resolve(config.workspaceRoot, repoId, input.sha);
  await addWorktree(input.repoPath, input.sha, workDir);

  try {
    const graphVersionsResult = await graphVersionsCollection(db).insertOne({
      _id: new ObjectId(),
      repoId,
      sha: input.sha,
      kind: 'branch',
      status: 'building',
      parserVersion: version.parserVersion,
      ruleVersion: Number(version.ruleVersion),
      stats: {
        functions: 0,
        edges: 0,
        surfaces: 0,
        unresolvedRate: 0,
        nonExternalUnresolvedRate: 0,
        externalCalls: 0,
        parseErrors: 0,
      },
      pinnedBy: [],
      startedAt: new Date(),
      completedAt: null,
    });
    const graphVersionId = graphVersionsResult.insertedId.toHexString();

    let response;
    try {
      response = await postParse(config.parserUrl, {
        requestId: randomUUID(),
        repoId,
        sha: input.sha,
        workspacePath: workDir,
        mode: 'full',
        files: [],
        options: { includeTestSources: input.includeTestSources },
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await graphVersionsCollection(db).updateOne(
        { _id: graphVersionsResult.insertedId },
        { $set: { status: 'failed', error: message, completedAt: new Date() } },
      );
      return { ok: false, repoId, graphVersionId, stats: null, error: message };
    }

    const functionUpserts = toFunctionUpserts(response, repoId, new Date());
    if (functionUpserts.length > 0) {
      await functionsCollection(db).bulkWrite(
        functionUpserts.map((u) => ({
          updateOne: {
            filter: u.filter,
            update: { $setOnInsert: u.setOnInsert, $set: u.set },
            upsert: true,
          },
        })),
        { ordered: false },
      );
    }

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

    const stats = computeStats(response, response.diagnostics);

    // Mark ready before the pointer swap — a reader keyed off
    // `repos.currentGraphVersionId` must never observe a `building` version.
    await graphVersionsCollection(db).updateOne(
      { _id: graphVersionsResult.insertedId },
      { $set: { status: 'ready', stats, completedAt: new Date() } },
    );

    // The atomic swap (D3).
    await reposCollection(db).updateOne(
      { _id: new ObjectId(repoId) },
      {
        $set: {
          currentGraphVersionId: graphVersionId,
          indexingStatus: 'ready',
          lastIndexedSha: input.sha,
          lastIndexedAt: new Date(),
        },
      },
    );

    await pruneSuperseded(db, repoId, graphVersionsResult.insertedId.toHexString());

    return { ok: true, repoId, graphVersionId, stats, error: null };
  } finally {
    await removeWorktree(input.repoPath, workDir);
  }
}

/**
 * Dev-loop idempotency: re-indexing the exact same `{repoId, sha, kind}` (e.g.
 * after fixing a bug in this code and re-running against the same commit)
 * would otherwise collide with the `graphVersions` unique index. Delete any
 * prior attempt at that exact tuple first — `functions` (permanent identity,
 * D5) is never touched.
 */
async function deleteExistingGraphVersion(
  db: Db,
  repoId: ObjectIdString,
  sha: string,
): Promise<void> {
  const existing = await graphVersionsCollection(db).findOne({
    repoId,
    sha,
    kind: 'branch',
  });
  if (existing === null) return;
  await deleteGraphVersionRows(db, existing._id.toHexString());
  await graphVersionsCollection(db).deleteOne({ _id: existing._id });
}

/** Retention (§9.5): current + in-progress only, respecting `pinnedBy`. */
async function pruneSuperseded(
  db: Db,
  repoId: ObjectIdString,
  currentGraphVersionId: ObjectIdString,
): Promise<void> {
  const others = await graphVersionsCollection(db)
    .find({
      repoId,
      _id: { $ne: new ObjectId(currentGraphVersionId) },
      status: { $ne: 'building' },
    })
    .toArray();

  for (const gv of others) {
    const graphVersionId = gv._id.toHexString();
    if (gv.pinnedBy.length === 0) {
      await deleteGraphVersionRows(db, graphVersionId);
      await graphVersionsCollection(db).deleteOne({ _id: gv._id });
    } else {
      await graphVersionsCollection(db).updateOne(
        { _id: gv._id },
        { $set: { status: 'superseded' } },
      );
    }
  }
}

async function deleteGraphVersionRows(
  db: Db,
  graphVersionId: ObjectIdString,
): Promise<void> {
  await Promise.all([
    functionVersionsCollection(db).deleteMany({ graphVersionId }),
    surfacesCollection(db).deleteMany({ graphVersionId }),
    edgesCollection(db).deleteMany({ graphVersionId }),
  ]);
}
