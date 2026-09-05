/**
 * A minimal in-memory stand-in for the `mongodb` `Db`/`Collection` surface
 * this package's M6 orchestration code uses — plain-equality filters (plus
 * `$ne`), `$set`/`$addToSet`/`$pull` updates, `find().toArray()`,
 * `insertOne`/`insertMany`, `deleteOne`/`deleteMany`. Mirrors
 * `api/src/testUtils/fakeDb.ts`; see that file's doc comment for why this is
 * a narrow, hand-rolled fake rather than a general Mongo emulator or a
 * shared cross-package test util.
 */

import { ObjectId, type Db } from 'mongodb';

type Doc = Record<string, unknown> & { _id: unknown };

interface UpdateSpec {
  $set?: Record<string, unknown>;
  $addToSet?: Record<string, unknown>;
  $pull?: Record<string, unknown>;
}

function keyOf(id: unknown): string {
  return id instanceof ObjectId ? id.toHexString() : String(id);
}

function isNeOperator(val: unknown): val is { $ne: unknown } {
  return typeof val === 'object' && val !== null && '$ne' in val;
}

function isInOperator(val: unknown): val is { $in: unknown[] } {
  return typeof val === 'object' && val !== null && '$in' in val;
}

function valuesEqual(a: unknown, b: unknown): boolean {
  if (a instanceof ObjectId || b instanceof ObjectId) {
    return a instanceof ObjectId && b instanceof ObjectId && a.equals(b);
  }
  return a === b;
}

function matches(doc: Doc, filter: Record<string, unknown>): boolean {
  for (const [field, expected] of Object.entries(filter)) {
    const actual = doc[field];
    if (isNeOperator(expected)) {
      if (valuesEqual(actual, expected.$ne)) return false;
      continue;
    }
    if (isInOperator(expected)) {
      if (!expected.$in.some((v) => valuesEqual(actual, v))) return false;
      continue;
    }
    if (!valuesEqual(actual, expected)) return false;
  }
  return true;
}

function clone<T>(value: T): T {
  return { ...value };
}

function applyUpdate(doc: Doc, update: UpdateSpec): Doc {
  const next: Doc = { ...doc, ...update.$set };
  if (update.$addToSet !== undefined) {
    for (const [field, value] of Object.entries(update.$addToSet)) {
      const current = Array.isArray(next[field]) ? (next[field] as unknown[]) : [];
      next[field] = current.some((v) => valuesEqual(v, value))
        ? current
        : [...current, value];
    }
  }
  if (update.$pull !== undefined) {
    for (const [field, value] of Object.entries(update.$pull)) {
      const current = Array.isArray(next[field]) ? (next[field] as unknown[]) : [];
      next[field] = current.filter((v) => !valuesEqual(v, value));
    }
  }
  return next;
}

class FakeCursor {
  constructor(private readonly docs: Doc[]) {}

  async toArray(): Promise<Doc[]> {
    await Promise.resolve();
    return this.docs.map(clone);
  }
}

class FakeCollection {
  private readonly docs = new Map<string, Doc>();

  async insertOne(doc: Doc): Promise<{ insertedId: unknown }> {
    await Promise.resolve();
    const id = doc._id ?? new ObjectId();
    this.docs.set(keyOf(id), clone({ ...doc, _id: id }));
    return { insertedId: id };
  }

  async insertMany(docs: Doc[]): Promise<{ insertedCount: number }> {
    await Promise.resolve();
    for (const doc of docs) {
      const id = doc._id ?? new ObjectId();
      this.docs.set(keyOf(id), clone({ ...doc, _id: id }));
    }
    return { insertedCount: docs.length };
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

  async updateOne(
    filter: Record<string, unknown>,
    update: UpdateSpec,
    options: { upsert?: boolean } = {},
  ): Promise<{ matchedCount: number }> {
    await Promise.resolve();
    for (const [k, doc] of this.docs) {
      if (matches(doc, filter)) {
        this.docs.set(k, clone(applyUpdate(doc, update)));
        return { matchedCount: 1 };
      }
    }
    if (options.upsert !== true) return { matchedCount: 0 };

    const id = update.$set?._id ?? new ObjectId();
    const inserted = clone(applyUpdate({ _id: id }, update));
    this.docs.set(keyOf(id), inserted);
    return { matchedCount: 0 };
  }

  async deleteOne(filter: Record<string, unknown>): Promise<{ deletedCount: number }> {
    await Promise.resolve();
    for (const [k, doc] of this.docs) {
      if (matches(doc, filter)) {
        this.docs.delete(k);
        return { deletedCount: 1 };
      }
    }
    return { deletedCount: 0 };
  }

  async deleteMany(filter: Record<string, unknown>): Promise<{ deletedCount: number }> {
    await Promise.resolve();
    let count = 0;
    for (const [k, doc] of this.docs) {
      if (matches(doc, filter)) {
        this.docs.delete(k);
        count++;
      }
    }
    return { deletedCount: count };
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

  return {
    db: { collection: getCollection } as unknown as Db,
    collection: getCollection,
  };
}
