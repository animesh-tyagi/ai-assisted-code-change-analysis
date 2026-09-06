import type { Redis } from 'ioredis';
import { describe, expect, it, vi } from 'vitest';

import { FakeRedis } from '../testUtils/fakeRedis.js';
import { mintInstallationToken, type InstallationAuthFn } from './appAuth.js';

function fakeRedis(): Redis {
  return new FakeRedis() as unknown as Redis;
}

describe('mintInstallationToken', () => {
  it('calls the auth function on a cache miss and caches the result', async () => {
    const redis = fakeRedis();
    const authFn: InstallationAuthFn = vi.fn().mockResolvedValue({ token: 'tok-abc' });

    const token = await mintInstallationToken(redis, authFn, 555);

    expect(token).toBe('tok-abc');
    expect(authFn).toHaveBeenCalledTimes(1);
    expect(authFn).toHaveBeenCalledWith(555);
  });

  it('hits the cache on a second call and mints no new token', async () => {
    const redis = fakeRedis();
    const authFn: InstallationAuthFn = vi.fn().mockResolvedValue({ token: 'tok-abc' });

    await mintInstallationToken(redis, authFn, 555);
    const second = await mintInstallationToken(redis, authFn, 555);

    expect(second).toBe('tok-abc');
    expect(authFn).toHaveBeenCalledTimes(1);
  });

  it('mints independently per installation id', async () => {
    const redis = fakeRedis();
    const authFn: InstallationAuthFn = vi
      .fn()
      .mockResolvedValueOnce({ token: 'tok-a' })
      .mockResolvedValueOnce({ token: 'tok-b' });

    const a = await mintInstallationToken(redis, authFn, 1);
    const b = await mintInstallationToken(redis, authFn, 2);

    expect(a).toBe('tok-a');
    expect(b).toBe('tok-b');
    expect(authFn).toHaveBeenCalledTimes(2);
  });
});
