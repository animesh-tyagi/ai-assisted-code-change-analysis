/**
 * A minimal in-memory stand-in for the `mongodb` `Db`/`Collection` surface
 * this package actually uses (`insertOne`, `findOne`, `findOneAndUpdate`,
 * `updateOne`, `updateMany`, each with the exact filter/update shapes the
 * webhook route emits — plain equality plus `$ne`, `$set`/`$setOnInsert`,
 * `upsert`). Not a general Mongo emulator — narrow on purpose, the same way
 * `InMemoryGraphReader` (worker/src/traversal) and `InMemoryExplanationStore`
 * (worker/src/llm) are narrow stand-ins for their own real implementations,
 * so `npm test` stays fast and infra-independent (no `docker compose up`).
 */

import { ObjectId, type Db } from 'mongodb';

type Doc = Record<string, unknown> & { _id: unknown };

interface UpdateSpec {
  $set?: Record<string, unknown>;
  $setOnInsert?: Record<string, unknown>;
}

function keyOf(id: unknown): string {
  return id instanceof ObjectId ? id.toHexString() : String(id);
}

function isNeOperator(val: unknown): val is { $ne: unknown } {
  return typeof val === 'object' && val !== null && '$ne' in val;
}

function matches(doc: Doc, filter: Record<string, unknown>): boolean {
  for (const [field, expected] of Object.entries(filter)) {
    const actual = doc[field];
    if (isNeOperator(expected)) {
      if (actual === expected.$ne) return false;
      continue;
    }
    if (expected instanceof ObjectId) {
      if (!(actual instanceof ObjectId) || !actual.equals(expected)) return false;
      continue;
    }
    if (actual !== expected) return false;
  }
  return true;
}

/**
 * A shallow copy, not `structuredClone`: `_id` is a real `ObjectId` instance
 * (and some fields are `Date`s), and `structuredClone` doesn't preserve a
 * class instance's prototype — it would silently turn `_id` into a plain
 * object with no `toHexString()`. A shallow copy keeps those references
 * intact while still preventing a caller from mutating the stored doc.
 */
function clone<T>(value: T): T {
  return { ...value };
}

function compareValues(a: unknown, b: unknown): number {
  const av = a instanceof Date ? a.getTime() : a;
  const bv = b instanceof Date ? b.getTime() : b;
  if (typeof av === 'number' && typeof bv === 'number') return av - bv;
  if (typeof av === 'string' && typeof bv === 'string') return av.localeCompare(bv);
  return 0;
}

class FakeCursor {
  constructor(private docs: Doc[]) {}

  sort(spec: Record<string, 1 | -1>): this {
    const [field, direction] = Object.entries(spec)[0] ?? [];
    if (field === undefined) return this;
    this.docs = [...this.docs].sort(
      (a, b) => compareValues(a[field], b[field]) * (direction === -1 ? -1 : 1),
    );
    return this;
  }

  limit(n: number): this {
    this.docs = this.docs.slice(0, n);
    return this;
  }

  async next(): Promise<Doc | null> {
    await Promise.resolve();
    const first = this.docs.at(0);
    return first === undefined ? null : clone(first);
  }

  async toArray(): Promise<Doc[]> {
    await Promise.resolve();
    return this.docs.map(clone);
  }
}

class FakeCollection {
  private readonly docs = new Map<string, Doc>();

  async insertOne(doc: Doc): Promise<{ insertedId: unknown }> {
    await Promise.resolve(); // stays `async` to match the real (asynchronous) Collection interface
    const id = doc._id ?? new ObjectId();
    const k = keyOf(id);
    if (this.docs.has(k)) {
      const err = new Error('E11000 duplicate key error') as Error & { code: number };
      err.code = 11000;
      throw err;
    }
    this.docs.set(k, clone({ ...doc, _id: id }));
    return { insertedId: id };
  }

  async findOne(filter: Record<string, unknown>): Promise<Doc | null> {
    await Promise.resolve();
    for (const doc of this.docs.values()) {
      if (matches(doc, filter)) return clone(doc);
    }
    return null;
  }

  find(filter: Record<string, unknown>): FakeCursor {
    return new FakeCursor([...this.docs.values()].filter((doc) => matches(doc, filter)));
  }

  async findOneAndUpdate(
    filter: Record<string, unknown>,
    update: UpdateSpec,
    options: { upsert?: boolean } = {},
  ): Promise<Doc | null> {
    await Promise.resolve();
    for (const [k, doc] of this.docs) {
      if (matches(doc, filter)) {
        const updated = clone({ ...doc, ...update.$set });
        this.docs.set(k, updated);
        return clone(updated);
      }
    }
    if (options.upsert !== true) return null;

    const id = update.$setOnInsert?._id ?? new ObjectId();
    const inserted = clone({
      ...update.$setOnInsert,
      ...update.$set,
      _id: id,
    }) as Doc;
    this.docs.set(keyOf(id), inserted);
    return clone(inserted);
  }

  async updateOne(
    filter: Record<string, unknown>,
    update: UpdateSpec,
    options: { upsert?: boolean } = {},
  ): Promise<{ matchedCount: number }> {
    await Promise.resolve();
    for (const [k, doc] of this.docs) {
      if (matches(doc, filter)) {
        this.docs.set(k, clone({ ...doc, ...update.$set }));
        return { matchedCount: 1 };
      }
    }
    if (options.upsert !== true) return { matchedCount: 0 };

    const id = update.$setOnInsert?._id ?? new ObjectId();
    const inserted = clone({
      ...update.$setOnInsert,
      ...update.$set,
      _id: id,
    }) as Doc;
    this.docs.set(keyOf(id), inserted);
    return { matchedCount: 0 };
  }

  async updateMany(
    filter: Record<string, unknown>,
    update: UpdateSpec,
  ): Promise<{ matchedCount: number }> {
    await Promise.resolve();
    let count = 0;
    for (const [k, doc] of this.docs) {
      if (matches(doc, filter)) {
        this.docs.set(k, clone({ ...doc, ...update.$set }));
        count++;
      }
    }
    return { matchedCount: count };
  }

  /** Test-only escape hatch to assert on stored state directly. */
  all(): Doc[] {
    return [...this.docs.values()].map(clone);
  }
}

export interface FakeDb {
  db: Db;
  collection(name: string): FakeCollection;
}

export function createFakeDb(): FakeDb {
  const collections = new Map<string, FakeCollection>();
  const getCollection = (name: string): FakeCollection => {
    let c = collections.get(name);
    if (c === undefined) {
      c = new FakeCollection();
      collections.set(name, c);
    }
    return c;
  };

  const fake = { collection: getCollection };
  return { db: fake as unknown as Db, collection: getCollection };
}
