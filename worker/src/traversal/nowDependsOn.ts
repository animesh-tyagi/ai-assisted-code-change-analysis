/**
 * `nowDependsOn` (§10) — forward, exactly one hop, from the head overlay.
 * Pure: the caller already has the overlay's outgoing edges for the changed
 * key (Step 6 will source these from a real `mode: "subset"` parse; fixture
 * tests just build them by hand) and the base graph's callee targets for the
 * same key, to diff `isNew` against.
 */

import {
  displayNameOf,
  type Callee,
  type EdgeDoc,
  type NodeKey,
  type NowDependsOn,
} from '@impact/shared';

export function computeNowDependsOn(
  overlayOutgoingEdges: readonly EdgeDoc[],
  baseOutgoingTargets: ReadonlySet<NodeKey>,
): NowDependsOn {
  const callees: Callee[] = overlayOutgoingEdges.map((edge) => ({
    key: edge.to,
    displayName: displayNameOf(edge.to),
    isNew: !baseOutgoingTargets.has(edge.to),
    edgeConfidence: edge.confidence,
    inferred: edge.inferred,
  }));

  return { callees };
}
