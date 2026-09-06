/**
 * MongoDB connection for the API process — a single `MongoClient` for the
 * life of the process, mirroring `worker/src/db/client.ts`.
 *
 * The topology note in ARCHITECTURE §4 ("only the worker touches Mongo
 * writes") describes the *graph*-writing work (functions/edges/surfaces/
 * graphVersions); §9.1 is explicit that the webhook handler itself performs
 * two small writes inline — the `webhookDeliveries` dedupe insert and the
 * `installations`/`repos` upsert — before enqueuing and returning `202`. This
 * client exists for exactly those two writes, not for anything graph-shaped.
 */

import { MongoClient, type Db } from 'mongodb';

let client: MongoClient | null = null;

export async function connect(mongoUrl: string, mongoDb: string): Promise<Db> {
  client = new MongoClient(mongoUrl);
  await client.connect();
  return client.db(mongoDb);
}

export async function close(): Promise<void> {
  await client?.close();
  client = null;
}
