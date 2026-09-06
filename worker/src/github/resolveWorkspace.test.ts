import type { Redis } from 'ioredis';
import { ObjectId } from 'mongodb';
import { describe, expect, it, vi } from 'vitest';

import { FakeRedis } from '../testUtils/fakeRedis.js';
import { createFakeDb } from '../testUtils/fakeDb.js';
import { PermanentJobError } from '../queues/backoff.js';
import { cacheClonePath, resolveGithubWorkspace } from './resolveWorkspace.js';

function fakeRedis(): Redis {
  return new FakeRedis() as unknown as Redis;
}

describe('resolveGithubWorkspace', () => {
  it('mints a token and clones once, releasing the lock afterward', async () => {
    const fakeDb = createFakeDb();
    const installationId = new ObjectId();
    await fakeDb.collection('installations').insertOne({
      _id: installationId,
      githubInstallationId: 555,
    });
    const repoId = new ObjectId();
    await fakeDb.collection('repos').insertOne({
      _id: repoId,
      provider: 'github',
      owner: 'animesh-tyagi',
      name: 'observability-final',
      defaultBranch: 'main',
      installationId: installationId.toHexString(),
    });

    const authFn = vi.fn().mockResolvedValue({ token: 'tok-abc' });
    const cloneRepo = vi.fn().mockResolvedValue(undefined);

    const workspace = await resolveGithubWorkspace(
      {
        db: fakeDb.db,
        redis: fakeRedis(),
        authFn,
        workspaceRoot: '/data',
        cloneRepo,
      },
      repoId.toHexString(),
    );

    expect(workspace).toEqual({
      repoPath: cacheClonePath('/data', repoId.toHexString()),
      owner: 'animesh-tyagi',
      name: 'observability-final',
      defaultBranch: 'main',
    });
    expect(cloneRepo).toHaveBeenCalledWith(
      'animesh-tyagi',
      'observability-final',
      'tok-abc',
      cacheClonePath('/data', repoId.toHexString()),
    );

    // The lock must have been released — a second resolve for the same repo
    // should proceed without blocking.
    await resolveGithubWorkspace(
      { db: fakeDb.db, redis: fakeRedis(), authFn, workspaceRoot: '/data', cloneRepo },
      repoId.toHexString(),
    );
  });

  it('throws PermanentJobError when the repo does not exist', async () => {
    const fakeDb = createFakeDb();
    await expect(
      resolveGithubWorkspace(
        {
          db: fakeDb.db,
          redis: fakeRedis(),
          authFn: vi.fn(),
          workspaceRoot: '/data',
        },
        new ObjectId().toHexString(),
      ),
    ).rejects.toBeInstanceOf(PermanentJobError);
  });

  it('throws PermanentJobError for a provider: local repo', async () => {
    const fakeDb = createFakeDb();
    const repoId = new ObjectId();
    await fakeDb.collection('repos').insertOne({
      _id: repoId,
      provider: 'local',
      owner: 'local',
      name: 'observability-final',
      defaultBranch: 'main',
      installationId: null,
    });

    await expect(
      resolveGithubWorkspace(
        { db: fakeDb.db, redis: fakeRedis(), authFn: vi.fn(), workspaceRoot: '/data' },
        repoId.toHexString(),
      ),
    ).rejects.toBeInstanceOf(PermanentJobError);
  });

  it('throws PermanentJobError when the installation is missing', async () => {
    const fakeDb = createFakeDb();
    const repoId = new ObjectId();
    await fakeDb.collection('repos').insertOne({
      _id: repoId,
      provider: 'github',
      owner: 'animesh-tyagi',
      name: 'observability-final',
      defaultBranch: 'main',
      installationId: new ObjectId().toHexString(), // no matching installations doc
    });

    await expect(
      resolveGithubWorkspace(
        { db: fakeDb.db, redis: fakeRedis(), authFn: vi.fn(), workspaceRoot: '/data' },
        repoId.toHexString(),
      ),
    ).rejects.toBeInstanceOf(PermanentJobError);
  });
});
