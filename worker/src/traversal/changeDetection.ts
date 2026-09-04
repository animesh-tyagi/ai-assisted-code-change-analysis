/**
 * Change detection (ARCHITECTURE §5.2 step 6) — a pure function, no I/O. Takes
 * the base graph's function facts for the touched files and the head
 * overlay's, keyed by `NodeKey`, and classifies each key present in either
 * side.
 *
 * A function's `NodeKey` already encodes its erased parameter types (§6.1),
 * so a parameter-type change can never appear here as a same-key diff — it
 * shows up as a `removed` (old key) plus an `added` (new key) instead, which
 * is exactly what falling out of both `added`/`removed` branches below
 * produces without any special-casing.
 */

import type { ChangeKind, NodeKey } from '@impact/shared';

/** The subset of `FunctionVersionDoc` relevant to diffing and to §10's `signatureDiff`. */
export interface FunctionFacts {
  filePath: string;
  bodyHash: string;
  returnType: string;
  paramNames: string[];
  modifiers: string[];
}

export interface DetectedChange {
  functionKey: NodeKey;
  changeKind: ChangeKind;
}

export function detectChangedFunctions(
  base: ReadonlyMap<NodeKey, FunctionFacts>,
  head: ReadonlyMap<NodeKey, FunctionFacts>,
): DetectedChange[] {
  const keys = new Set<NodeKey>([...base.keys(), ...head.keys()]);
  const changes: DetectedChange[] = [];

  for (const key of keys) {
    const baseFacts = base.get(key);
    const headFacts = head.get(key);

    if (baseFacts === undefined && headFacts !== undefined) {
      changes.push({ functionKey: key, changeKind: 'added' });
      continue;
    }
    if (baseFacts !== undefined && headFacts === undefined) {
      changes.push({ functionKey: key, changeKind: 'removed' });
      continue;
    }
    if (baseFacts === undefined || headFacts === undefined) continue; // unreachable, narrows types below

    if (baseFacts.returnType !== headFacts.returnType) {
      changes.push({ functionKey: key, changeKind: 'signature_changed' });
      continue;
    }
    if (baseFacts.bodyHash !== headFacts.bodyHash) {
      changes.push({ functionKey: key, changeKind: 'modified' });
      continue;
    }
    // Identical on both sides — not a changed function, dropped.
  }

  return changes;
}
