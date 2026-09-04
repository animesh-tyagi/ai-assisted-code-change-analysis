/**
 * Weakest-link confidence for a multi-hop path. §10 already uses this
 * convention for `viaInferredEdge` (true if any edge on the shortest path was
 * inferred); `directCallers.ts` and `reachableSurfaces.ts` both apply the same
 * idea to `confidence` — a path is only as trustworthy as its weakest edge.
 */

import type { Confidence } from '@impact/shared';

export const CONFIDENCE_RANK: Record<Confidence, number> = {
  exact: 0,
  single_impl: 1,
  regex: 2,
  ambiguous: 3,
};

/** The lower-trust (higher-rank) of two confidence values. */
export function weakerConfidence(a: Confidence, b: Confidence): Confidence {
  return CONFIDENCE_RANK[a] >= CONFIDENCE_RANK[b] ? a : b;
}
