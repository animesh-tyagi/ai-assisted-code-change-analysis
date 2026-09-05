/**
 * A minimal in-memory stand-in for the `mongodb` `Db`/`Collection` surface
 * this package's M6 orchestration code uses (`insertOne`, `findOne` — plain
 * equality filters only). Mirrors `api/src/testUtils/fakeDb.ts`; see that
 * file's doc comment for why this is a narrow, hand-rolled fake rather than a
 * general Mongo emulator or a shared cross-package test util.
 */

import { ObjectId, type Db } from 'mongodb';

type Doc = Record<string, unknown> & { _id: unknown };

function keyOf(id: unknown): string {
  return id instanceof ObjectId ? id.toHexString() : String(id);
}

function matches(doc: Doc, filter: Record<string, unknown>): boolean {
  for (const [field, expected] of Object.entries(filter)) {
    const actual = doc[field];
    if (expected instanceof ObjectId) {
      if (!(actual instanceof ObjectId) || !actual.equals(expected)) return false;
      continue;
    }
    if (actual !== expected) return false;
  }
  return true;
}

class FakeCollection {
  private readonly docs = new Map<string, Doc>();

  async insertOne(doc: Doc): Promise<{ insertedId: unknown }> {
    await Promise.resolve();
    const id = doc._id ?? new ObjectId();
    this.docs.set(keyOf(id), { ...doc, _id: id });
    return { insertedId: id };
  }

  async findOne(filter: Record<string, unknown>): Promise<Doc | null> {
    await Promise.resolve();
    for (const doc of this.docs.values()) {
      if (matches(doc, filter)) return { ...doc };
    }
    return null;
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
