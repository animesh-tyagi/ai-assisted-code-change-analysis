/**
 * `@impact/shared` — the single source of truth for types that cross package
 * boundaries: the graph model, the context object, and the LLM output contract.
 *
 * Transcribed from ARCHITECTURE.md §6, §7, §10, and §11.5. When the architecture
 * changes, change it here — not in a copy inside /api or /worker.
 */

export * from './graph.js';
export * from './context.js';
export * from './explanation.js';
export * from './nodeKey.js';
export * from './parserWire.js';
