/**
 * `SignatureDiff` (§10) and the `signatureCompatible` heuristic, both pure.
 *
 * Two disclosed simplifications, recorded in DECISIONS.md ("Traversal
 * heuristics and disclosed gaps (M4)"):
 *
 *  - `throwsAdded` is always `[]`. Neither the parser wire contract nor
 *    `FunctionVersionDoc` capture a method's `throws` clause — M2 never
 *    extracted it. `isSignatureCompatible` therefore degrades to "did the
 *    return type change" only.
 *  - "non-wideningly" (§10) is not modelled with real Java widening-
 *    conversion rules. Any return-type string difference is treated as
 *    incompatible — the conservative direction: a false "incompatible" costs
 *    a hedge in prose, a false "compatible" would hide a real break.
 *
 * A caller's `signatureCompatible` is *not* per-call-site here (§10's own
 * stated limitation: a full check needs re-resolving every caller at head,
 * which D4 doesn't do for untouched files). Since a `NodeKey` already encodes
 * erased param types (§6.1), a same-key change can only differ in return type
 * or `throws` — so one `SignatureDiff` describes the whole change, and
 * `isSignatureCompatible` is applied uniformly to every direct caller.
 */

import type { ChangeKind, NodeKey, SignatureDiff } from '@impact/shared';

import { parseFunctionKey, simpleTypeName } from '@impact/shared';

import type { FunctionFacts } from './changeDetection.js';

/** `null` for the side that doesn't exist (`added` has no base; `removed` has no head). */
export function buildSignatureDiff(
  key: NodeKey,
  base: FunctionFacts | null,
  head: FunctionFacts | null,
): SignatureDiff {
  return {
    base: base === null ? '' : renderSignature(key, base),
    head: head === null ? '' : renderSignature(key, head),
    returnTypeChanged:
      base !== null && head !== null && base.returnType !== head.returnType,
    // Param *types* are part of the key (§6.1); a same-key pair can never
    // differ here. Kept as a real, always-false-in-v1 field rather than
    // dropped, so the schema stays forward-compatible with a future
    // rename-linking feature (Q1) that could compare across keys.
    paramsChanged: false,
    // No `throws` data available (see module doc).
    throwsAdded: [],
    visibilityChanged:
      base !== null &&
      head !== null &&
      visibilityOf(base.modifiers) !== visibilityOf(head.modifiers),
  };
}

/**
 * `false` for a `removed` change — the method no longer exists to call, which
 * is the one case that is unconditionally incompatible regardless of what the
 * diff fields say (there's nothing left for a base-graph caller to bind to).
 * Otherwise: incompatible if the return type changed or a `throws` was added.
 */
export function isSignatureCompatible(
  changeKind: ChangeKind,
  diff: SignatureDiff,
): boolean {
  if (changeKind === 'removed') return false;
  return !diff.returnTypeChanged && diff.throwsAdded.length === 0;
}

function renderSignature(key: NodeKey, facts: FunctionFacts): string {
  const parsed = parseFunctionKey(key);
  if (!parsed.ok) return key;

  const { methodName, paramTypes } = parsed.value;
  const visibility = visibilityOf(facts.modifiers);
  const otherModifiers = facts.modifiers.filter((m) => m !== visibility);
  const params = paramTypes
    .map(
      (type, i) => `${simpleTypeName(type)} ${facts.paramNames[i] ?? `arg${String(i)}`}`,
    )
    .join(', ');

  const prefix = [visibility, ...otherModifiers].filter((m) => m !== '').join(' ');
  return `${prefix} ${simpleTypeName(facts.returnType)} ${methodName}(${params})`.trim();
}

const VISIBILITY_MODIFIERS = new Set(['public', 'protected', 'private']);

/** Falls back to package-private (`''`) when no visibility modifier is present. */
function visibilityOf(modifiers: readonly string[]): string {
  return modifiers.find((m) => VISIBILITY_MODIFIERS.has(m)) ?? '';
}
