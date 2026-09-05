/**
 * The worker's long-running process (M6 Phase 5) — connects Mongo + Redis,
 * ensures indexes, and starts the `index`/`analyze` BullMQ `Worker`s (§9.2).
 *
 * This is what `npm run dev:worker` / the worker workspace's `start` script
 * run. The one-shot CLIs (`worker:index`, `worker:explain`, both driven by
 * `worker/src/index.ts` and `worker/src/llm/cli.ts`) are unaffected — they
 * stay separate entry points for manual/demo runs, not this server.
 */

import { loadConfig } from './config.js';
import { close as closeMongo, connect } from './db/client.js';
import { ensureIndexes } from './db/indexes.js';
import { createGithubAppAuth } from './github/appAuth.js';
import { MongoExplanationStore } from './llm/explanationStore.js';
import { GeminiProvider } from './llm/geminiProvider.js';
import { createAnalyzeWorker } from './queues/analyzeWorker.js';
import { createRedisConnection } from './queues/connection.js';
import { createIndexWorker } from './queues/indexWorker.js';
import { createQueues } from './queues/producer.js';

async function main(): Promise<void> {
  const config = loadConfig();
  const db = await connect(config.mongoUrl, config.mongoDb);
  await ensureIndexes(db);

  const redis = createRedisConnection(config.redisUrl);
  const queues = createQueues(redis);
  const authFn = createGithubAppAuth({
    appId: config.githubAppId,
    privateKey: config.githubAppPrivateKey,
  });
  const llmProvider = new GeminiProvider({
    apiKey: config.geminiApiKey,
    model: config.llmModel,
  });
  const explanationStore = new MongoExplanationStore(db);

  const indexWorker = createIndexWorker({ db, redis, config, authFn });
  const analyzeWorker = createAnalyzeWorker({
    db,
    redis,
    config,
    authFn,
    llmProvider,
    explanationStore,
    queues,
  });

  console.log('[worker] serving index + analyze queues');

  let shuttingDown = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`[worker] received ${signal}, shutting down...`);
    await Promise.all([indexWorker.close(), analyzeWorker.close()]);
    await queues.close();
    redis.disconnect();
    await closeMongo();
    process.exit(0);
  };

  process.on('SIGTERM', () => {
    shutdown('SIGTERM').catch((err: unknown) => {
      console.error('[worker] error during shutdown:', err);
      process.exit(1);
    });
  });
  process.on('SIGINT', () => {
    shutdown('SIGINT').catch((err: unknown) => {
      console.error('[worker] error during shutdown:', err);
      process.exit(1);
    });
  });
}

main().catch((err: unknown) => {
  console.error('[worker] fatal:', err);
  process.exitCode = 1;
});
