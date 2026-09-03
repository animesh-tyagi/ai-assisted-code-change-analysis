/**
 * Typed collection getters for the six §7 collections this milestone owns:
 * `repos`, `graphVersions`, `functions`, `functionVersions`, `surfaces`, `edges`.
 *
 * `_id` is declared `ObjectIdString` in `@impact/shared` (a hex string at the
 * application boundary — ARCHITECTURE §7), but the Mongo driver's own document
 * type wants a real `ObjectId` for `_id` so `insertOne`/`insertMany` can
 * generate one. `MongoDoc<T>` bridges the two: it's `T` with `_id` narrowed to
 * `ObjectId`, everywhere collections are opened. Call sites convert with
 * `.toHexString()` when a value needs to leave the DB layer as an
 * `ObjectIdString` (matching the rest of the codebase's boundary type).
 */

import type { Collection, Db } from 'mongodb';
import { ObjectId } from 'mongodb';

import type {
  EdgeDoc,
  FunctionDoc,
  FunctionVersionDoc,
  GraphVersionDoc,
  RepoDoc,
  SurfaceDoc,
} from '@impact/shared';

export type MongoDoc<T extends { _id: string }> = Omit<T, '_id'> & { _id: ObjectId };

export function reposCollection(db: Db): Collection<MongoDoc<RepoDoc>> {
  return db.collection('repos');
}

export function graphVersionsCollection(db: Db): Collection<MongoDoc<GraphVersionDoc>> {
  return db.collection('graphVersions');
}

export function functionsCollection(db: Db): Collection<MongoDoc<FunctionDoc>> {
  return db.collection('functions');
}

export function functionVersionsCollection(
  db: Db,
): Collection<MongoDoc<FunctionVersionDoc>> {
  return db.collection('functionVersions');
}

export function surfacesCollection(db: Db): Collection<MongoDoc<SurfaceDoc>> {
  return db.collection('surfaces');
}

export function edgesCollection(db: Db): Collection<MongoDoc<EdgeDoc>> {
  return db.collection('edges');
}

/** Convenience re-export so callers don't need a separate `mongodb` import just for this. */
export { ObjectId };
