/**
 * Environment configuration for the worker (ARCHITECTURE §4, `.env.example`).
 *
 * Read once, at process start — no dotenv dependency. Whatever process manager
 * runs the worker (`tsx`, a container, CI) is responsible for having the
 * variables in `process.env` already; `npm run worker:explain` is the first
 * script that actually needs a real value (`GEMINI_API_KEY`, M5) and loads
 * `.env` via `tsx`'s own `--env-file` support (see root `package.json`) — every
 * other worker script still expects a shell export or its own defaults.
 */

export interface WorkerConfig {
  mongoUrl: string;
  mongoDb: string;
  parserUrl: string;
  workspaceRoot: string;
  /** ARCHITECTURE §11.2 — never logged, never defaulted to a real value. */
  geminiApiKey: string;
  llmModel: string;
}

export function loadConfig(): WorkerConfig {
  return {
    mongoUrl: process.env.MONGO_URL ?? 'mongodb://localhost:27017',
    mongoDb: process.env.MONGO_DB ?? 'impact',
    parserUrl: process.env.PARSER_URL ?? 'http://localhost:8080',
    workspaceRoot: process.env.WORKSPACE_ROOT ?? './data',
    geminiApiKey: process.env.GEMINI_API_KEY ?? '',
    llmModel: process.env.LLM_MODEL ?? 'gemini-3.6-flash',
  };
}
