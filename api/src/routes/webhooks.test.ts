import { beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';

import { createApp } from '../index.js';
import { ZERO_SHA } from '../github/events.js';
import { createFakeDb, type FakeDb } from '../testUtils/fakeDb.js';
import { createFakeQueues, type FakeQueues } from '../testUtils/fakeQueues.js';
import { signBody } from '../testUtils/sign.js';

const SECRET = 'test-webhook-secret';

interface WebhookResponseBody {
  deliveryId: string;
  analysisId?: string;
  deduped?: boolean;
}

async function post(
  app: ReturnType<typeof createApp>,
  event: string,
  deliveryId: string,
  body: object,
): Promise<{ status: number; body: WebhookResponseBody }> {
  const raw = JSON.stringify(body);
  const res = await request(app)
    .post('/api/webhooks/github')
    .set('Content-Type', 'application/json')
    .set('X-GitHub-Event', event)
    .set('X-GitHub-Delivery', deliveryId)
    .set('X-Hub-Signature-256', signBody(SECRET, raw))
    .send(raw);
  return { status: res.status, body: res.body as WebhookResponseBody };
}

const REPO_FULL = {
  id: 1001,
  name: 'observability-final',
  full_name: 'animesh-tyagi/observability-final',
  default_branch: 'main',
  owner: { login: 'animesh-tyagi' },
};

describe('POST /api/webhooks/github', () => {
  let fakeDb: FakeDb;
  let queues: FakeQueues;
  let app: ReturnType<typeof createApp>;

  beforeEach(() => {
    fakeDb = createFakeDb();
    queues = createFakeQueues();
    app = createApp({ db: fakeDb.db, queues, webhookSecret: SECRET });
  });

  it('rejects an invalid signature', async () => {
    const res = await request(app)
      .post('/api/webhooks/github')
      .set('Content-Type', 'application/json')
      .set('X-GitHub-Event', 'push')
      .set('X-GitHub-Delivery', 'd1')
      .set('X-Hub-Signature-256', 'sha256=not-the-right-signature')
      .send(JSON.stringify({}));
    expect(res.status).toBe(401);
  });

  it('dedupes a redelivered webhook by X-GitHub-Delivery', async () => {
    const payload = {
      ref: 'refs/heads/other',
      before: 'a'.repeat(40),
      after: 'b'.repeat(40),
      repository: REPO_FULL,
      installation: { id: 555 },
    };
    const first = await post(app, 'push', 'delivery-1', payload);
    expect(first.status).toBe(202);

    const second = await post(app, 'push', 'delivery-1', payload);
    expect(second.status).toBe(200);
    expect(second.body).toMatchObject({ deduped: true });
    expect(queues.enqueuedIndex).toHaveLength(0); // non-default branch, so nothing was enqueued either time
  });

  it('installation created: upserts installations and repos', async () => {
    const res = await post(app, 'installation', 'd-install-1', {
      action: 'created',
      installation: {
        id: 555,
        account: { login: 'animesh-tyagi', type: 'User' },
        repository_selection: 'selected',
      },
      repositories: [{ id: 1001, full_name: 'animesh-tyagi/observability-final' }],
    });
    expect(res.status).toBe(202);

    const installations = fakeDb.collection('installations').all();
    expect(installations).toHaveLength(1);
    expect(installations[0]).toMatchObject({
      githubInstallationId: 555,
      accountLogin: 'animesh-tyagi',
    });

    const repos = fakeDb.collection('repos').all();
    expect(repos).toHaveLength(1);
    expect(repos[0]).toMatchObject({
      provider: 'github',
      githubRepoId: 1001,
      owner: 'animesh-tyagi',
      name: 'observability-final',
      defaultBranch: '', // unknown until a push/pull_request event supplies it
    });
  });

  it('installation_repositories added: upserts the newly-added repos', async () => {
    await post(app, 'installation', 'd-install-2', {
      action: 'created',
      installation: {
        id: 555,
        account: { login: 'animesh-tyagi', type: 'User' },
        repository_selection: 'selected',
      },
      repositories: [],
    });

    const res = await post(app, 'installation_repositories', 'd-install-repos-1', {
      action: 'added',
      installation: {
        id: 555,
        account: { login: 'animesh-tyagi', type: 'User' },
        repository_selection: 'selected',
      },
      repository_selection: 'selected',
      repositories_added: [
        { id: 1002, full_name: 'animesh-tyagi/spring-petclinic-rest' },
      ],
    });
    expect(res.status).toBe(202);

    const repos = fakeDb.collection('repos').all();
    expect(repos).toHaveLength(1);
    expect(repos[0]).toMatchObject({ githubRepoId: 1002, name: 'spring-petclinic-rest' });
  });

  it('push to the default branch: enqueues index, creates and enqueues an analyze job', async () => {
    const before = 'a'.repeat(40);
    const after = 'b'.repeat(40);
    const res = await post(app, 'push', 'd-push-1', {
      ref: 'refs/heads/main',
      before,
      after,
      repository: REPO_FULL,
      installation: { id: 555 },
    });

    expect(res.status).toBe(202);
    expect(res.body.analysisId).toBeDefined();

    expect(queues.enqueuedIndex).toHaveLength(1);
    expect(queues.enqueuedIndex[0]?.data.sha).toBe(after);

    expect(queues.enqueuedAnalyze).toHaveLength(1);
    expect(queues.enqueuedAnalyze[0]?.data.analysisId).toBe(res.body.analysisId);

    const analyses = fakeDb.collection('analyses').all();
    expect(analyses).toHaveLength(1);
    expect(analyses[0]).toMatchObject({
      trigger: 'push',
      baseSha: before,
      headSha: after,
      status: 'queued',
    });
    expect(analyses[0]?.prNumber).toBeUndefined();
  });

  it('push to a non-default branch: no index/analyze job', async () => {
    const res = await post(app, 'push', 'd-push-2', {
      ref: 'refs/heads/feature-x',
      before: 'a'.repeat(40),
      after: 'b'.repeat(40),
      repository: REPO_FULL,
      installation: { id: 555 },
    });
    expect(res.status).toBe(202);
    expect(res.body.analysisId).toBeUndefined();
    expect(queues.enqueuedIndex).toHaveLength(0);
    expect(queues.enqueuedAnalyze).toHaveLength(0);
  });

  it('push that creates the branch (before = zero SHA): indexes but does not analyze', async () => {
    const res = await post(app, 'push', 'd-push-3', {
      ref: 'refs/heads/main',
      before: ZERO_SHA,
      after: 'b'.repeat(40),
      repository: REPO_FULL,
      installation: { id: 555 },
    });
    expect(res.status).toBe(202);
    expect(res.body.analysisId).toBeUndefined();
    expect(queues.enqueuedIndex).toHaveLength(1);
    expect(queues.enqueuedAnalyze).toHaveLength(0);
    expect(fakeDb.collection('analyses').all()).toHaveLength(0);
  });

  it('pull_request opened: creates and enqueues an analyze job', async () => {
    const res = await post(app, 'pull_request', 'd-pr-1', {
      action: 'opened',
      number: 42,
      pull_request: { base: { sha: 'a'.repeat(40) }, head: { sha: 'b'.repeat(40) } },
      repository: REPO_FULL,
      installation: { id: 555 },
    });
    expect(res.status).toBe(202);
    expect(res.body.analysisId).toBeDefined();
    expect(queues.enqueuedAnalyze).toHaveLength(1);

    const analyses = fakeDb.collection('analyses').all();
    expect(analyses).toHaveLength(1);
    expect(analyses[0]).toMatchObject({
      trigger: 'pull_request',
      prNumber: 42,
      status: 'queued',
    });
  });

  it('pull_request closed: acked, no job', async () => {
    const res = await post(app, 'pull_request', 'd-pr-2', {
      action: 'closed',
      number: 42,
      pull_request: { base: { sha: 'a'.repeat(40) }, head: { sha: 'b'.repeat(40) } },
      repository: REPO_FULL,
      installation: { id: 555 },
    });
    expect(res.status).toBe(202);
    expect(res.body.analysisId).toBeUndefined();
    expect(queues.enqueuedAnalyze).toHaveLength(0);
  });

  it('pull_request synchronize supersedes the prior analysis for the same PR', async () => {
    await post(app, 'pull_request', 'd-pr-3', {
      action: 'opened',
      number: 7,
      pull_request: { base: { sha: 'a'.repeat(40) }, head: { sha: 'b'.repeat(40) } },
      repository: REPO_FULL,
      installation: { id: 555 },
    });
    await post(app, 'pull_request', 'd-pr-4', {
      action: 'synchronize',
      number: 7,
      pull_request: { base: { sha: 'a'.repeat(40) }, head: { sha: 'c'.repeat(40) } },
      repository: REPO_FULL,
      installation: { id: 555 },
    });

    const analyses = fakeDb.collection('analyses').all();
    expect(analyses).toHaveLength(2);
    const byHead = new Map(analyses.map((a) => [a.headSha, a]));
    expect(byHead.get('b'.repeat(40))?.status).toBe('superseded');
    expect(byHead.get('c'.repeat(40))?.status).toBe('queued');
  });
});
