/**
 * The `ioredis` connection BullMQ's `Worker`s (and this process's own uses of
 * Redis directly — the per-repo lock, the installation-token cache) share.
 * Mirrors `api/src/queues/connection.ts`; see that file's doc comment for why
 * this is a small, deliberate per-process duplication rather than a shared
 * runtime module across the `api`/`worker` boundary.
 */

import { Redis } from 'ioredis';

export function createRedisConnection(redisUrl: string): Redis {
  return new Redis(redisUrl, { maxRetriesPerRequest: null });
}
