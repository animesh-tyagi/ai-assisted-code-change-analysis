/**
 * Node key helpers — the string form defined in ARCHITECTURE.md §6.1.
 *
 * ## Scope boundary (important)
 *
 * Key *derivation* — Java source → normalised key, via
 * `ResolvedMethodDeclaration.getQualifiedSignature()`, generics erasure, varargs
 * flattening — belongs to the **parser service in Java** (M2). It is the single
 * source of truth for how a key is produced.
 *
 * This module deliberately does **not** re-implement that. It only parses,
 * formats, and validates the already-normalised string form that the parser
 * emits. Duplicating derivation in TypeScript would give the project's most
 * load-bearing identifier two sources of truth that could silently disagree.
 *
 * Key shapes (ARCHITECTURE §6.1):
 *
 * ```
 * fn:com.acme.user.UserService#findById(java.lang.Long)
 * route:GET /api/users/{id}
 * job:com.acme.billing.NightlyJob#run()
 * listener:kafka:orders.created
 * entity:com.acme.user.User
 * table:user_account
 * unresolved:org.springframework...#save(java.lang.Object)
 * ```
 */

import type { NodeKey, NodeKind } from './graph.js';

/** Every valid namespace prefix, in the order documented in §6.1. */
export const NODE_KINDS = [
  'fn',
  'route',
  'job',
  'listener',
  'entity',
  'table',
  'unresolved',
] as const satisfies readonly NodeKind[];

const NODE_KIND_SET: ReadonlySet<string> = new Set<string>(NODE_KINDS);

/** The parts of a parsed `fn:` key. */
export interface ParsedFunctionKey {
  /** Fully-qualified class name, e.g. `com.acme.user.UserService`. */
  fqcn: string;
  /** Simple class name, e.g. `UserService`. For a nested class, `Outer.Inner`. */
  className: string;
  methodName: string;
  /** Fully-qualified, erased parameter types. Empty for a zero-arg method. */
  paramTypes: string[];
}

/**
 * A parse outcome. Malformed input returns `{ ok: false }` rather than throwing —
 * keys arrive from the parser service over HTTP and from stored documents, so
 * callers should handle bad input as data, not as an exception.
 */
export type ParseResult<T> = { ok: true; value: T } | { ok: false; error: string };

/**
 * Returns the namespace prefix of a key, or `null` if it has none / an unknown one.
 *
 * Note `listener:` keys carry a second colon (`listener:kafka:orders.created`);
 * only the first segment is the kind.
 */
export function nodeKindOf(key: NodeKey): NodeKind | null {
  const colon = key.indexOf(':');
  if (colon <= 0) return null;
  const prefix = key.slice(0, colon);
  return NODE_KIND_SET.has(prefix) ? (prefix as NodeKind) : null;
}

/** True when `key` carries a recognised namespace prefix. */
export function isNodeKey(key: string): key is NodeKey {
  return nodeKindOf(key) !== null;
}

/** True when `key` is a function node (`fn:`). */
export function isFunctionKey(key: string): boolean {
  return nodeKindOf(key) === 'fn';
}

/**
 * Builds a `fn:` key from its parts.
 *
 * The caller supplies types that are already fully qualified and erased — this
 * function does not transform them (see the scope boundary above). It joins
 * parameter types with `,` and no spaces, which is the canonical form: keys are
 * compared as exact strings and used as Mongo index values, so incidental
 * whitespace would fragment identity.
 */
export function formatFunctionKey(parts: {
  fqcn: string;
  methodName: string;
  paramTypes: readonly string[];
}): NodeKey {
  return `fn:${parts.fqcn}#${parts.methodName}(${parts.paramTypes.join(',')})`;
}

/**
 * Parses a `fn:` key back into its parts.
 *
 * Rejects anything that is not a well-formed function key, including keys of
 * another kind — callers that want to branch on kind should use
 * {@link nodeKindOf} first.
 */
export function parseFunctionKey(key: string): ParseResult<ParsedFunctionKey> {
  if (!key.startsWith('fn:')) {
    return { ok: false, error: `not a function key: ${key}` };
  }

  const body = key.slice('fn:'.length);

  const hash = body.indexOf('#');
  if (hash <= 0) {
    return { ok: false, error: `missing '#' between class and method: ${key}` };
  }

  const fqcn = body.slice(0, hash);
  const rest = body.slice(hash + 1);

  const open = rest.indexOf('(');
  if (open <= 0 || !rest.endsWith(')')) {
    return { ok: false, error: `missing parameter list: ${key}` };
  }

  const methodName = rest.slice(0, open);
  const paramList = rest.slice(open + 1, -1);

  // `()` means zero parameters; `(a,b)` splits on commas. Erased types never
  // contain a comma (generics are stripped by the parser), so a plain split is
  // safe here.
  const paramTypes = paramList === '' ? [] : paramList.split(',');
  if (paramTypes.some((t) => t === '')) {
    return { ok: false, error: `empty parameter type: ${key}` };
  }

  const lastDot = fqcn.lastIndexOf('.');
  const className = lastDot === -1 ? fqcn : fqcn.slice(lastDot + 1);

  return {
    ok: true,
    value: { fqcn, className, methodName, paramTypes },
  };
}

/**
 * Short, human-readable form for UI and prose, e.g.
 * `fn:com.acme.user.UserService#findById(java.lang.Long)` →
 * `UserService.findById(Long)`.
 *
 * Only the *simple* name of each parameter type is kept. This is presentation
 * only — never use the result as an identifier, since simple names collide.
 */
export function displayNameOf(key: NodeKey): string {
  const parsed = parseFunctionKey(key);
  if (!parsed.ok) return key;

  const { className, methodName, paramTypes } = parsed.value;
  const simpleParams = paramTypes.map(simpleTypeName).join(', ');
  return `${className}.${methodName}(${simpleParams})`;
}

/** `java.lang.Long` → `Long`; `java.lang.String[]` → `String[]`. */
function simpleTypeName(type: string): string {
  const arraySuffixAt = type.indexOf('[');
  const base = arraySuffixAt === -1 ? type : type.slice(0, arraySuffixAt);
  const suffix = arraySuffixAt === -1 ? '' : type.slice(arraySuffixAt);
  const lastDot = base.lastIndexOf('.');
  return (lastDot === -1 ? base : base.slice(lastDot + 1)) + suffix;
}
