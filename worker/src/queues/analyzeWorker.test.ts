import { DelayedError } from 'bullmq';
import { ObjectId } from 'mongodb';
import { describe, expect, it, vi } from 'vitest';

import type { WorkerConfig } from '../config.js';
import {
  BaseGraphNeverIndexedError,
  type DelayableJob,
} from '../analyzeFlow/resolveBaseGraph.js';
import { createFakeDb } from '../testUtils/fakeDb.js';
import { PermanentJobError } from './backoff.js';
import { processAnalyzeJob, type AnalyzeJobDeps } from './analyzeWorker.js';

const CONFIG: WorkerConfig = {
  mongoUrl: 'mongodb://unused',
  mongoDb: 'unused',
  parserUrl: 'http://unused',
  workspaceRoot: '/data',
  geminiApiKey: '',
  llmModel: 'gemini-3.6-flash',
  redisUrl: 'redis://unused',
  githubAppId: '',
  githubAppPrivateKey: '',
};

function fakeJob(analysisId: string): DelayableJob & { data: { analysisId: string } } {
  return {
    timestamp: Date.now(),
    moveToDelayed: vi.fn().mockResolvedValue(undefined),
    data: { analysisId },
  };
}

function baseDeps(overrides: Partial<AnalyzeJobDeps> = {}): AnalyzeJobDeps {
  return {
    db: {} as never,
    redis: {} as never,
    config: CONFIG,
    authFn: vi.fn(),
    llmProvider: { model: 'fake', generate: vi.fn(), repair: vi.fn() },
    explanationStore: { find: vi.fn(), save: vi.fn() },
    queues: { index: {} as never, analyze: {} as never, close: vi.fn() },
    resolveWorkspace: vi.fn().mockResolvedValue({
      repoPath: '/data/repos/repo-1.git',
      owner: 'animesh-tyagi',
      name: 'observability-final',
      defaultBranch: 'main',
    }),
    resolveBaseGraphFn: vi.fn().mockResolvedValue({
      _id: 'base-gv-1',
      repoId: 'repo-1',
      sha: 'a'.repeat(40),
      kind: 'branch',
      status: 'ready',
      parserVersion: '1.0.0',
      ruleVersion: 1,
      stats: {
        functions: 1,
        edges: 0,
        surfaces: 0,
        unresolvedRate: 0.05,
        nonExternalUnresolvedRate: 0,
        externalCalls: 0,
        parseErrors: 0,
      },
      pinnedBy: [],
      startedAt: new Date(),
      completedAt: new Date(),
    }),
    runAnalyzeFn: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

describe('processAnalyzeJob', () => {
  it('skips a superseded analysis without touching the base graph or workspace', async () => {
    const fakeDb = createFakeDb();
    const analysisId = new ObjectId();
    await fakeDb.collection('analyses').insertOne({
      _id: analysisId,
      repoId: 'repo-1',
      trigger: 'push',
      baseSha: 'a'.repeat(40),
      headSha: 'b'.repeat(40),
      status: 'superseded',
      changedFunctions: [],
    });

    const deps = baseDeps({ db: fakeDb.db });
    await processAnalyzeJob(deps, fakeJob(analysisId.toHexString()), 'token');

    expect(deps.resolveBaseGraphFn).not.toHaveBeenCalled();
    expect(deps.resolveWorkspace).not.toHaveBeenCalled();
    expect(deps.runAnalyzeFn).not.toHaveBeenCalled();
  });

  it('throws PermanentJobError when the analysis doc does not exist', async () => {
    const fakeDb = createFakeDb();
    const deps = baseDeps({ db: fakeDb.db });

    await expect(
      processAnalyzeJob(deps, fakeJob(new ObjectId().toHexString()), 'token'),
    ).rejects.toBeInstanceOf(PermanentJobError);
  });

  it('marks the analysis failed and throws PermanentJobError when the base graph was never indexed', async () => {
    const fakeDb = createFakeDb();
    const analysisId = new ObjectId();
    await fakeDb.collection('analyses').insertOne({
      _id: analysisId,
      repoId: 'repo-1',
      trigger: 'push',
      baseSha: 'a'.repeat(40),
      headSha: 'b'.repeat(40),
      status: 'queued',
      changedFunctions: [],
    });

    const deps = baseDeps({
      db: fakeDb.db,
      resolveBaseGraphFn: vi
        .fn()
        .mockRejectedValue(new BaseGraphNeverIndexedError('never indexed')),
    });

    await expect(
      processAnalyzeJob(deps, fakeJob(analysisId.toHexString()), 'token'),
    ).rejects.toBeInstanceOf(PermanentJobError);

    const analysis = fakeDb.collection('analyses').all()[0];
    expect(analysis?.status).toBe('failed');
    expect(analysis?.error).toBe('never indexed');
    expect(deps.resolveWorkspace).not.toHaveBeenCalled();
  });

  it('propagates a DelayedError from resolveBaseGraph without marking the analysis failed', async () => {
    const fakeDb = createFakeDb();
    const analysisId = new ObjectId();
    await fakeDb.collection('analyses').insertOne({
      _id: analysisId,
      repoId: 'repo-1',
      trigger: 'push',
      baseSha: 'a'.repeat(40),
      headSha: 'b'.repeat(40),
      status: 'queued',
      changedFunctions: [],
    });

    const deps = baseDeps({
      db: fakeDb.db,
      resolveBaseGraphFn: vi.fn().mockRejectedValue(new DelayedError()),
    });

    await expect(
      processAnalyzeJob(deps, fakeJob(analysisId.toHexString()), 'token'),
    ).rejects.toBeInstanceOf(DelayedError);

    const analysis = fakeDb.collection('analyses').all()[0];
    expect(analysis?.status).toBe('queued'); // untouched — waiting is not a failure
  });

  it('resolves the workspace and runs the analyze flow once the base graph is ready', async () => {
    const fakeDb = createFakeDb();
    const analysisId = new ObjectId();
    await fakeDb.collection('analyses').insertOne({
      _id: analysisId,
      repoId: 'repo-1',
      trigger: 'pull_request',
      prNumber: 7,
      baseSha: 'a'.repeat(40),
      headSha: 'b'.repeat(40),
      status: 'queued',
      changedFunctions: [],
    });

    const deps = baseDeps({ db: fakeDb.db });
    await processAnalyzeJob(deps, fakeJob(analysisId.toHexString()), 'token');

    expect(deps.resolveWorkspace).toHaveBeenCalledWith(expect.anything(), 'repo-1');
    expect(deps.runAnalyzeFn).toHaveBeenCalledWith(
      expect.objectContaining({ db: fakeDb.db, config: CONFIG }),
      expect.objectContaining({
        analysisId: analysisId.toHexString(),
        repoId: 'repo-1',
        trigger: 'pull_request',
        prNumber: 7,
        baseGraphVersionId: 'base-gv-1',
        baseUnresolvedRate: 0.05,
        workspace: {
          repoPath: '/data/repos/repo-1.git',
          owner: 'animesh-tyagi',
          name: 'observability-final',
        },
      }),
    );
  });
});
