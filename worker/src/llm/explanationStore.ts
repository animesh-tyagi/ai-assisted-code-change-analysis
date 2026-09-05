/**
 * The seam between `generateExplanation.ts` and how the `explanations` cache is
 * actually persisted (§11.2 D-cache). `MongoExplanationStore` is the real
 * implementation; `InMemoryExplanationStore` (`inMemoryExplanationStore.ts`)
 * implements the same interface over a `Map` for every unit test — mirrors the
 * `GraphReader`/`MongoGraphReader` seam in `worker/src/traversal/graphReader.ts`.
 */

import type { Db } from 'mongodb';

import type { ExplanationDoc } from '@impact/shared';

import { ObjectId, explanationsCollection } from '../db/collections.js';

export interface ExplanationCacheKey {
  contextHash: string;
  promptVersion: string;
  model: string;
}

export type NewExplanationDoc = Omit<ExplanationDoc, '_id'>;

export interface ExplanationStore {
  find(key: ExplanationCacheKey): Promise<ExplanationDoc | null>;
  /**
   * Insert-or-return-existing: on a race against the unique
   * `{contextHash, promptVersion, model}` index, returns the doc the other
   * writer inserted rather than throwing — same idiom as `resolveRepo`'s
   * upsert-and-return in `worker/src/repos.ts`.
   */
  save(doc: NewExplanationDoc): Promise<ExplanationDoc>;
}

const DUPLICATE_KEY_ERROR_CODE = 11000;

function isDuplicateKeyError(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    'code' in err &&
    (err as { code?: unknown }).code === DUPLICATE_KEY_ERROR_CODE
  );
}

export class MongoExplanationStore implements ExplanationStore {
  constructor(private readonly db: Db) {}

  async find(key: ExplanationCacheKey): Promise<ExplanationDoc | null> {
    const doc = await explanationsCollection(this.db).findOne(key);
    return doc === null ? null : { ...doc, _id: doc._id.toHexString() };
  }

  async save(doc: NewExplanationDoc): Promise<ExplanationDoc> {
    const _id = new ObjectId();
    try {
      await explanationsCollection(this.db).insertOne({ _id, ...doc });
      return { ...doc, _id: _id.toHexString() };
    } catch (err) {
      if (isDuplicateKeyError(err)) {
        const existing = await this.find({
          contextHash: doc.contextHash,
          promptVersion: doc.promptVersion,
          model: doc.model,
        });
        if (existing !== null) return existing;
      }
      throw err;
    }
  }
}
