/**
 * A minimal in-memory stand-in for the `ioredis` surface this package uses:
 * `get`, `set` (with `NX`/`PX`/`EX`), and `eval` (the repo lock's
 * compare-and-delete release script). Not a general Redis emulator — narrow
 * on purpose, the same way `api/src/testUtils/fakeDb.ts` is a narrow stand-in
 * for `mongodb`'s `Db`, so `npm test` stays fast and infra-independent.
 */

interface Entry {
  value: string;
  expiresAt: number | null;
}

export class FakeRedis {
  private readonly store = new Map<string, Entry>();

  private live(key: string): Entry | undefined {
    const entry = this.store.get(key);
    if (entry === undefined) return undefined;
    if (entry.expiresAt !== null && Date.now() >= entry.expiresAt) {
      this.store.delete(key);
      return undefined;
    }
    return entry;
  }

  async get(key: string): Promise<string | null> {
    await Promise.resolve();
    return this.live(key)?.value ?? null;
  }

  /** Supports this codebase's two call shapes: `set(k,v,'PX',ms,'NX')` and `set(k,v,'EX',seconds)`. */
  async set(
    key: string,
    value: string,
    ...args: (string | number)[]
  ): Promise<'OK' | null> {
    await Promise.resolve();
    let ttlMs: number | null = null;
    let nx = false;
    for (let i = 0; i < args.length; i++) {
      const arg = args[i];
      if (arg === 'PX') ttlMs = Number(args[i + 1]);
      else if (arg === 'EX') ttlMs = Number(args[i + 1]) * 1000;
      else if (arg === 'NX') nx = true;
    }
    if (nx && this.live(key) !== undefined) return null;
    this.store.set(key, { value, expiresAt: ttlMs !== null ? Date.now() + ttlMs : null });
    return 'OK';
  }

  /** Only script this codebase runs: delete `KEYS[1]` iff its value is `ARGV[1]`. */
  async eval(
    _script: string,
    _numKeys: number,
    key: string,
    token: string,
  ): Promise<number> {
    await Promise.resolve();
    if (this.live(key)?.value === token) {
      this.store.delete(key);
      return 1;
    }
    return 0;
  }
}
