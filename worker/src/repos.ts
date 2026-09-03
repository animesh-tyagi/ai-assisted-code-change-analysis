/**
 * `repos` find-or-create for the M3 CLI trigger.
 *
 * See the "Local repos before the GitHub App exists" note on `RepoDoc` in
 * `@impact/shared` (`shared/src/graph.ts`) and DECISIONS.md: a repo indexed by
 * the CLI, pre-M6, has no GitHub installation, so it gets `provider: 'local'`
 * and a synthetic `githubRepoId` instead of a real one.
 */

import { createHash } from 'node:crypto';

import type { Db } from 'mongodb';

import type { ObjectIdString, RepoDoc } from '@impact/shared';

import { type MongoDoc, reposCollection } from './db/collections.js';

/**
 * Deterministic, negative, never collides with a real (positive) GitHub repo
 * id. Derived from `owner/name`, not the on-disk path, so re-running the CLI
 * from a different checkout of the same repo resolves to the same `repos` doc.
 */
export function syntheticGithubRepoId(owner: string, name: string): number {
  const digest = createHash('sha256').update(`${owner}/${name}`).digest();
  // First 31 bits so the result fits a safe-integer range and stays negative
  // for every possible input, never colliding with a real (positive) id.
  const magnitude = digest.readUInt32BE(0) & 0x7fffffff;
  return -magnitude;
}

export interface ResolveRepoInput {
  owner: string;
  name: string;
  defaultBranch: string;
}

export interface ResolvedRepo {
  repoId: ObjectIdString;
}

export async function resolveRepo(
  db: Db,
  input: ResolveRepoInput,
): Promise<ResolvedRepo> {
  const collection = reposCollection(db);
  const githubRepoId = syntheticGithubRepoId(input.owner, input.name);

  const now = new Date();
  const result = await collection.findOneAndUpdate(
    { provider: 'local', githubRepoId },
    {
      $setOnInsert: {
        provider: 'local',
        githubRepoId,
        owner: input.owner,
        name: input.name,
        defaultBranch: input.defaultBranch,
        installationId: null,
        currentGraphVersionId: null,
        indexingStatus: 'idle',
        lastIndexedSha: null,
        lastIndexedAt: null,
        createdAt: now,
      } satisfies Omit<MongoDoc<RepoDoc>, '_id'>,
    },
    { upsert: true, returnDocument: 'after' },
  );

  if (result === null) {
    throw new Error(
      `resolveRepo: upsert for ${input.owner}/${input.name} returned no document`,
    );
  }

  return { repoId: result._id.toHexString() };
}
