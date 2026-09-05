/**
 * `ExplanationStore` over a plain `Map`, for fixture tests — no Mongo, no
 * Docker. Mirrors `inMemoryGraphReader.ts`'s role for `GraphReader`.
 */

import type { ExplanationDoc } from '@impact/shared';

import type { ExplanationCacheKey, ExplanationStore, NewExplanationDoc } from './explanationStore.js';

function keyOf(key: ExplanationCacheKey): string {
  return `${key.contextHash}::${key.promptVersion}::${key.model}`;
}

export class InMemoryExplanationStore implements ExplanationStore {
  private readonly docs = new Map<string, ExplanationDoc>();
  private nextId = 1;

  find(key: ExplanationCacheKey): Promise<ExplanationDoc | null> {
    return Promise.resolve(this.docs.get(keyOf(key)) ?? null);
  }

  save(doc: NewExplanationDoc): Promise<ExplanationDoc> {
    const cacheKey = keyOf(doc);
    const existing = this.docs.get(cacheKey);
    if (existing !== undefined) return Promise.resolve(existing);

    const saved: ExplanationDoc = { ...doc, _id: String(this.nextId++) };
    this.docs.set(cacheKey, saved);
    return Promise.resolve(saved);
  }
}
