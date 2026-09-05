/**
 * Typed collection getters for the §7 collections the worker owns:
 * `repos`, `graphVersions`, `functions`, `functionVersions`, `surfaces`, `edges`
 * (M3), `explanations` (M5 — the `explanations` cache, §11.2 D-cache), and
 * `installations`, `analyses`, `webhookDeliveries` (M6 — the webhook/queue
 * orchestration layer, §9).
 *
 * `_id` is declared `ObjectIdString` in `@impact/shared` (a hex string at the
 * application boundary — ARCHITECTURE §7), but the Mongo driver's own document
 * type wants a real `ObjectId` for `_id` so `insertOne`/`insertMany` can
 * generate one. `MongoDoc<T>` bridges the two: it's `T` with `_id` narrowed to
 * `ObjectId`, everywhere collections are opened. Call sites convert with
 * `.toHexString()` when a value needs to leave the DB layer as an
 * `ObjectIdString` (matching the rest of the codebase's boundary type).
 *
 * `webhookDeliveries` is the one exception: `_id` is GitHub's own delivery
 * UUID (a string, never an `ObjectId`), so its collection is typed directly
 * off `WebhookDeliveryDoc` rather than through `MongoDoc<T>`.
 */

import type { Collection, Db } from 'mongodb';
import { ObjectId } from 'mongodb';

import type {
  AnalysisDoc,
  EdgeDoc,
  ExplanationDoc,
  FunctionDoc,
  FunctionVersionDoc,
  GraphVersionDoc,
  InstallationDoc,
  RepoDoc,
  SurfaceDoc,
  WebhookDeliveryDoc,
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

export function explanationsCollection(db: Db): Collection<MongoDoc<ExplanationDoc>> {
  return db.collection('explanations');
}

export function installationsCollection(db: Db): Collection<MongoDoc<InstallationDoc>> {
  return db.collection('installations');
}

export function analysesCollection(db: Db): Collection<MongoDoc<AnalysisDoc>> {
  return db.collection('analyses');
}

/** `_id` here is GitHub's delivery UUID (a string), not an `ObjectId` — see module doc. */
export function webhookDeliveriesCollection(db: Db): Collection<WebhookDeliveryDoc> {
  return db.collection('webhookDeliveries');
}

/** Convenience re-export so callers don't need a separate `mongodb` import just for this. */
export { ObjectId };
