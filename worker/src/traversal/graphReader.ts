/**
 * The seam between traversal logic and how graph data is actually fetched.
 * `MongoGraphReader` queries one pinned `graphVersionId` (D8) using the
 * reverse/forward indexes M3 created; `InMemoryGraphReader`
 * (`inMemoryGraphReader.ts`) implements the same interface over plain arrays
 * for fixture tests and, later, the eval harness (M8) — no Mongo, no Docker.
 *
 * Mirrors the `TypeSolver`/`LLMProvider` interface-seam pattern already used
 * elsewhere in this project (D2, §11.2): the traversal algorithms in this
 * directory never know which implementation they're talking to.
 */

import type { Db } from 'mongodb';

import type {
  EdgeDoc,
  EdgeType,
  FunctionVersionDoc,
  NodeKey,
  SurfaceDoc,
} from '@impact/shared';

import type { MongoDoc } from '../db/collections.js';
import {
  edgesCollection,
  functionVersionsCollection,
  surfacesCollection,
} from '../db/collections.js';

export interface GraphReader {
  /** Edges where `from = key`, optionally filtered to `types`. */
  outgoingEdges(key: NodeKey, types?: EdgeType[]): Promise<EdgeDoc[]>;
  /** Edges where `to = key`, optionally filtered to `types` — the reverse-traversal hot path. */
  incomingEdges(key: NodeKey, types?: EdgeType[]): Promise<EdgeDoc[]>;
  functionVersion(key: NodeKey): Promise<FunctionVersionDoc | null>;
  surface(key: NodeKey): Promise<SurfaceDoc | null>;
}

export class MongoGraphReader implements GraphReader {
  constructor(
    private readonly db: Db,
    private readonly graphVersionId: string,
  ) {}

  async outgoingEdges(key: NodeKey, types?: EdgeType[]): Promise<EdgeDoc[]> {
    const docs = await edgesCollection(this.db)
      .find({
        graphVersionId: this.graphVersionId,
        from: key,
        ...(types !== undefined ? { type: { $in: types } } : {}),
      })
      .toArray();
    return docs.map(toEdgeDoc);
  }

  async incomingEdges(key: NodeKey, types?: EdgeType[]): Promise<EdgeDoc[]> {
    const docs = await edgesCollection(this.db)
      .find({
        graphVersionId: this.graphVersionId,
        to: key,
        ...(types !== undefined ? { type: { $in: types } } : {}),
      })
      .toArray();
    return docs.map(toEdgeDoc);
  }

  async functionVersion(key: NodeKey): Promise<FunctionVersionDoc | null> {
    const doc = await functionVersionsCollection(this.db).findOne({
      graphVersionId: this.graphVersionId,
      functionKey: key,
    });
    return doc === null ? null : { ...doc, _id: doc._id.toHexString() };
  }

  async surface(key: NodeKey): Promise<SurfaceDoc | null> {
    const doc = await surfacesCollection(this.db).findOne({
      graphVersionId: this.graphVersionId,
      key,
    });
    return doc === null ? null : { ...doc, _id: doc._id.toHexString() };
  }
}

function toEdgeDoc(doc: MongoDoc<EdgeDoc>): EdgeDoc {
  return { ...doc, _id: doc._id.toHexString() };
}
