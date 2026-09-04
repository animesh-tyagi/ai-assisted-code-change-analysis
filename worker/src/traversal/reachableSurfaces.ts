/**
 * Zone 2 (§10): `reachableSurfaces` — a deeper walk than Zone 1, collapsed to
 * *terminal* surfaces only (intermediate functions are discarded), so a
 * util-method change reports a short list instead of fanning out to hundreds
 * of nodes.
 *
 * `entrypoints` walks reverse (who eventually reaches the change);  `data`
 * walks forward (what the change eventually reaches) to the *same* depth cap
 * — §10's deliberate mirror, resolving Q11: the canonical layered Spring shape
 * (controller → service → repository → entity) puts an entity two `calls`
 * hops from a controller-level change, so a depth-1 walk would report no data
 * surfaces for exactly the changes reviewers care about most.
 */

import {
  parseFunctionKey,
  type Confidence,
  type DataSurface,
  type EdgeDoc,
  type EntrypointSurface,
  type NodeKey,
  type TraversalMeta,
} from '@impact/shared';

import { weakerConfidence } from './confidenceRank.js';
import type { GraphReader } from './graphReader.js';

export const DEFAULT_DEPTH_CAP = 5;

const FUNCTION_HOP_TYPES = ['calls', 'implements', 'overrides'] as const;

interface VisitedNode {
  depth: number;
  confidence: Confidence;
  inferred: boolean;
}

/** BFS by level, shortest-path-first, capped at `depthCap` function hops. */
async function levelWalk(
  reader: GraphReader,
  startKey: NodeKey,
  depthCap: number,
  direction: 'reverse' | 'forward',
): Promise<{ visited: Map<NodeKey, VisitedNode>; depthCapHit: boolean }> {
  const visited = new Map<NodeKey, VisitedNode>([
    [startKey, { depth: 0, confidence: 'exact', inferred: false }],
  ]);
  let frontier: NodeKey[] = [startKey];
  const edgesFrom = (key: NodeKey) =>
    direction === 'reverse'
      ? reader.incomingEdges(key, [...FUNCTION_HOP_TYPES])
      : reader.outgoingEdges(key, ['calls']);
  const neighborOf: (e: EdgeDoc) => NodeKey =
    direction === 'reverse' ? (e) => e.from : (e) => e.to;

  for (let depth = 1; depth <= depthCap && frontier.length > 0; depth++) {
    const nextFrontier: NodeKey[] = [];
    for (const node of frontier) {
      const nodePath = visited.get(node);
      if (nodePath === undefined) continue;
      const edges = await edgesFrom(node);
      for (const edge of edges) {
        const neighbor = neighborOf(edge);
        if (neighbor === node || visited.has(neighbor)) continue;
        visited.set(neighbor, {
          depth,
          confidence: weakerConfidence(edge.confidence, nodePath.confidence),
          inferred: edge.inferred || nodePath.inferred,
        });
        nextFrontier.push(neighbor);
      }
    }
    frontier = nextFrontier;
  }

  let depthCapHit = false;
  for (const node of frontier) {
    const edges = await edgesFrom(node);
    if (edges.some((e) => neighborOf(e) !== node && !visited.has(neighborOf(e)))) {
      depthCapHit = true;
      break;
    }
  }

  return { visited, depthCapHit };
}

export async function computeEntrypoints(
  reader: GraphReader,
  changedKey: NodeKey,
  depthCap: number = DEFAULT_DEPTH_CAP,
): Promise<{ entrypoints: EntrypointSurface[]; traversal: TraversalMeta }> {
  const { visited, depthCapHit } = await levelWalk(
    reader,
    changedKey,
    depthCap,
    'reverse',
  );

  const bestByKey = new Map<NodeKey, EntrypointSurface>();
  for (const [fnKey, path] of visited) {
    const surfaceEdges = await reader.incomingEdges(fnKey, ['handles', 'triggers']);
    for (const edge of surfaceEdges) {
      const surface = await reader.surface(edge.from);
      if (surface === null) continue;
      const candidate: EntrypointSurface = {
        key: edge.from,
        kind: surface.kind as EntrypointSurface['kind'],
        minHops: path.depth + 1,
        viaInferredEdge: path.inferred || edge.inferred,
      };
      const existing = bestByKey.get(candidate.key);
      if (existing === undefined || candidate.minHops < existing.minHops) {
        bestByKey.set(candidate.key, candidate);
      }
    }
  }

  return {
    entrypoints: [...bestByKey.values()],
    traversal: { maxDepth: depthCap, depthCapHit, nodesVisited: visited.size },
  };
}

export async function computeDataSurfaces(
  reader: GraphReader,
  changedKey: NodeKey,
  depthCap: number = DEFAULT_DEPTH_CAP,
): Promise<DataSurface[]> {
  const { visited } = await levelWalk(reader, changedKey, depthCap, 'forward');

  const bestByKey = new Map<NodeKey, DataSurface>();
  for (const [fnKey, path] of visited) {
    const queryEdges = await reader.outgoingEdges(fnKey, ['queries']);
    for (const queryEdge of queryEdges) {
      const entityKey = queryEdge.to;
      const access = accessOf(fnKey);
      const confidence = weakerConfidence(queryEdge.confidence, path.confidence);
      const inferred = path.inferred || queryEdge.inferred;

      const mapsToEdges = await reader.outgoingEdges(entityKey, ['maps_to']);
      const tableEdge = mapsToEdges[0];

      const terminal: DataSurface =
        tableEdge !== undefined
          ? {
              key: tableEdge.to,
              kind: 'table',
              access,
              viaInferredEdge: inferred || tableEdge.inferred,
              confidence: weakerConfidence(confidence, tableEdge.confidence),
            }
          : {
              key: entityKey,
              kind: 'entity',
              access,
              viaInferredEdge: inferred,
              confidence,
            };

      mergeDataSurface(bestByKey, terminal);
    }
  }

  return [...bestByKey.values()];
}

function mergeDataSurface(
  bestByKey: Map<NodeKey, DataSurface>,
  candidate: DataSurface,
): void {
  const existing = bestByKey.get(candidate.key);
  if (existing === undefined) {
    bestByKey.set(candidate.key, candidate);
    return;
  }
  bestByKey.set(candidate.key, {
    key: candidate.key,
    kind: candidate.kind,
    access: combineAccess(existing.access, candidate.access),
    viaInferredEdge: existing.viaInferredEdge || candidate.viaInferredEdge,
    confidence: weakerConfidence(existing.confidence, candidate.confidence),
  });
}

function combineAccess(
  a: DataSurface['access'],
  b: DataSurface['access'],
): DataSurface['access'] {
  return a === b ? a : 'read_write';
}

const READ_VERBS = ['find', 'get', 'read', 'exists', 'count', 'stream'];
const WRITE_VERBS = ['save', 'delete', 'persist'];

/**
 * §6.4's access rule, applied to the repository method's own name. Falls back
 * to `'read'` for an unrecognised verb — repository methods skew heavily
 * toward reads, and this is a display hint, not a correctness-critical flag.
 */
function accessOf(functionKey: NodeKey): DataSurface['access'] {
  const parsed = parseFunctionKey(functionKey);
  if (!parsed.ok) return 'read';
  const name = parsed.value.methodName;
  if (WRITE_VERBS.some((v) => name.startsWith(v))) return 'write';
  if (READ_VERBS.some((v) => name.startsWith(v))) return 'read';
  return 'read';
}
