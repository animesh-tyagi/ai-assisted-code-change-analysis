/**
 * `contextHash` — the first third of the `explanations` cache key (ARCHITECTURE
 * §11.2 D-cache: `sha256(canonicalJson(contextObject)) + promptVersion + model`).
 *
 * Object key order is not semantically meaningful in a `ContextObject`, but
 * `JSON.stringify` is order-sensitive, so two structurally identical context
 * objects built by different code paths could hash differently without a
 * canonical form. `canonicalJson` sorts object keys recursively (arrays keep
 * their order — position is meaningful there, e.g. `directCallers` ranking).
 */

import { createHash } from 'node:crypto';

import type { ContextObject } from '@impact/shared';

export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortKeys);
  }
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) =>
      a < b ? -1 : a > b ? 1 : 0,
    );
    const sorted: Record<string, unknown> = {};
    for (const [key, entryValue] of entries) {
      sorted[key] = sortKeys(entryValue);
    }
    return sorted;
  }
  return value;
}

export function contextHash(contextObject: ContextObject): string {
  return createHash('sha256').update(canonicalJson(contextObject)).digest('hex');
}
