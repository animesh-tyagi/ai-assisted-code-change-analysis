/**
 * `buildContextObject` — composes change detection's output, Zone 1, Zone 2,
 * and `nowDependsOn` into one `ContextObject` (§10), the only thing that ever
 * crosses the LLM boundary (CLAUDE.md rule 1).
 *
 * Deliberately excludes anything that needs git or a live worktree —
 * `sourceDiff` and `changeHistory` are caller-supplied inputs here, not
 * computed. Step 6 (webhook + queue orchestration) is what will produce them
 * for real and call this function per changed key from the analyze flow
 * (§5.2 step 7).
 */

import {
  displayNameOf,
  CONTEXT_SCHEMA_VERSION,
  type ChangeHistory,
  type ChangeKind,
  type ContextObject,
  type ContextRepo,
  type EdgeDoc,
  type NodeKey,
} from '@impact/shared';

import type { FunctionFacts } from './changeDetection.js';
import { DEFAULT_DIRECT_CALLER_CAP, computeDirectCallers } from './directCallers.js';
import type { GraphReader } from './graphReader.js';
import { computeNowDependsOn } from './nowDependsOn.js';
import {
  DEFAULT_DEPTH_CAP,
  computeDataSurfaces,
  computeEntrypoints,
} from './reachableSurfaces.js';
import { buildSignatureDiff, isSignatureCompatible } from './signatureDiff.js';

const EMPTY_CHANGE_HISTORY: ChangeHistory = { commits: [], truncatedAtRename: false };

export interface BuildContextInput {
  repo: ContextRepo;
  changedFunctionKey: NodeKey;
  changeKind: ChangeKind;
  /** `null` when the key doesn't exist on that side — see `changeDetection.ts`. */
  baseFacts: FunctionFacts | null;
  headFacts: FunctionFacts | null;
  /** Unified diff of the method only (Q7) — computed from git by the caller; see module doc. */
  sourceDiff: string;
  /** Head overlay's outgoing edges `from` the changed key (empty for a `removed` change). */
  overlayOutgoingEdges: readonly EdgeDoc[];
  /** Base graph's callee targets for the changed key, to diff `isNew` against. */
  baseOutgoingTargets: ReadonlySet<NodeKey>;
  /** Defaults to empty — `git log -L` (C7/§12) is its own milestone. */
  changeHistory?: ChangeHistory;
  /** The pinned base graph's `stats.unresolvedRate` (§7). */
  baseUnresolvedRate: number;
  parseErrorsInTouchedFiles: number;
  directCallerCap?: number;
  depthCap?: number;
}

export async function buildContextObject(
  reader: GraphReader,
  input: BuildContextInput,
): Promise<ContextObject> {
  const signatureDiff = buildSignatureDiff(
    input.changedFunctionKey,
    input.baseFacts,
    input.headFacts,
  );
  const signatureCompatible = isSignatureCompatible(input.changeKind, signatureDiff);

  const directCallersResult = await computeDirectCallers(
    reader,
    input.changedFunctionKey,
    {
      signatureCompatible,
      cap: input.directCallerCap ?? DEFAULT_DIRECT_CALLER_CAP,
    },
  );

  const depthCap = input.depthCap ?? DEFAULT_DEPTH_CAP;
  const { entrypoints, traversal } = await computeEntrypoints(
    reader,
    input.changedFunctionKey,
    depthCap,
  );
  const data = await computeDataSurfaces(reader, input.changedFunctionKey, depthCap);

  const nowDependsOn = computeNowDependsOn(
    input.overlayOutgoingEdges,
    input.baseOutgoingTargets,
  );

  const ambiguousEdgesOnPath =
    directCallersResult.ambiguousCount +
    data.filter((d) => d.confidence === 'ambiguous').length;

  const facts = input.headFacts ?? input.baseFacts;

  return {
    schemaVersion: CONTEXT_SCHEMA_VERSION,
    repo: input.repo,
    changedMethod: {
      key: input.changedFunctionKey,
      displayName: displayNameOf(input.changedFunctionKey),
      changeKind: input.changeKind,
      filePath: facts?.filePath ?? '',
      signatureDiff,
      sourceDiff: input.sourceDiff,
    },
    affectedBy: {
      directCallers: directCallersResult.directCallers,
      directCallerTotal: directCallersResult.directCallerTotal,
      directCallersTruncated: directCallersResult.directCallersTruncated,
      reachableSurfaces: { entrypoints, data },
      traversal,
    },
    nowDependsOn,
    changeHistory: input.changeHistory ?? EMPTY_CHANGE_HISTORY,
    quality: {
      unresolvedRate: input.baseUnresolvedRate,
      ambiguousEdgesOnPath,
      parseErrorsInTouchedFiles: input.parseErrorsInTouchedFiles,
    },
  };
}
