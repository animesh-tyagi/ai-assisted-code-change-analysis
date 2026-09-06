import path from 'node:path';

import { ObjectId } from 'mongodb';
import { describe, expect, it, vi } from 'vitest';

import type { ContextObject, ParseResponseWire } from '@impact/shared';

import type { WorkerConfig } from '../config.js';
import { InMemoryExplanationStore } from '../llm/inMemoryExplanationStore.js';
import type { LLMProvider } from '../llm/provider.js';
import { InMemoryGraphReader } from '../traversal/inMemoryGraphReader.js';
import { createFakeDb, type FakeDb } from '../testUtils/fakeDb.js';
import {
  AnalysisFailedError,
  runAnalyze,
  type RunAnalyzeDeps,
  type RunAnalyzeInput,
} from './runAnalyze.js';

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

const FN_KEY = 'fn:com.acme.Foo#bar()';

function fakeLLMProvider(): LLMProvider {
  const respond = (ctx: ContextObject) => ({
    sections: {
      whatChanged: `${ctx.changedMethod.displayName} changed.`,
      whoIsAffected: `${String(ctx.affectedBy.directCallerTotal)} callers.`,
      whatToCheck: 'Check the callers.',
    },
    raw: '{}',
    usage: { inputTokens: 0, outputTokens: 0 },
  });
  return {
    model: 'fake-model',
    generate: async (ctx) => Promise.resolve(respond(ctx)),
    repair: async (ctx) => Promise.resolve(respond(ctx)),
  };
}

function subsetParseResponse(headSha: string, bodyHash: string): ParseResponseWire {
  return {
    requestId: 'req-1',
    sha: headSha,
    mode: 'subset',
    sourceRoots: ['src/main/java'],
    functions: [
      {
        key: FN_KEY,
        fqcn: 'com.acme.Foo',
        className: 'Foo',
        methodName: 'bar',
        paramTypes: [],
        paramNames: [],
        returnType: 'void',
        filePath: 'Foo.java',
        startLine: 10,
        endLine: 22,
        bodyHash,
        modifiers: ['public'],
        annotations: [],
        isAbstract: false,
        isInterfaceMethod: false,
        unresolvedParamTypes: 0,
      },
    ],
    surfaces: [],
    edges: [],
    diagnostics: {
      durationMs: 1,
      filesParsed: 1,
      parseErrors: [],
      totalEdges: 0,
      unresolvedEdges: 0,
      unresolvedRate: 0,
      nonExternalUnresolvedRate: 0,
      externalCalls: 0,
      unresolvedParamTypes: 0,
      ambiguousOverloads: [],
      failedDeclarations: 0,
      guardedFailures: 0,
      targetsMissingFromIndex: 0,
    },
  };
}

interface Fixture {
  fakeDb: FakeDb;
  input: RunAnalyzeInput;
  deps: RunAnalyzeDeps;
}

async function buildFixture(overrides: Partial<RunAnalyzeInput> = {}): Promise<Fixture> {
  const fakeDb = createFakeDb();
  const baseGraphVersionObjectId = new ObjectId();
  const baseGraphVersionId = baseGraphVersionObjectId.toHexString();
  const analysisObjectId = new ObjectId();
  const analysisId = analysisObjectId.toHexString();
  const repoId = new ObjectId().toHexString();
  const baseSha = 'a'.repeat(40);
  const headSha = 'b'.repeat(40);

  await fakeDb.collection('graphVersions').insertOne({
    _id: baseGraphVersionObjectId,
    repoId,
    sha: baseSha,
    kind: 'branch',
    status: 'ready',
    parserVersion: '1.0.0',
    ruleVersion: 1,
    stats: {
      functions: 1,
      edges: 0,
      surfaces: 0,
      unresolvedRate: 0.1,
      nonExternalUnresolvedRate: 0,
      externalCalls: 0,
      parseErrors: 0,
    },
    pinnedBy: [],
    startedAt: new Date(),
    completedAt: new Date(),
  });

  await fakeDb.collection('functionVersions').insertOne({
    _id: new ObjectId(),
    repoId,
    graphVersionId: baseGraphVersionId,
    functionKey: FN_KEY,
    sha: baseSha,
    filePath: 'Foo.java',
    startLine: 10,
    endLine: 20,
    bodyHash: 'hash-base',
    returnType: 'void',
    paramNames: [],
    modifiers: ['public'],
    annotations: [],
    isAbstract: false,
    isInterfaceMethod: false,
  });

  await fakeDb.collection('analyses').insertOne({
    _id: analysisObjectId,
    repoId,
    trigger: 'pull_request',
    prNumber: 42,
    baseSha,
    headSha,
    baseGraphVersionId: null,
    overlayGraphVersionId: null,
    deliveryId: 'delivery-1',
    jobId: 'job-1',
    status: 'queued',
    progress: { step: 'queued', pct: 0 },
    changedFunctions: [],
    createdAt: new Date(),
    updatedAt: new Date(),
  });

  const input: RunAnalyzeInput = {
    analysisId,
    repoId,
    baseSha,
    headSha,
    trigger: 'pull_request',
    prNumber: 42,
    baseGraphVersionId,
    baseUnresolvedRate: 0.1,
    workspace: {
      repoPath: '/data/repos/repo-1.git',
      owner: 'animesh-tyagi',
      name: 'observability-final',
    },
    ...overrides,
  };

  const deps: RunAnalyzeDeps = {
    db: fakeDb.db,
    config: CONFIG,
    llmProvider: fakeLLMProvider(),
    explanationStore: new InMemoryExplanationStore(),
    postParseFn: vi.fn().mockResolvedValue(subsetParseResponse(headSha, 'hash-head')),
    getVersionFn: vi.fn().mockResolvedValue({
      parserVersion: '1.0.0',
      ruleVersion: '1',
      javaParserVersion: '3.x',
    }),
    addWorktreeFn: vi.fn().mockResolvedValue(undefined),
    removeWorktreeFn: vi.fn().mockResolvedValue(undefined),
    diffNameStatusFn: vi.fn().mockResolvedValue(['Foo.java']),
    isAncestorFn: vi.fn().mockResolvedValue(true),
    computeSourceDiffFn: vi.fn().mockResolvedValue('@@ -10,11 +10,13 @@\n-old\n+new'),
    makeGraphReader: (graphVersionId: string) =>
      graphVersionId === baseGraphVersionId
        ? new InMemoryGraphReader([], [])
        : new InMemoryGraphReader([], []),
  };

  return { fakeDb, input, deps };
}

describe('runAnalyze', () => {
  it('detects the modified function, generates an explanation, and marks the analysis ready', async () => {
    const { fakeDb, input, deps } = await buildFixture();

    await runAnalyze(deps, input);

    const analyses = fakeDb.collection('analyses').all();
    expect(analyses).toHaveLength(1);
    const analysis = analyses[0];
    expect(analysis).toMatchObject({ status: 'ready' });
    expect(analysis?.progress).toMatchObject({ step: 'ready', pct: 100 });
    expect(analysis?.changedFunctions).toHaveLength(1);
    expect(
      (analysis?.changedFunctions as { functionKey: string }[])[0]?.functionKey,
    ).toBe(FN_KEY);

    // The base graph must be unpinned again once the run finishes (step 11).
    const graphVersions = fakeDb.collection('graphVersions').all();
    const baseGv = graphVersions.find(
      (gv) =>
        gv._id instanceof ObjectId && gv._id.toHexString() === input.baseGraphVersionId,
    );
    expect(baseGv?.pinnedBy).toEqual([]);

    // The overlay is single-use and must be fully cleaned up.
    expect(fakeDb.collection('functionVersions').all()).toHaveLength(1); // only the base row remains
    expect(graphVersions).toHaveLength(1); // only the base graphVersion remains

    expect(deps.removeWorktreeFn).toHaveBeenCalledTimes(1);
  });

  it('uses an absolute workspace path, not a relative-string join', async () => {
    // Regression guard: the parser is a *separate process*. A relative path
    // (e.g. `${workspaceRoot}/work/...` built by string concatenation)
    // resolves against whichever directory happened to start the parser,
    // not this one — the parser then 404s with "workspacePath does not
    // exist" (found live, M6 phase 6 field-testing).
    const { input, deps } = await buildFixture();

    await runAnalyze(deps, input);

    const [, , workDirArg] = (deps.addWorktreeFn as ReturnType<typeof vi.fn>).mock
      .calls[0] as [string, string, string];
    expect(path.isAbsolute(workDirArg)).toBe(true);

    const [, parseRequest] = (deps.postParseFn as ReturnType<typeof vi.fn>).mock
      .calls[0] as [string, { workspacePath: string }];
    expect(path.isAbsolute(parseRequest.workspacePath)).toBe(true);
    expect(parseRequest.workspacePath).toBe(workDirArg);
  });

  it('pins the base graph for the duration of the run', async () => {
    const { fakeDb, input, deps } = await buildFixture();

    let pinnedDuringRun = false;
    const originalPostParse = deps.postParseFn;
    deps.postParseFn = vi.fn(
      async (...args: Parameters<NonNullable<typeof originalPostParse>>) => {
        const graphVersions = fakeDb.collection('graphVersions').all();
        const baseGv = graphVersions.find(
          (gv) =>
            gv._id instanceof ObjectId &&
            gv._id.toHexString() === input.baseGraphVersionId,
        );
        pinnedDuringRun =
          Array.isArray(baseGv?.pinnedBy) && baseGv.pinnedBy.includes(input.analysisId);
        return originalPostParse !== undefined
          ? originalPostParse(...args)
          : subsetParseResponse(input.headSha, 'hash-head');
      },
    );

    await runAnalyze(deps, input);
    expect(pinnedDuringRun).toBe(true);
  });

  it('fails cleanly on a force-push (push trigger, base not an ancestor of head)', async () => {
    const { fakeDb, input, deps } = await buildFixture({
      trigger: 'push',
      prNumber: null,
    });
    deps.isAncestorFn = vi.fn().mockResolvedValue(false);

    await expect(runAnalyze(deps, input)).rejects.toThrow(AnalysisFailedError);

    const analysis = fakeDb.collection('analyses').all()[0];
    expect(analysis?.status).toBe('failed');
    expect(String(analysis?.error)).toMatch(/force-push/);

    // Cleanup must still have run even on failure.
    const graphVersions = fakeDb.collection('graphVersions').all();
    const baseGv = graphVersions.find(
      (gv) =>
        gv._id instanceof ObjectId && gv._id.toHexString() === input.baseGraphVersionId,
    );
    expect(baseGv?.pinnedBy).toEqual([]);
  });

  it('records no changed functions when nothing in the touched files actually changed', async () => {
    const { fakeDb, input, deps } = await buildFixture();
    deps.postParseFn = vi
      .fn()
      .mockResolvedValue(subsetParseResponse(input.headSha, 'hash-base')); // same bodyHash as base

    await runAnalyze(deps, input);

    const analysis = fakeDb.collection('analyses').all()[0];
    expect(analysis?.status).toBe('ready');
    expect(analysis?.changedFunctions).toEqual([]);
  });
});
