import type { Redis } from 'ioredis';
import type { Db } from 'mongodb';
import { describe, expect, it, vi } from 'vitest';

import type { WorkerConfig } from '../config.js';
import { processIndexJob, type IndexJobDeps } from './indexWorker.js';

const CONFIG: WorkerConfig = {
  mongoUrl: 'mongodb://unused',
  mongoDb: 'unused',
  parserUrl: 'http://unused',
  workspaceRoot: '/data',
  geminiApiKey: '',
  llmModel: 'gemini-3.6-flash',
  redisUrl: 'redis://unused',
  githubAppId: 'app-1',
  githubAppPrivateKey: 'key',
};

function baseDeps(overrides: Partial<IndexJobDeps> = {}): IndexJobDeps {
  return {
    db: {} as Db,
    redis: {} as Redis,
    config: CONFIG,
    authFn: vi.fn(),
    resolveWorkspace: vi.fn().mockResolvedValue({
      repoPath: '/data/repos/repo-1.git',
      owner: 'animesh-tyagi',
      name: 'observability-final',
      defaultBranch: 'main',
    }),
    runIndexFn: vi.fn().mockResolvedValue({
      ok: true,
      repoId: 'repo-1',
      graphVersionId: 'gv-1',
      stats: null,
      error: null,
    }),
    ...overrides,
  };
}

describe('processIndexJob', () => {
  it('resolves the workspace, then runs the index flow with it', async () => {
    const deps = baseDeps();

    await processIndexJob(deps, { repoId: 'repo-1', sha: 'abc123' });

    expect(deps.resolveWorkspace).toHaveBeenCalledWith(
      expect.objectContaining({ workspaceRoot: '/data' }),
      'repo-1',
    );
    expect(deps.runIndexFn).toHaveBeenCalledWith(
      deps.db,
      CONFIG,
      expect.objectContaining({
        repoPath: '/data/repos/repo-1.git',
        sha: 'abc123',
        owner: 'animesh-tyagi',
        name: 'observability-final',
        defaultBranch: 'main',
        repoId: 'repo-1',
        includeTestSources: false,
      }),
    );
  });

  it('throws when the index flow reports failure', async () => {
    const deps = baseDeps({
      runIndexFn: vi.fn().mockResolvedValue({
        ok: false,
        repoId: 'repo-1',
        graphVersionId: null,
        stats: null,
        error: 'parser unreachable',
      }),
    });

    await expect(
      processIndexJob(deps, { repoId: 'repo-1', sha: 'abc123' }),
    ).rejects.toThrow('parser unreachable');
  });

  it('propagates a workspace-resolution failure (e.g. PermanentJobError)', async () => {
    const deps = baseDeps({
      resolveWorkspace: vi.fn().mockRejectedValue(new Error('no installation')),
    });

    await expect(
      processIndexJob(deps, { repoId: 'repo-1', sha: 'abc123' }),
    ).rejects.toThrow('no installation');
    expect(deps.runIndexFn).not.toHaveBeenCalled();
  });
});
