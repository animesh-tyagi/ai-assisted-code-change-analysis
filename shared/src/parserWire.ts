/**
 * The parser service's HTTP wire contract (ARCHITECTURE.md §8) — `POST /v1/parse`
 * request/response and `GET /v1/version`, exactly as the Java records in
 * `parser/src/main/java/com/impact/parser/api/` and `.../graph/` serialise them.
 *
 * Deliberately **separate from `graph.ts`**: the types there (`FunctionDoc`,
 * `SurfaceDoc`, `EdgeDoc`, ...) are Mongo documents, stamped with `_id`,
 * `repoId`, `graphVersionId` and friends by the worker's index flow (M3). The
 * types here are the raw, unstamped shapes the parser hands back — what the
 * worker's mappers read *from* before producing the Mongo documents. Field
 * names were checked byte-for-byte against
 * `parser/src/test/resources/snapshots/core.json` and
 * `parser/src/test/resources/snapshots/spring-data.json`; plain camelCase
 * throughout (Jackson does not strip an `is` prefix off a record's own
 * accessor — see the `@JsonIgnore` note on `GraphEdge.isUnresolved()` for the
 * one case where that almost went wrong).
 *
 * Reuses `EdgeType` / `SurfaceKind` / `Confidence` / `UnresolvedReason` /
 * `CallSite` / `AnnotationRef` from `graph.ts` — the parser's wire enums and
 * the Mongo documents' fields are the same vocabulary, just attached to
 * different envelopes.
 */

import type {
  AnnotationRef,
  CallSite,
  Confidence,
  EdgeType,
  NodeKey,
  SurfaceKind,
  UnresolvedReason,
} from './graph.js';

/** `POST /v1/parse` request body (`ParseRequest.java`). */
export interface ParseRequestWire {
  requestId: string;
  repoId: string;
  sha: string;
  workspacePath: string;
  mode: 'full' | 'subset';
  /** Workspace-relative paths. Required for `"subset"`, ignored for `"full"`. */
  files: string[];
  options: ParseOptionsWire | null;
}

/** `ParseRequest.ParseOptions` — `null` is treated as defaults by the parser. */
export interface ParseOptionsWire {
  includeTestSources: boolean | null;
}

/** One `functions[]` entry (`ParsedFunction.java`). */
export interface ParsedFunctionWire {
  key: NodeKey;
  fqcn: string;
  className: string;
  methodName: string;
  paramTypes: string[];
  paramNames: string[];
  returnType: string;
  filePath: string;
  startLine: number;
  endLine: number;
  bodyHash: string;
  modifiers: string[];
  annotations: AnnotationRef[];
  isAbstract: boolean;
  isInterfaceMethod: boolean;
  unresolvedParamTypes: number;
}

/** One `surfaces[]` entry (`Surface.java`). `attrs` is kind-specific, all-string. */
export interface SurfaceWire {
  key: NodeKey;
  kind: SurfaceKind;
  attrs: Record<string, string>;
}

/** One `edges[]` entry (`GraphEdge.java`). */
export interface GraphEdgeWire {
  from: NodeKey;
  to: NodeKey;
  type: EdgeType;
  inferred: boolean;
  confidence: Confidence;
  callSites: CallSite[];
  /** Set only when `type === 'unresolved'`. */
  reason: UnresolvedReason | null;
  /** Non-empty only for `reason === 'ambiguous_overload'` (§6.6). */
  candidates: string[];
}

/** One `diagnostics.parseErrors[]` entry (`ParseError.java`). */
export interface ParseErrorWire {
  filePath: string;
  message: string;
}

/** `diagnostics` (`ParseDiagnostics.java`) — see its Javadoc for what each field means. */
export interface ParseDiagnosticsWire {
  durationMs: number;
  filesParsed: number;
  parseErrors: ParseErrorWire[];
  totalEdges: number;
  unresolvedEdges: number;
  unresolvedRate: number;
  nonExternalUnresolvedRate: number;
  externalCalls: number;
  unresolvedParamTypes: number;
  ambiguousOverloads: string[];
  failedDeclarations: number;
  guardedFailures: number;
  targetsMissingFromIndex: number;
}

/** `POST /v1/parse` response body (`ParseResponse.java`). */
export interface ParseResponseWire {
  requestId: string;
  sha: string;
  mode: 'full' | 'subset';
  sourceRoots: string[];
  functions: ParsedFunctionWire[];
  surfaces: SurfaceWire[];
  edges: GraphEdgeWire[];
  diagnostics: ParseDiagnosticsWire;
}

/** `GET /v1/version` response body (`VersionResponse.java`). */
export interface VersionResponseWire {
  parserVersion: string;
  ruleVersion: string;
  javaParserVersion: string;
}
