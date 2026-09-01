/**
 * The graph model — transcribed from ARCHITECTURE.md §6 (the model) and §7 (the
 * MongoDB schema). This is the single source of truth for both; the API, the
 * worker, and the eval harness all import from here rather than keeping copies.
 *
 * Two invariants worth restating because they are easy to violate later:
 *
 *  1. Edges live in their own collection (CLAUDE.md rule 3). Never add a
 *     `callers: []` / `callees: []` array to a node type in this file.
 *  2. `EdgeDoc.callSites` is an *array* on a single deduped edge — repeated call
 *     sites collapse into it rather than producing duplicate edge documents
 *     (ARCHITECTURE §7), which is what keeps the unique index valid and stops
 *     reverse traversal double-counting a caller.
 */

/** Mongo ObjectId rendered as a hex string at the application boundary. */
export type ObjectIdString = string;

/** A 40-character git commit SHA (or the abbreviated form in display contexts). */
export type Sha = string;

// ---------------------------------------------------------------------------
// Node keys (ARCHITECTURE §6.1, §6.2)
// ---------------------------------------------------------------------------

/**
 * A namespaced node key, e.g. `fn:com.acme.user.UserService#findById(java.lang.Long)`
 * or `route:GET /api/users/{id}`. Keys are flat strings so `edges.from` / `edges.to`
 * stay directly indexable.
 *
 * See `nodeKey.ts` for parsing and formatting helpers.
 */
export type NodeKey = string;

/** The namespace prefix of a {@link NodeKey}. */
export type NodeKind =
  'fn' | 'route' | 'job' | 'listener' | 'entity' | 'table' | 'unresolved';

// ---------------------------------------------------------------------------
// Edges (ARCHITECTURE §6.3)
// ---------------------------------------------------------------------------

/**
 * Edge types. Direction convention: an edge points **from the dependent to the
 * depended-upon** — `from` needs `to`. Reverse traversal ("what is affected by a
 * change to X") therefore matches `to = X` and collects `from`.
 */
export type EdgeType =
  /** fn → fn: a resolved method invocation. */
  | 'calls'
  /** fn → fn: impl method → the interface method it satisfies. */
  | 'implements'
  /** fn → fn: subclass method → superclass method. */
  | 'overrides'
  /** route → fn: an HTTP route is served by this controller method. */
  | 'handles'
  /** job|listener → fn: a scheduler or broker invokes this method. */
  | 'triggers'
  /** fn → entity: a repository method reads/writes this entity. */
  | 'queries'
  /** entity → table: JPA mapping. */
  | 'maps_to'
  /** fn → unresolved:*: a call site we could not bind. Never dropped. */
  | 'unresolved';

/**
 * How much we trust an edge.
 *
 * - `exact`       — literally written in the source and fully resolved.
 * - `single_impl` — inferred because exactly one candidate existed (the single
 *                   `@Service` impl rule, or a single name+arity overload match).
 * - `ambiguous`   — several candidates; edges emitted to all of them.
 * - `regex`       — extracted textually (e.g. names inside an `@Query` string).
 */
export type Confidence = 'exact' | 'single_impl' | 'ambiguous' | 'regex';

/** Why a call site could not be bound (ARCHITECTURE §6.5). */
export type UnresolvedReason =
  'external_type' | 'ambiguous_overload' | 'parse_error' | 'missing_source';

/** Where in the source an edge was observed. */
export interface CallSite {
  filePath: string;
  line: number;
}

// ---------------------------------------------------------------------------
// Surfaces (ARCHITECTURE §6.2)
// ---------------------------------------------------------------------------

/** Non-method nodes: entry points, data, and the unresolved sink. */
export type SurfaceKind =
  'http_route' | 'scheduled_job' | 'message_listener' | 'entity' | 'table' | 'unresolved';

/** Kind-specific surface attributes. All optional; populated per `SurfaceKind`. */
export interface SurfaceAttrs {
  /** http_route */
  httpMethod?: string;
  /** http_route */
  path?: string;
  /** scheduled_job */
  cron?: string;
  /** message_listener */
  topic?: string;
  /** entity */
  fqcn?: string;
  /** table */
  tableName?: string;
  /** unresolved */
  reason?: UnresolvedReason;
  /** unresolved: the candidate list when `reason` is `ambiguous_overload`. */
  candidates?: string[];
}

// ---------------------------------------------------------------------------
// Graph versions (ARCHITECTURE §7, D3)
// ---------------------------------------------------------------------------

export type GraphVersionKind = 'branch' | 'pr_overlay';

export type GraphVersionStatus = 'building' | 'ready' | 'failed' | 'superseded';

export interface GraphVersionStats {
  functions: number;
  edges: number;
  surfaces: number;
  /** unresolvedEdges / totalEdges — the health metric of ARCHITECTURE §6.5. */
  unresolvedRate: number;
  parseErrors: number;
}

// ---------------------------------------------------------------------------
// Change detection (ARCHITECTURE §5.2 step 6)
// ---------------------------------------------------------------------------

export type ChangeKind = 'added' | 'removed' | 'modified' | 'signature_changed';

// ---------------------------------------------------------------------------
// MongoDB documents (ARCHITECTURE §7)
// ---------------------------------------------------------------------------

/** `installations` — no token is ever stored; see ARCHITECTURE §7. */
export interface InstallationDoc {
  _id: ObjectIdString;
  githubInstallationId: number;
  accountLogin: string;
  accountType: string;
  repositorySelection: string;
  suspendedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

/** `repos` — `currentGraphVersionId` is the pointer flipped by the atomic swap (D3). */
export interface RepoDoc {
  _id: ObjectIdString;
  provider: 'github';
  githubRepoId: number;
  owner: string;
  name: string;
  defaultBranch: string;
  installationId: ObjectIdString;
  currentGraphVersionId: ObjectIdString | null;
  indexingStatus: GraphVersionStatus | 'idle';
  lastIndexedSha: Sha | null;
  lastIndexedAt: Date | null;
  createdAt: Date;
}

/** `graphVersions` — immutable, SHA-stamped (D3). `pinnedBy` guards retention (§9.5). */
export interface GraphVersionDoc {
  _id: ObjectIdString;
  repoId: ObjectIdString;
  sha: Sha;
  kind: GraphVersionKind;
  status: GraphVersionStatus;
  /** Recorded so a parser upgrade invalidates graphs deliberately, not silently. */
  parserVersion: string;
  ruleVersion: number;
  stats: GraphVersionStats;
  /** Analysis ids currently reading this version; retention must not delete it. */
  pinnedBy: ObjectIdString[];
  startedAt: Date;
  completedAt: Date | null;
  error?: string;
}

/**
 * `functions` — permanent identity (C4). Survives retention pruning, so a stable
 * permalink and the change-history cache key can point at it.
 */
export interface FunctionDoc {
  _id: ObjectIdString;
  repoId: ObjectIdString;
  key: NodeKey;
  fqcn: string;
  className: string;
  methodName: string;
  paramTypes: string[];
  firstSeenAt: Date;
  lastSeenAt: Date;
}

/**
 * `functionVersions` — per-graph-version facts (D5). A signature change is the
 * *same* `functionKey` with a new row here, not a new `FunctionDoc`.
 */
export interface FunctionVersionDoc {
  _id: ObjectIdString;
  repoId: ObjectIdString;
  graphVersionId: ObjectIdString;
  functionKey: NodeKey;
  sha: Sha;
  filePath: string;
  startLine: number;
  endLine: number;
  bodyHash: string;
  returnType: string;
  paramNames: string[];
  modifiers: string[];
  annotations: AnnotationRef[];
  isAbstract: boolean;
  isInterfaceMethod: boolean;
}

/** A Java annotation as read off the raw AST (matched by name — see D2). */
export interface AnnotationRef {
  name: string;
  values: Record<string, string>;
}

/** `surfaces` — every non-method node. */
export interface SurfaceDoc {
  _id: ObjectIdString;
  repoId: ObjectIdString;
  graphVersionId: ObjectIdString;
  key: NodeKey;
  kind: SurfaceKind;
  attrs: SurfaceAttrs;
}

/**
 * `edges` — the graph (C5).
 *
 * Unique on `{graphVersionId, from, to, type}`. Repeated call sites collapse into
 * `callSites` rather than producing duplicate documents.
 */
export interface EdgeDoc {
  _id: ObjectIdString;
  repoId: ObjectIdString;
  graphVersionId: ObjectIdString;
  from: NodeKey;
  to: NodeKey;
  type: EdgeType;
  /** True when derived by a Spring rule rather than written literally in source. */
  inferred: boolean;
  confidence: Confidence;
  callSites: CallSite[];
  reason?: UnresolvedReason;
}

// ---------------------------------------------------------------------------
// Analyses and results (ARCHITECTURE §7)
// ---------------------------------------------------------------------------

export type AnalysisStatus =
  | 'queued'
  | 'cloning'
  | 'parsing'
  | 'traversing'
  | 'explaining'
  | 'ready'
  | 'failed'
  | 'superseded';

export interface AnalysisProgress {
  step: string;
  pct: number;
}

export interface AnalysisChangedFunction {
  functionKey: NodeKey;
  changeKind: ChangeKind;
  contextHash: string;
  explanationId: ObjectIdString | null;
}

export interface AnalysisDoc {
  _id: ObjectIdString;
  repoId: ObjectIdString;
  prNumber: number;
  baseSha: Sha;
  headSha: Sha;
  baseGraphVersionId: ObjectIdString | null;
  overlayGraphVersionId: ObjectIdString | null;
  deliveryId: string;
  jobId: string;
  status: AnalysisStatus;
  progress: AnalysisProgress;
  changedFunctions: AnalysisChangedFunction[];
  error?: string;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * `changeHistory` — the `git log -L` cache (C7).
 *
 * `headSha` is part of the cache key because a function's line range moves with
 * every commit; keying on `functionKey` alone would serve stale ranges.
 */
export interface ChangeHistoryDoc {
  _id: ObjectIdString;
  repoId: ObjectIdString;
  functionKey: NodeKey;
  headSha: Sha;
  commits: HistoryCommit[];
  /** `git log -L` cannot cross file renames; set when history stopped early. */
  truncatedAtRename: boolean;
  computedAt: Date;
}

export interface HistoryCommit {
  sha: Sha;
  authorName: string;
  authoredAt: string;
  subject: string;
  insertions: number;
  deletions: number;
}

/** `webhookDeliveries` — `_id` is GitHub's delivery UUID, so redelivery is an O(1) drop. */
export interface WebhookDeliveryDoc {
  _id: string;
  event: string;
  action: string | null;
  repoId: ObjectIdString | null;
  receivedAt: Date;
  processedAt: Date | null;
}
