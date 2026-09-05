/**
 * Per-repo Redis lock: `lock:repo:{repoId}` (§9.2). The `index` queue is
 * concurrency-1 per repo; the `analyze` queue has concurrency N but blocks on
 * this same lock only while cloning/fetching, so the two queues never race
 * each other over the same on-disk cache clone.
 *
 * Hand-rolled `SET NX PX` + a Lua compare-and-delete release, rather than a
 * full `redlock` package — a single Redis instance needs no multi-node
 * quorum, the same "no cargo-cult" reasoning `docker-compose.yml` already
 * states for D3's atomic swap not needing a replica set.
 */

import { randomUUID } from 'node:crypto';
import type { Redis } from 'ioredis';

/** Long enough to cover a slow clone/fetch; a crashed holder self-heals after this. */
const LOCK_TTL_MS = 5 * 60 * 1000;
const POLL_INTERVAL_MS = 250;

const RELEASE_SCRIPT = `
if redis.call("get", KEYS[1]) == ARGV[1] then
  return redis.call("del", KEYS[1])
else
  return 0
end
`;

export interface RepoLock {
  release(): Promise<void>;
}

export function repoLockKey(repoId: string): string {
  return `lock:repo:${repoId}`;
}

/** Blocks (polling) until the lock is acquired or `timeoutMs` elapses. */
export async function acquireRepoLock(
  redis: Redis,
  repoId: string,
  timeoutMs = 60_000,
): Promise<RepoLock> {
  const key = repoLockKey(repoId);
  const token = randomUUID();
  const deadline = Date.now() + timeoutMs;

  for (;;) {
    const acquired = await redis.set(key, token, 'PX', LOCK_TTL_MS, 'NX');
    if (acquired === 'OK') {
      return { release: () => releaseIfOwned(redis, key, token) };
    }
    if (Date.now() >= deadline) {
      throw new Error(`acquireRepoLock: timed out waiting for ${key}`);
    }
    await sleep(POLL_INTERVAL_MS);
  }
}

/** Runs `fn` while holding the lock, always releasing — even if `fn` throws. */
export async function withRepoLock<T>(
  redis: Redis,
  repoId: string,
  fn: () => Promise<T>,
  timeoutMs?: number,
): Promise<T> {
  const lock = await acquireRepoLock(redis, repoId, timeoutMs);
  try {
    return await fn();
  } finally {
    await lock.release();
  }
}

async function releaseIfOwned(redis: Redis, key: string, token: string): Promise<void> {
  await redis.eval(RELEASE_SCRIPT, 1, key, token);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
