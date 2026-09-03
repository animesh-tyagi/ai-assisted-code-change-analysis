/**
 * MongoDB connection — a single `MongoClient` for the life of the process
 * (ARCHITECTURE §4: the worker is the only process that writes to Mongo, pre-M6).
 *
 * Mongo runs as a standalone instance in local dev (`docker-compose.yml`), not a
 * replica set — no multi-document transactions are used anywhere in the index
 * flow; the atomic swap (D3) is a single-document update.
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
