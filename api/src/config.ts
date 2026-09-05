/**
 * Environment configuration for the API process (ARCHITECTURE §4, `.env.example`).
 *
 * Mirrors `worker/src/config.ts`'s own reasoning: read once at process start,
 * no dotenv dependency, whatever runs the process (`tsx`, a container, CI) is
 * responsible for having the variables in `process.env` already. The API only
 * needs a slice of the full `.env.example` — it verifies webhooks and enqueues
 * jobs, but never clones a repo or calls the LLM, so it has no need for
 * `GITHUB_APP_PRIVATE_KEY` or `GEMINI_API_KEY` (worker-only, §9's topology:
 * only the worker touches git, Mongo writes, the parser, and the LLM).
 */

export interface ApiConfig {
  port: number;
  mongoUrl: string;
  mongoDb: string;
  /** BullMQ's Redis connection (§9.2) — this process only produces jobs, never consumes. */
  redisUrl: string;
  /** ARCHITECTURE §9.1 — verifies `X-Hub-Signature-256` on every webhook delivery. */
  githubWebhookSecret: string;
}

export function loadConfig(): ApiConfig {
  return {
    port: Number(process.env.PORT ?? 3000),
    mongoUrl: process.env.MONGO_URL ?? 'mongodb://localhost:27017',
    mongoDb: process.env.MONGO_DB ?? 'impact',
    redisUrl: process.env.REDIS_URL ?? 'redis://localhost:6379',
    githubWebhookSecret: process.env.GITHUB_WEBHOOK_SECRET ?? '',
  };
}
