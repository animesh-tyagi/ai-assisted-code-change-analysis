/**
 * Typed collection getters for the collections the API process touches
 * directly: `repos` and `installations` (webhook upserts, §9.1 step 4),
 * `webhookDeliveries` (the redelivery dedupe, §9.1 step 3), `analyses`
 * (creating/superseding analysis docs, §5.2 step 1, and the read endpoints,
 * §9.6), and `explanations` (read-only here — §9.6 embeds each changed
 * function's prose in the analysis response rather than making the frontend
 * do a second round-trip per function). Everything else graph-shaped
 * (`functions`, `edges`, `surfaces`, `graphVersions`) stays worker-only — the
 * API never reads or writes it.
 *
 * Deliberately a separate, smaller copy of `worker/src/db/collections.ts`
 * rather than a cross-package import: `api` and `worker` are independent
 * processes with independent Mongo connection lifecycles, and the overlap is
 * a handful of one-line functions — not enough to be worth a shared runtime
 * module across the process boundary (`@impact/shared` is for types, not
 * driver-bound code). See that file's own doc comment for the `MongoDoc<T>`
 * rationale, reproduced here.
 */

import type { Collection, Db } from 'mongodb';
import { ObjectId } from 'mongodb';

import type {
  AnalysisDoc,
  ExplanationDoc,
  InstallationDoc,
  RepoDoc,
  WebhookDeliveryDoc,
} from '@impact/shared';

export type MongoDoc<T extends { _id: string }> = Omit<T, '_id'> & { _id: ObjectId };

export function reposCollection(db: Db): Collection<MongoDoc<RepoDoc>> {
  return db.collection('repos');
}

export function installationsCollection(db: Db): Collection<MongoDoc<InstallationDoc>> {
  return db.collection('installations');
}

export function analysesCollection(db: Db): Collection<MongoDoc<AnalysisDoc>> {
  return db.collection('analyses');
}

export function explanationsCollection(db: Db): Collection<MongoDoc<ExplanationDoc>> {
  return db.collection('explanations');
}

/** `_id` here is GitHub's delivery UUID (a string), not an `ObjectId`. */
export function webhookDeliveriesCollection(db: Db): Collection<WebhookDeliveryDoc> {
  return db.collection('webhookDeliveries');
}

/** Convenience re-export so callers don't need a separate `mongodb` import just for this. */
export { ObjectId };
