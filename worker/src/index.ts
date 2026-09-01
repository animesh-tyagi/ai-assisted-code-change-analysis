/**
 * `@impact/worker` — the only process that touches git, Mongo writes, the parser
 * service, and the LLM (ARCHITECTURE §4).
 *
 * M1 scaffold: an entrypoint that proves the workspace resolves. The real jobs
 * arrive milestone by milestone:
 *   - index flow, §5.1 + graph persistence with the atomic swap  → M3
 *   - traversal → context object, §10                            → M4
 *   - LLMProvider + validator, §11                               → M5
 *   - BullMQ queues, per-repo lock, pinning, §9.2–§9.5           → M6
 */

import { CONTEXT_SCHEMA_VERSION, type ContextObject } from '@impact/shared';

/** Placeholder so the shared *type* import is exercised, not just a value. */
export type PendingContext = ContextObject | null;

function main(): void {
  console.log(
    `[worker] scaffold up; context schema v${String(CONTEXT_SCHEMA_VERSION)}. ` +
      'No queues wired yet (M6).',
  );
}

main();
