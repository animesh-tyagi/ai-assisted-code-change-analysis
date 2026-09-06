/**
 * `installations` / `repos` upserts driven by webhook payloads (§9.1 step 4).
 *
 * Mirrors `worker/src/repos.ts`'s `resolveRepo` (the CLI's `provider: 'local'`
 * path) but for real GitHub repos: `provider: 'github'`, a real
 * `githubRepoId`, and a real `installationId` pointing at an `installations`
 * document instead of `null`.
 *
 * Known gap, disclosed rather than hidden: `installation` `deleted` and
 * `installation_repositories` `removed` are acknowledged by the webhook route
 * but don't unlink `repos.installationId` here — full installation lifecycle
 * management (suspension, uninstall, repo removal) isn't exercised by
 * BUILD_PLAN Step 6's acceptance criteria and is left for a follow-up.
 */

import type { Db } from 'mongodb';

import type { InstallationDoc, ObjectIdString, RepoDoc } from '@impact/shared';

import {
  type MongoDoc,
  installationsCollection,
  reposCollection,
} from '../db/collections.js';
import type {
  GithubInstallation,
  GithubMinimalRepo,
  GithubRepository,
} from './events.js';
import { parseFullName } from './events.js';

export async function upsertInstallation(
  db: Db,
  installation: GithubInstallation,
): Promise<{ installationId: ObjectIdString }> {
  const now = new Date();
  const result = await installationsCollection(db).findOneAndUpdate(
    { githubInstallationId: installation.id },
    {
      $set: {
        accountLogin: installation.account.login,
        accountType: installation.account.type,
        repositorySelection: installation.repository_selection,
        updatedAt: now,
      },
      $setOnInsert: {
        githubInstallationId: installation.id,
        suspendedAt: null,
        createdAt: now,
      } satisfies Partial<Omit<MongoDoc<InstallationDoc>, '_id'>>,
    },
    { upsert: true, returnDocument: 'after' },
  );

  if (result === null) {
    throw new Error(
      `upsertInstallation: upsert for ${String(installation.id)} returned no document`,
    );
  }

  return { installationId: result._id.toHexString() };
}

/**
 * From `installation`/`installation_repositories`: only `id` and `full_name`
 * are known, so `defaultBranch` is set to `''` on first insert (never
 * overwritten on an existing doc) — self-healed by the first `push` or
 * `pull_request` event for the repo, which carries the full repository object.
 */
export async function upsertRepoMinimal(
  db: Db,
  repo: GithubMinimalRepo,
  installationId: ObjectIdString,
): Promise<void> {
  const { owner, name } = parseFullName(repo.full_name);
  const now = new Date();

  await reposCollection(db).updateOne(
    { provider: 'github', githubRepoId: repo.id },
    {
      $set: { owner, name, installationId },
      $setOnInsert: {
        provider: 'github',
        githubRepoId: repo.id,
        defaultBranch: '',
        currentGraphVersionId: null,
        indexingStatus: 'idle',
        lastIndexedSha: null,
        lastIndexedAt: null,
        createdAt: now,
      } satisfies Partial<Omit<MongoDoc<RepoDoc>, '_id'>>,
    },
    { upsert: true },
  );
}

/**
 * From `push`/`pull_request`: the full repository object, including
 * `default_branch` — this is the source of truth for it, and always
 * overwrites (self-healing the `''` placeholder `upsertRepoMinimal` may have
 * left behind).
 */
export async function upsertRepoFull(
  db: Db,
  repo: GithubRepository,
  installationId: ObjectIdString | null,
): Promise<{ repoId: ObjectIdString }> {
  const now = new Date();

  // `installationId` is always in `$set`, never `$setOnInsert` — MongoDB
  // rejects an update where the same field is targeted by two operators.
  const result = await reposCollection(db).findOneAndUpdate(
    { provider: 'github', githubRepoId: repo.id },
    {
      $set: {
        owner: repo.owner.login,
        name: repo.name,
        defaultBranch: repo.default_branch,
        installationId,
      } satisfies Partial<Omit<MongoDoc<RepoDoc>, '_id'>>,
      $setOnInsert: {
        provider: 'github',
        githubRepoId: repo.id,
        currentGraphVersionId: null,
        indexingStatus: 'idle',
        lastIndexedSha: null,
        lastIndexedAt: null,
        createdAt: now,
      } satisfies Partial<Omit<MongoDoc<RepoDoc>, '_id'>>,
    },
    { upsert: true, returnDocument: 'after' },
  );

  if (result === null) {
    throw new Error(`upsertRepoFull: upsert for ${repo.full_name} returned no document`);
  }

  return { repoId: result._id.toHexString() };
}
