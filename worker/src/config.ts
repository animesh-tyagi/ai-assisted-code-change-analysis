/**
 * Environment configuration for the worker (ARCHITECTURE §4, `.env.example`).
 *
 * Read once, at process start — no dotenv dependency. Whatever process manager
 * runs the worker (`tsx`, a container, CI) is responsible for having the
 * variables in `process.env` already; local dev loads `.env` via `tsx`'s own
 * `--env-file` support (documented in the worker README once M6 needs it) or a
 * shell export.
 */

export interface WorkerConfig {
  mongoUrl: string;
  mongoDb: string;
  parserUrl: string;
  workspaceRoot: string;
}

export function loadConfig(): WorkerConfig {
  return {
    mongoUrl: process.env.MONGO_URL ?? 'mongodb://localhost:27017',
    mongoDb: process.env.MONGO_DB ?? 'impact',
    parserUrl: process.env.PARSER_URL ?? 'http://localhost:8080',
    workspaceRoot: process.env.WORKSPACE_ROOT ?? './data',
  };
}
