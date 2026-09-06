import { DelayedError } from 'bullmq';
import { ObjectId } from 'mongodb';
import { describe, expect, it, vi } from 'vitest';

import { createFakeDb } from '../testUtils/fakeDb.js';
import {
  BaseGraphNeverIndexedError,
  resolveBaseGraph,
  type DelayableJob,
} from './resolveBaseGraph.js';

function fakeJob(overrides: Partial<DelayableJob> = {}): DelayableJob {
  return {
    timestamp: Date.now(),
    moveToDelayed: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

describe('resolveBaseGraph', () => {
  it('returns the graph immediately when it is already ready', async () => {
    const fakeDb = createFakeDb();
    await fakeDb.collection('graphVersions').insertOne({
      _id: new ObjectId(),
      repoId: 'repo-1',
      sha: 'base-sha',
      kind: 'branch',
      status: 'ready',
    });
    const enqueueIndex = vi.fn();

    const result = await resolveBaseGraph(
      fakeDb.db,
      { enqueueIndex },
      fakeJob(),
      'token',
      'repo-1',
      'base-sha',
    );

    expect(result.status).toBe('ready');
    expect(enqueueIndex).not.toHaveBeenCalled();
  });

  it('treats a superseded-but-present version as usable (still pinned by someone else)', async () => {
    const fakeDb = createFakeDb();
    await fakeDb.collection('graphVersions').insertOne({
      _id: new ObjectId(),
      repoId: 'repo-1',
      sha: 'base-sha',
      kind: 'branch',
      status: 'superseded',
    });

    const result = await resolveBaseGraph(
      fakeDb.db,
      { enqueueIndex: vi.fn() },
      fakeJob(),
      'token',
      'repo-1',
      'base-sha',
    );
    expect(result.status).toBe('superseded');
  });

  it('enqueues an index job and delays itself when the base graph is missing', async () => {
    const fakeDb = createFakeDb();
    const enqueueIndex = vi.fn();
    const job = fakeJob();

    await expect(
      resolveBaseGraph(fakeDb.db, { enqueueIndex }, job, 'token', 'repo-1', 'base-sha'),
    ).rejects.toBeInstanceOf(DelayedError);

    expect(enqueueIndex).toHaveBeenCalledWith('index:repo-1:base-sha', {
      repoId: 'repo-1',
      sha: 'base-sha',
    });
    expect(job.moveToDelayed).toHaveBeenCalledWith(expect.any(Number), 'token');
  });

  it('does not re-enqueue while a base index is already building', async () => {
    const fakeDb = createFakeDb();
    await fakeDb.collection('graphVersions').insertOne({
      _id: new ObjectId(),
      repoId: 'repo-1',
      sha: 'base-sha',
      kind: 'branch',
      status: 'building',
    });
    const enqueueIndex = vi.fn();

    await expect(
      resolveBaseGraph(
        fakeDb.db,
        { enqueueIndex },
        fakeJob(),
        'token',
        'repo-1',
        'base-sha',
      ),
    ).rejects.toBeInstanceOf(DelayedError);
    expect(enqueueIndex).not.toHaveBeenCalled();
  });

  it('re-enqueues when a prior index attempt failed', async () => {
    const fakeDb = createFakeDb();
    await fakeDb.collection('graphVersions').insertOne({
      _id: new ObjectId(),
      repoId: 'repo-1',
      sha: 'base-sha',
      kind: 'branch',
      status: 'failed',
    });
    const enqueueIndex = vi.fn();

    await expect(
      resolveBaseGraph(
        fakeDb.db,
        { enqueueIndex },
        fakeJob(),
        'token',
        'repo-1',
        'base-sha',
      ),
    ).rejects.toBeInstanceOf(DelayedError);
    expect(enqueueIndex).toHaveBeenCalled();
  });

  it('fails with BaseGraphNeverIndexedError once the wait budget is exhausted', async () => {
    const fakeDb = createFakeDb();
    const job = fakeJob({ timestamp: Date.now() - 11 * 60 * 1000 }); // 11 minutes ago

    await expect(
      resolveBaseGraph(
        fakeDb.db,
        { enqueueIndex: vi.fn() },
        job,
        'token',
        'repo-1',
        'base-sha',
      ),
    ).rejects.toBeInstanceOf(BaseGraphNeverIndexedError);
    expect(job.moveToDelayed).not.toHaveBeenCalled();
  });
});
