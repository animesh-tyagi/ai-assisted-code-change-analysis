/**
 * The context object — transcribed from ARCHITECTURE.md §10.
 *
 * This is the *only* thing that crosses the LLM boundary (CLAUDE.md rule 1). No
 * repo access, no DB handle, no tools, no retrieval. If a fact is not in this
 * object, it must not appear in the generated prose.
 *
 * Two consequences that shape the types below:
 *
 *  - **Everything numeric is precomputed** (CLAUDE.md rule 6). `directCallerTotal`,
 *    `minHops`, `nodesVisited` and friends are graph facts. The model is never
 *    asked to count, so these are always present and always exact.
 *  - **This schema is the eval ground truth.** `directCallers`,
 *    `reachableSurfaces`, and the `signatureCompatible` flags are exactly what the
 *    M8 rubric scores — so this file and the rubric change together.
 */

import type {
  ChangeKind,
  Confidence,
  HistoryCommit,
  NodeKey,
  SurfaceKind,
} from './graph.js';

/** Bump when the shape changes; the LLM prompt is versioned against it. */
export const CONTEXT_SCHEMA_VERSION = 1;

export interface ContextObject {
  schemaVersion: typeof CONTEXT_SCHEMA_VERSION;
  repo: ContextRepo;
  changedMethod: ChangedMethod;
  /** REVERSE — who is hurt by this change. */
  affectedBy: AffectedBy;
  /** FORWARD — what this change now depends on. Kept structurally separate from
   *  `affectedBy` so the two relationships cannot be conflated. */
  nowDependsOn: NowDependsOn;
  changeHistory: ChangeHistory;
  quality: QualityMeta;
}

export interface ContextRepo {
  owner: string;
  name: string;
  prNumber: number;
}

// ---------------------------------------------------------------------------
// The change itself
// ---------------------------------------------------------------------------

export interface ChangedMethod {
  key: NodeKey;
  /** Human-readable short form, e.g. `UserService.findById(Long)`. */
  displayName: string;
  changeKind: ChangeKind;
  filePath: string;
  signatureDiff: SignatureDiff;
  /**
   * Unified diff of *this method only*, capped (~200 lines) — Q7 in §16.1.
   * Caller bodies are deliberately never included.
   */
  sourceDiff: string;
}

export interface SignatureDiff {
  base: string;
  head: string;
  returnTypeChanged: boolean;
  paramsChanged: boolean;
  throwsAdded: string[];
  visibilityChanged: boolean;
}

// ---------------------------------------------------------------------------
// Zone 1 + Zone 2: the reverse walk
// ---------------------------------------------------------------------------

export interface AffectedBy {
  /** Zone 1: 1–2 hops, detailed, ranked signature-incompatible first. Capped. */
  directCallers: DirectCaller[];
  /** The true total from the graph, even when `directCallers` is truncated. */
  directCallerTotal: number;
  directCallersTruncated: boolean;
  /** Zone 2: deeper reverse walk collapsed to terminal surfaces only. */
  reachableSurfaces: ReachableSurfaces;
  traversal: TraversalMeta;
}

export interface DirectCaller {
  key: NodeKey;
  displayName: string;
  hops: number;
  callSite: { filePath: string; line: number };
  /** How the caller uses the result, e.g. "return value assigned and dereferenced". */
  usage: string;
  /**
   * Signature-level heuristic, not a compiler verdict — for callers in files the
   * PR did not touch we do not re-resolve at head (D4). See ARCHITECTURE §10.
   */
  signatureCompatible: boolean;
  edgeConfidence: Confidence;
  inferred: boolean;
}

export interface ReachableSurfaces {
  /** Collected in the REVERSE direction: routes, jobs, listeners. */
  entrypoints: EntrypointSurface[];
  /**
   * Collected in the FORWARD direction — a table is downstream of the method,
   * not upstream. Reported here because "which tables does this touch" is what a
   * reviewer wants, but it is a different relationship from `entrypoints`
   * (Q4 in §16.1).
   */
  data: DataSurface[];
}

export interface EntrypointSurface {
  key: NodeKey;
  kind: Extract<SurfaceKind, 'http_route' | 'scheduled_job' | 'message_listener'>;
  minHops: number;
  /**
   * True when any edge on the shortest path was Spring-inferred rather than
   * literally written — the prompt requires hedged phrasing when it is set.
   */
  viaInferredEdge: boolean;
}

export interface DataSurface {
  key: NodeKey;
  kind: Extract<SurfaceKind, 'entity' | 'table'>;
  access: 'read' | 'write' | 'read_write';
  viaInferredEdge: boolean;
  confidence: Confidence;
}

export interface TraversalMeta {
  maxDepth: number;
  /** True when the depth cap stopped the walk — the result may be incomplete. */
  depthCapHit: boolean;
  nodesVisited: number;
}

// ---------------------------------------------------------------------------
// The forward section
// ---------------------------------------------------------------------------

export interface NowDependsOn {
  /** Forward, exactly one hop. */
  callees: Callee[];
}

export interface Callee {
  key: NodeKey;
  displayName: string;
  /** Computed by diffing the head overlay's outgoing edges against the base graph. */
  isNew: boolean;
  edgeConfidence: Confidence;
  inferred: boolean;
}

// ---------------------------------------------------------------------------
// History and quality
// ---------------------------------------------------------------------------

export interface ChangeHistory {
  commits: HistoryCommit[];
  truncatedAtRename: boolean;
}

/**
 * Analysis-quality signals. A high `unresolvedRate` or any
 * `ambiguousEdgesOnPath` forces a visible caveat line in the UI — the system
 * says how confident it is in the same place it says what it found.
 */
export interface QualityMeta {
  unresolvedRate: number;
  ambiguousEdgesOnPath: number;
  parseErrorsInTouchedFiles: number;
}
