/**
 * Zone 1 (§10): `directCallers` — reverse BFS over `calls`/`implements`/
 * `overrides`, 1–2 hops, full detail, ranked and capped.
 */

import {
  displayNameOf,
  type Confidence,
  type DirectCaller,
  type EdgeDoc,
  type NodeKey,
} from '@impact/shared';

import { CONFIDENCE_RANK, weakerConfidence } from './confidenceRank.js';
import type { GraphReader } from './graphReader.js';

const DIRECT_CALLER_EDGE_TYPES = ['calls', 'implements', 'overrides'] as const;
export const DEFAULT_DIRECT_CALLER_CAP = 15;

export interface DirectCallersResult {
  directCallers: DirectCaller[];
  directCallerTotal: number;
  directCallersTruncated: boolean;
  /** Count of `ambiguous`-confidence paths among *all* callers found, not just the capped list. */
  ambiguousCount: number;
}

interface PathSoFar {
  hops: number;
  confidence: Confidence;
  inferred: boolean;
  /** The edge whose `from` is this caller — closest edge to the caller itself. */
  closestEdge: EdgeDoc;
}

export async function computeDirectCallers(
  reader: GraphReader,
  changedKey: NodeKey,
  opts: { signatureCompatible: boolean; cap?: number },
): Promise<DirectCallersResult> {
  const cap = opts.cap ?? DEFAULT_DIRECT_CALLER_CAP;
  const found = new Map<NodeKey, PathSoFar>();

  const hop1Edges = (
    await reader.incomingEdges(changedKey, [...DIRECT_CALLER_EDGE_TYPES])
  ).filter((e) => e.from !== changedKey);

  for (const edge of hop1Edges) {
    considerPath(found, edge.from, {
      hops: 1,
      confidence: edge.confidence,
      inferred: edge.inferred,
      closestEdge: edge,
    });
  }

  for (const hop1Edge of hop1Edges) {
    const hop2Edges = (
      await reader.incomingEdges(hop1Edge.from, [...DIRECT_CALLER_EDGE_TYPES])
    ).filter((e) => e.from !== changedKey && e.from !== hop1Edge.from);
    for (const edge of hop2Edges) {
      considerPath(found, edge.from, {
        hops: 2,
        confidence: weakerConfidence(edge.confidence, hop1Edge.confidence),
        inferred: edge.inferred || hop1Edge.inferred,
        closestEdge: edge,
      });
    }
  }

  const directCallerTotal = found.size;
  const ambiguousCount = [...found.values()].filter(
    (p) => p.confidence === 'ambiguous',
  ).length;
  const ranked = [...found.entries()]
    .map(([key, path]) => toDirectCaller(key, path, opts.signatureCompatible))
    .sort(compareDirectCallers);

  return {
    directCallers: ranked.slice(0, cap),
    directCallerTotal,
    directCallersTruncated: directCallerTotal > cap,
    ambiguousCount,
  };
}

/** Keeps the shallowest (then most-confident) path found to a given caller key. */
function considerPath(
  found: Map<NodeKey, PathSoFar>,
  key: NodeKey,
  candidate: PathSoFar,
): void {
  const existing = found.get(key);
  if (existing === undefined || candidate.hops < existing.hops) {
    found.set(key, candidate);
  }
}

function toDirectCaller(
  key: NodeKey,
  path: PathSoFar,
  signatureCompatible: boolean,
): DirectCaller {
  const site = path.closestEdge.callSites[0];
  return {
    key,
    displayName: displayNameOf(key),
    hops: path.hops,
    callSite:
      site !== undefined
        ? { filePath: site.filePath, line: site.line }
        : { filePath: '', line: 0 },
    usage: usageOf(path.closestEdge.type),
    signatureCompatible,
    edgeConfidence: path.confidence,
    inferred: path.inferred,
  };
}

/**
 * Honest and minimal by design (see DECISIONS.md "Traversal heuristics and
 * disclosed gaps (M4)"): no dataflow analysis exists anywhere in this
 * pipeline, so `usage` states only what the edge itself proves rather than
 * inventing how a caller uses a return value.
 */
function usageOf(type: EdgeDoc['type']): string {
  switch (type) {
    case 'calls':
      return 'calls this method';
    case 'implements':
      return 'implements this interface method';
    case 'overrides':
      return 'overrides this method';
    default:
      return `reaches this method via a "${type}" edge`;
  }
}

function compareDirectCallers(a: DirectCaller, b: DirectCaller): number {
  // Signature-incompatible first. In v1 this value is uniform across all
  // callers for a given change (§10's stated per-caller-re-resolution
  // limitation — see signatureDiff.ts), so this comparison is a near no-op
  // today; kept for when a future per-call-site check makes it discriminate.
  if (a.signatureCompatible !== b.signatureCompatible) {
    return a.signatureCompatible ? 1 : -1;
  }
  if (a.hops !== b.hops) return a.hops - b.hops;
  return CONFIDENCE_RANK[a.edgeConfidence] - CONFIDENCE_RANK[b.edgeConfidence];
}
