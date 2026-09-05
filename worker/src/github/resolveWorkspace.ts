/**
 * Resolves a `provider: 'github'` repo to a ready-to-worktree-from cache
 * clone: look up the repo and its installation, mint a short-lived
 * installation token, and `ensureCacheClone` under the per-repo lock so the
 * `index` and `analyze` queues never race each other over the same on-disk
 * clone (§9.2). Used by `indexWorker.ts` (M6 Phase 3) and, later, the
 * analyze flow (M6 Phase 4) — both need the identical "get me a fresh clone
 * of this repo" step before they diverge into full vs. subset parsing.
 */

import path from 'node:path';

import type { Redis } from 'ioredis';
import type { Db } from 'mongodb';

import type { ObjectIdString } from '@impact/shared';

import { ObjectId, installationsCollection, reposCollection } from '../db/collections.js';
import { ensureCacheClone } from '../git/clone.js';
import { PermanentJobError } from '../queues/backoff.js';
import { withRepoLock } from '../queues/repoLock.js';
import type { InstallationAuthFn } from './appAuth.js';
import { mintInstallationToken } from './appAuth.js';

export interface ResolvedGithubWorkspace {
  repoPath: string;
  owner: string;
  name: string;
  defaultBranch: string;
}

export interface ResolveGithubWorkspaceDeps {
  db: Db;
  redis: Redis;
  authFn: InstallationAuthFn;
  workspaceRoot: string;
  /** Injectable for tests — defaults to the real `ensureCacheClone`. */
  cloneRepo?: typeof ensureCacheClone;
}

export function cacheClonePath(workspaceRoot: string, repoId: ObjectIdString): string {
  return path.resolve(workspaceRoot, 'repos', `${repoId}.git`);
}

export async function resolveGithubWorkspace(
  deps: ResolveGithubWorkspaceDeps,
  repoId: ObjectIdString,
): Promise<ResolvedGithubWorkspace> {
  const repo = await reposCollection(deps.db).findOne({ _id: new ObjectId(repoId) });
  if (repo === null) {
    throw new PermanentJobError(`resolveGithubWorkspace: repo ${repoId} not found`);
  }
  if (repo.provider !== 'github') {
    throw new PermanentJobError(
      `resolveGithubWorkspace: repo ${repoId} has provider '${repo.provider}', not 'github'`,
    );
  }
  if (repo.installationId === null) {
    throw new PermanentJobError(
      `resolveGithubWorkspace: repo ${repoId} has no installation`,
    );
  }

  const installation = await installationsCollection(deps.db).findOne({
    _id: new ObjectId(repo.installationId),
  });
  if (installation === null) {
    throw new PermanentJobError(
      `resolveGithubWorkspace: installation ${repo.installationId} not found`,
    );
  }

  const cachePath = cacheClonePath(deps.workspaceRoot, repoId);
  const clone = deps.cloneRepo ?? ensureCacheClone;

  await withRepoLock(deps.redis, repoId, async () => {
    const token = await mintInstallationToken(
      deps.redis,
      deps.authFn,
      installation.githubInstallationId,
    );
    await clone(repo.owner, repo.name, token, cachePath);
  });

  return {
    repoPath: cachePath,
    owner: repo.owner,
    name: repo.name,
    defaultBranch: repo.defaultBranch,
  };
}
