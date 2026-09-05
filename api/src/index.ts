/**
 * `@impact/api` — the Express app: webhook receiver and read endpoints.
 *
 * M1 scaffold. Only `GET /healthz` exists so far; it is enough to prove the
 * workspace wiring resolves and to give `npm run dev:api` something to answer.
 *
 * Still to come:
 *   - `POST /api/webhooks/github` — raw-body signature verify, delivery dedupe,
 *     202 in under ~500ms (ARCHITECTURE §9.1). **M6.**
 *   - `GET /api/analyses/:id` and the polling endpoints (§9.6). **M6.**
 *
 * Note for M6: the webhook route needs the *raw* request body to verify
 * `X-Hub-Signature-256`, so `express.json()` must be mounted with a `verify`
 * callback that stashes the buffer — not applied globally before that route.
 */

import express from 'express';

import { CONTEXT_SCHEMA_VERSION } from '@impact/shared';

import { loadConfig } from './config.js';

export function createApp(): express.Express {
  const app = express();

  app.get('/healthz', (_req, res) => {
    res.json({
      status: 'ok',
      service: '@impact/api',
      contextSchemaVersion: CONTEXT_SCHEMA_VERSION,
    });
  });

  return app;
}

// Only listen when run directly, so tests can import `createApp` without
// binding a port.
if (process.argv[1] !== undefined && import.meta.url.endsWith('index.ts')) {
  const config = loadConfig();
  createApp().listen(config.port, () => {
    console.log(`[api] listening on http://localhost:${String(config.port)}`);
  });
}
