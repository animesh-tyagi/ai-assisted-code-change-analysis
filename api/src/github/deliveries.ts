/**
 * `webhookDeliveries` dedupe (§9.1 step 3). `_id = X-GitHub-Delivery`, so a
 * redelivered webhook fails to insert (Mongo error code 11000) and is
 * dropped in O(1) — no query needed to detect a duplicate.
 */

import type { Db } from 'mongodb';

import { webhookDeliveriesCollection } from '../db/collections.js';
import { isDuplicateKeyError } from '../db/mongoErrors.js';

/**
 * True if this is the first time this delivery id has been seen.
 *
 * `repoId` is always recorded `null` here: at this point the body has only
 * just been parsed and no repo has been resolved/upserted yet (that happens
 * per-event-type, further down the handler) — not worth threading a repo
 * lookup through every event type just to populate one diagnostic field on a
 * dedupe record.
 */
export async function insertDeliveryIfNew(
  db: Db,
  deliveryId: string,
  event: string,
  action: string | null,
): Promise<boolean> {
  try {
    await webhookDeliveriesCollection(db).insertOne({
      _id: deliveryId,
      event,
      action,
      repoId: null,
      receivedAt: new Date(),
      processedAt: null,
    });
    return true;
  } catch (err) {
    if (isDuplicateKeyError(err)) return false;
    throw err;
  }
}

export async function markDeliveryProcessed(db: Db, deliveryId: string): Promise<void> {
  await webhookDeliveriesCollection(db).updateOne(
    { _id: deliveryId },
    { $set: { processedAt: new Date() } },
  );
}
