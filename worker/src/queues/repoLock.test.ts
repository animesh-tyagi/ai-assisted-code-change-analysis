import type { Redis } from 'ioredis';
import { describe, expect, it } from 'vitest';

import { FakeRedis } from '../testUtils/fakeRedis.js';
import { acquireRepoLock, withRepoLock } from './repoLock.js';

function fakeRedis(): Redis {
  return new FakeRedis() as unknown as Redis;
}

describe('acquireRepoLock / release', () => {
  it('grants the lock when free, and blocks a second acquirer until release', async () => {
    const redis = fakeRedis();
    const lock = await acquireRepoLock(redis, 'repo-1', 1000);

    let secondAcquired = false;
    const secondAttempt = acquireRepoLock(redis, 'repo-1', 2000).then((l) => {
      secondAcquired = true;
      return l;
    });

    // Give the poller a couple of cycles to observe the lock is still held.
    await new Promise((r) => setTimeout(r, 50));
    expect(secondAcquired).toBe(false);

    await lock.release();
    const second = await secondAttempt;
    expect(secondAcquired).toBe(true);
    await second.release();
  });

  it('times out if the lock is never released', async () => {
    const redis = fakeRedis();
    await acquireRepoLock(redis, 'repo-2', 10_000);
    await expect(acquireRepoLock(redis, 'repo-2', 100)).rejects.toThrow(/timed out/);
  });

  it("a release never removes another holder's lock (compare-and-delete)", async () => {
    const redis = fakeRedis();
    const first = await acquireRepoLock(redis, 'repo-3', 1000);
    await first.release();
    // A second holder now legitimately owns the key.
    const second = await acquireRepoLock(redis, 'repo-3', 1000);
    // A stale release from the first holder must not evict the second's lock.
    await first.release();
    const thirdAcquireIsBlocked = await Promise.race([
      acquireRepoLock(redis, 'repo-3', 150).then(() => 'acquired' as const),
      new Promise<'still-blocked'>((resolve) =>
        setTimeout(() => {
          resolve('still-blocked');
        }, 50),
      ),
    ]);
    expect(thirdAcquireIsBlocked).toBe('still-blocked');
    await second.release();
  });
});

describe('withRepoLock', () => {
  it('releases the lock even when the function throws', async () => {
    const redis = fakeRedis();
    await expect(
      withRepoLock(redis, 'repo-4', async () => {
        await Promise.resolve();
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');

    // The lock must be free again — acquiring it should not block.
    const lock = await acquireRepoLock(redis, 'repo-4', 100);
    await lock.release();
  });
});
