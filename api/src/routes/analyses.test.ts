import { ObjectId } from 'mongodb';
import request from 'supertest';
import { describe, expect, it } from 'vitest';

import { createApp } from '../index.js';
import { createFakeDb, type FakeDb } from '../testUtils/fakeDb.js';
import { createFakeQueues } from '../testUtils/fakeQueues.js';

function buildApp(fakeDb: FakeDb): ReturnType<typeof createApp> {
  return createApp({
    db: fakeDb.db,
    queues: createFakeQueues(),
    webhookSecret: 'unused',
  });
}

interface AnalysisBody {
  analysisId?: string;
  status?: string;
  progress?: { step: string; pct: number };
  prNumber?: number;
  result?: { changedFunctions: unknown[] };
}

async function get(
  app: ReturnType<typeof createApp>,
  path: string,
): Promise<{ status: number; body: AnalysisBody }> {
  const res = await request(app).get(path);
  return { status: res.status, body: res.body as AnalysisBody };
}

describe('GET /api/analyses/:id', () => {
  it('404s for an analysis that does not exist', async () => {
    const fakeDb = createFakeDb();
    const res = await request(buildApp(fakeDb)).get(
      `/api/analyses/${new ObjectId().toHexString()}`,
    );
    expect(res.status).toBe(404);
  });

  it('400s for a malformed id', async () => {
    const fakeDb = createFakeDb();
    const res = await request(buildApp(fakeDb)).get('/api/analyses/not-an-object-id');
    expect(res.status).toBe(400);
  });

  it('returns status/progress and embeds explanation prose for completed functions', async () => {
    const fakeDb = createFakeDb();
    const analysisId = new ObjectId();
    const explanationId = new ObjectId();

    await fakeDb.collection('explanations').insertOne({
      _id: explanationId,
      contextHash: 'hash-1',
      promptVersion: 'v1',
      model: 'fake-model',
      sections: {
        whatChanged: 'It changed.',
        whoIsAffected: 'One caller.',
        whatToCheck: 'Check it.',
      },
      raw: '{}',
      validation: { passed: true, attempts: 1, violations: [] },
      usage: { inputTokens: 0, outputTokens: 0 },
      degraded: false,
      createdAt: new Date(),
    });

    await fakeDb.collection('analyses').insertOne({
      _id: analysisId,
      repoId: 'repo-1',
      trigger: 'pull_request',
      prNumber: 7,
      baseSha: 'a'.repeat(40),
      headSha: 'b'.repeat(40),
      baseGraphVersionId: null,
      overlayGraphVersionId: null,
      deliveryId: 'delivery-1',
      jobId: 'job-1',
      status: 'ready',
      progress: { step: 'ready', pct: 100 },
      changedFunctions: [
        {
          functionKey: 'fn:com.acme.Foo#bar()',
          changeKind: 'modified',
          contextHash: 'hash-1',
          explanationId: explanationId.toHexString(),
        },
      ],
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const res = await get(buildApp(fakeDb), `/api/analyses/${analysisId.toHexString()}`);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      analysisId: analysisId.toHexString(),
      status: 'ready',
      progress: { step: 'ready', pct: 100 },
      prNumber: 7,
    });
    expect(res.body.result?.changedFunctions).toEqual([
      {
        functionKey: 'fn:com.acme.Foo#bar()',
        changeKind: 'modified',
        sections: {
          whatChanged: 'It changed.',
          whoIsAffected: 'One caller.',
          whatToCheck: 'Check it.',
        },
        degraded: false,
      },
    ]);
  });

  it('omits prNumber for a push-triggered analysis', async () => {
    const fakeDb = createFakeDb();
    const analysisId = new ObjectId();
    await fakeDb.collection('analyses').insertOne({
      _id: analysisId,
      repoId: 'repo-1',
      trigger: 'push',
      baseSha: 'a'.repeat(40),
      headSha: 'b'.repeat(40),
      status: 'queued',
      progress: { step: 'queued', pct: 0 },
      changedFunctions: [],
    });

    const res = await get(buildApp(fakeDb), `/api/analyses/${analysisId.toHexString()}`);
    expect(res.status).toBe(200);
    expect(res.body.prNumber).toBeUndefined();
  });
});

describe('GET /api/repos/:repoId/pulls/:number/latest', () => {
  it('resolves the newest non-superseded analysis for a PR', async () => {
    const fakeDb = createFakeDb();
    const older = new ObjectId();
    const newer = new ObjectId();

    await fakeDb.collection('analyses').insertOne({
      _id: older,
      repoId: 'repo-1',
      trigger: 'pull_request',
      prNumber: 7,
      baseSha: 'a'.repeat(40),
      headSha: 'b'.repeat(40),
      status: 'superseded',
      progress: { step: 'ready', pct: 100 },
      changedFunctions: [],
      createdAt: new Date('2026-01-01T00:00:00Z'),
    });
    await fakeDb.collection('analyses').insertOne({
      _id: newer,
      repoId: 'repo-1',
      trigger: 'pull_request',
      prNumber: 7,
      baseSha: 'a'.repeat(40),
      headSha: 'c'.repeat(40),
      status: 'ready',
      progress: { step: 'ready', pct: 100 },
      changedFunctions: [],
      createdAt: new Date('2026-01-02T00:00:00Z'),
    });

    const res = await get(buildApp(fakeDb), '/api/repos/repo-1/pulls/7/latest');
    expect(res.status).toBe(200);
    expect(res.body.analysisId).toBe(newer.toHexString());
    expect(res.body.status).toBe('ready');
  });

  it('404s when no analysis exists for the pull request', async () => {
    const fakeDb = createFakeDb();
    const res = await get(buildApp(fakeDb), '/api/repos/repo-1/pulls/99/latest');
    expect(res.status).toBe(404);
  });

  it('400s for a non-numeric pull request number', async () => {
    const fakeDb = createFakeDb();
    const res = await get(
      buildApp(fakeDb),
      '/api/repos/repo-1/pulls/not-a-number/latest',
    );
    expect(res.status).toBe(400);
  });
});
