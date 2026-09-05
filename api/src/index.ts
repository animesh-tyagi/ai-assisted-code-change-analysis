/**
 * `@impact/api` — the Express app: webhook receiver and read endpoints.
 *
 * `POST /api/webhooks/github` — raw-body signature verify, delivery dedupe,
 * event switch, enqueue, 202 (ARCHITECTURE §9.1). **M6 Phase 2.**
 *
 * `GET /api/analyses/:id` and `GET /api/repos/:repoId/pulls/:number/latest`
 * — the §9.6 polling endpoints. **M6 Phase 5.**
 */

import express from 'express';
import type { Db } from 'mongodb';
import { pathToFileURL } from 'node:url';

import { CONTEXT_SCHEMA_VERSION } from '@impact/shared';

import { loadConfig } from './config.js';
import { connect } from './db/client.js';
import { createQueues, type Queues } from './queues/producer.js';
import { createAnalysesRouter } from './routes/analyses.js';
import { createWebhooksRouter } from './routes/webhooks.js';

export interface AppDeps {
  db: Db;
  queues: Queues;
  webhookSecret: string;
}

export function createApp(deps: AppDeps): express.Express {
  const app = express();

  app.get('/healthz', (_req, res) => {
    res.json({
      status: 'ok',
      service: '@impact/api',
      contextSchemaVersion: CONTEXT_SCHEMA_VERSION,
    });
  });

  app.use(
    '/api/webhooks',
    createWebhooksRouter({
      db: deps.db,
      queues: deps.queues,
      webhookSecret: deps.webhookSecret,
    }),
  );
  app.use('/api', createAnalysesRouter({ db: deps.db }));

  return app;
}

// Only run when started directly, so tests can import `createApp` and supply
// their own (fake) deps without connecting to real Mongo/Redis or binding a port.
//
// `.endsWith('index.ts')` (the check used by worker/src/index.ts and
// worker/src/llm/cli.ts) is not enough here: this module is also *imported*
// by webhooks.test.ts, and an imported module's own `import.meta.url` still
// ends with its filename regardless of who loaded it. Comparing against
// `process.argv[1]` (the actual entry script) is what distinguishes "this
// file is running as the program" from "this file was merely imported".
const isMainModule =
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href;

if (isMainModule) {
  const config = loadConfig();
  const db = await connect(config.mongoUrl, config.mongoDb);
  const queues = createQueues(config.redisUrl);

  createApp({ db, queues, webhookSecret: config.githubWebhookSecret }).listen(
    config.port,
    () => {
      console.log(`[api] listening on http://localhost:${String(config.port)}`);
    },
  );
}
