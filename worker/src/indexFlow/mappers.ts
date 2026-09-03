/**
 * Pure functions: a parser `ParseResponseWire` (§8) → the Mongo documents the
 * index flow stamps and writes (§5.1 step 6, §7). No I/O — unit-tested directly
 * against fixture wire objects in `mappers.test.ts`.
 */

import type {
  EdgeDoc,
  FunctionDoc,
  FunctionVersionDoc,
  GraphVersionStats,
  ObjectIdString,
  ParseDiagnosticsWire,
  ParseResponseWire,
  SurfaceDoc,
} from '@impact/shared';

import type { MongoDoc } from '../db/collections.js';

type NewDoc<T extends { _id: string }> = Omit<MongoDoc<T>, '_id'>;

export function toFunctionVersionDocs(
  response: ParseResponseWire,
  repoId: ObjectIdString,
  graphVersionId: ObjectIdString,
): NewDoc<FunctionVersionDoc>[] {
  return response.functions.map((fn) => ({
    repoId,
    graphVersionId,
    functionKey: fn.key,
    sha: response.sha,
    filePath: fn.filePath,
    startLine: fn.startLine,
    endLine: fn.endLine,
    bodyHash: fn.bodyHash,
    returnType: fn.returnType,
    paramNames: fn.paramNames,
    modifiers: fn.modifiers,
    annotations: fn.annotations,
    isAbstract: fn.isAbstract,
    isInterfaceMethod: fn.isInterfaceMethod,
  }));
}

export function toSurfaceDocs(
  response: ParseResponseWire,
  repoId: ObjectIdString,
  graphVersionId: ObjectIdString,
): NewDoc<SurfaceDoc>[] {
  return response.surfaces.map((surface) => ({
    repoId,
    graphVersionId,
    key: surface.key,
    kind: surface.kind,
    attrs: surface.attrs,
  }));
}

export function toEdgeDocs(
  response: ParseResponseWire,
  repoId: ObjectIdString,
  graphVersionId: ObjectIdString,
): NewDoc<EdgeDoc>[] {
  return response.edges.map((edge) => ({
    repoId,
    graphVersionId,
    from: edge.from,
    to: edge.to,
    type: edge.type,
    inferred: edge.inferred,
    confidence: edge.confidence,
    callSites: edge.callSites,
    // `exactOptionalPropertyTypes` forbids `reason: undefined` — omit the key
    // entirely rather than carry the wire's explicit `null` through.
    ...(edge.reason !== null ? { reason: edge.reason } : {}),
  }));
}

/** One `functions` upsert (permanent identity, D5): `$setOnInsert` + `$set`. */
export interface FunctionUpsert {
  filter: { repoId: ObjectIdString; key: string };
  setOnInsert: Omit<NewDoc<FunctionDoc>, 'lastSeenAt'>;
  set: { lastSeenAt: Date };
}

export function toFunctionUpserts(
  response: ParseResponseWire,
  repoId: ObjectIdString,
  now: Date,
): FunctionUpsert[] {
  return response.functions.map((fn) => ({
    filter: { repoId, key: fn.key },
    setOnInsert: {
      repoId,
      key: fn.key,
      fqcn: fn.fqcn,
      className: fn.className,
      methodName: fn.methodName,
      paramTypes: fn.paramTypes,
      firstSeenAt: now,
    },
    set: { lastSeenAt: now },
  }));
}

/**
 * `GraphVersionStats` (§7). Counts come from the response arrays themselves —
 * not recomputed independently from diagnostics — so a mismatch between what
 * was written and what was reported would show up as a bug, not get silently
 * papered over by trusting two sources that should already agree.
 */
export function computeStats(
  response: Pick<ParseResponseWire, 'functions' | 'edges' | 'surfaces'>,
  diagnostics: ParseDiagnosticsWire,
): GraphVersionStats {
  return {
    functions: response.functions.length,
    edges: response.edges.length,
    surfaces: response.surfaces.length,
    unresolvedRate: diagnostics.unresolvedRate,
    nonExternalUnresolvedRate: diagnostics.nonExternalUnresolvedRate,
    externalCalls: diagnostics.externalCalls,
    parseErrors: diagnostics.parseErrors.length,
  };
}
