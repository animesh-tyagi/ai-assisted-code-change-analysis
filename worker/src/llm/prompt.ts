/**
 * The frozen prompt (ARCHITECTURE §11.2 / §11.3): instruction block + edge and
 * confidence vocabulary + few-shots, versioned as `PROMPT_VERSION`. This text is
 * part of the `explanations` cache key (§11.2 D-cache) — editing anything below
 * must bump `PROMPT_VERSION` so the cache invalidates deliberately rather than
 * silently serving stale prose for a changed prompt.
 *
 * Nothing here is Gemini-specific; `geminiProvider.ts` is the only file that
 * knows how to hand this text to a particular API.
 */

import type { ContextObject, ValidationViolation } from '@impact/shared';

export const PROMPT_VERSION = 'v1';

const INSTRUCTIONS = `You are turning a precomputed code-impact analysis into three short prose sections for a code reviewer.

You will be given exactly one JSON object below: the context object. It is the *only* source of truth. State only facts that are present, verbatim, in that JSON object. Never invent a class, method, route, table, file path, commit SHA, author name, or number that is not present in the object — if it is not there, it did not happen.

Produce exactly three sections, each 1-4 sentences, each sourced from only the part of the object named:
- "whatChanged": sourced from "changedMethod" only.
- "whoIsAffected": sourced from "affectedBy" only.
- "whatToCheck": sourced from "affectedBy", "nowDependsOn", and "quality" only.

Do not restate a number from "changedMethod.sourceDiff" or invent one of your own — every number you state must appear somewhere in the JSON object.`;

const VOCABULARY = `Vocabulary you will see on edges and surfaces, and how to phrase it:
- "edgeConfidence"/"confidence": "exact" means literally written in source and fully resolved — state it flatly. "single_impl" means inferred because exactly one candidate existed (e.g. the single @Service implementation) — say "via the single implementation" or similar, never flatly. "ambiguous" means several candidates existed and edges go to all of them — say "one of several candidate implementations" or similar, never flatly. "regex" means textually extracted (e.g. from an @Query string) — hedge the same way.
- "inferred": true means the edge was derived by a Spring rule rather than literally written in the source — the same hedging rule applies whenever you mention it.
- "viaInferredEdge": true on a surface means at least one edge on the path to it was inferred — hedge the same way when describing how that surface is reached.
- "signatureCompatible": false means a caller's usage may now be broken by this change (arity, type, return type, or a new checked exception) — call this out plainly in "whatToCheck" when present.
- "quality.unresolvedRate" and "quality.ambiguousEdgesOnPath": never restate these as a number or percentage. Only mention them, qualitatively (e.g. "a notable share of calls in the base graph are unresolved"), when they are non-trivial — unresolvedRate clearly above a few percent, or ambiguousEdgesOnPath greater than zero.`;

const FEW_SHOTS = `--- Example 1 ---
Context object (trimmed):
{
  "changedMethod": {
    "displayName": "FooService.findById(Long)",
    "changeKind": "signature_changed",
    "filePath": "src/main/java/com/acme/service/FooService.java",
    "signatureDiff": { "base": "public Foo findById(Long id)", "head": "public Optional<Foo> findById(Long id)", "returnTypeChanged": true, "paramsChanged": false, "throwsAdded": [], "visibilityChanged": false }
  },
  "affectedBy": {
    "directCallers": [
      { "displayName": "FooController.get(Long)", "hops": 1, "callSite": { "filePath": "src/main/java/com/acme/web/FooController.java", "line": 28 }, "usage": "return value assigned and dereferenced", "signatureCompatible": false, "edgeConfidence": "exact", "inferred": false }
    ],
    "directCallerTotal": 1,
    "directCallersTruncated": false,
    "reachableSurfaces": {
      "entrypoints": [ { "key": "route:GET /api/foos/{id}", "minHops": 2, "viaInferredEdge": true } ],
      "data": [ { "key": "table:foo", "access": "read", "viaInferredEdge": true, "confidence": "single_impl" } ]
    }
  },
  "nowDependsOn": { "callees": [] },
  "quality": { "unresolvedRate": 0.0, "ambiguousEdgesOnPath": 0, "parseErrorsInTouchedFiles": 0 }
}

Correct output:
{
  "whatChanged": "FooService.findById(Long) in src/main/java/com/acme/service/FooService.java changed its return type from public Foo findById(Long id) to public Optional<Foo> findById(Long id).",
  "whoIsAffected": "FooController.get(Long) calls this method directly (1 direct caller total) and, because the return type changed, its dereference of the return value is signature-incompatible. The change is reachable from GET /api/foos/{id}, via an inferred edge, and touches the foo table for reads, also via an inferred edge (the single implementation).",
  "whatToCheck": "Check FooController.get(Long) for a null/Optional-unwrap bug at its call site, since the return type is no longer a bare Foo. No unresolved-call or ambiguous-edge concerns on this path."
}

--- Example 2 ---
Context object (trimmed):
{
  "changedMethod": {
    "displayName": "OrderRepository.save(Order)",
    "changeKind": "modified",
    "filePath": "src/main/java/com/acme/repo/OrderRepository.java",
    "signatureDiff": { "base": "void save(Order o)", "head": "void save(Order o)", "returnTypeChanged": false, "paramsChanged": false, "throwsAdded": [], "visibilityChanged": false }
  },
  "affectedBy": {
    "directCallers": [
      { "displayName": "OrderService.place(Order)", "hops": 1, "callSite": { "filePath": "src/main/java/com/acme/service/OrderService.java", "line": 40 }, "usage": "call only, result discarded", "signatureCompatible": true, "edgeConfidence": "ambiguous", "inferred": true }
    ],
    "directCallerTotal": 1,
    "directCallersTruncated": false,
    "reachableSurfaces": { "entrypoints": [], "data": [] }
  },
  "nowDependsOn": { "callees": [] },
  "quality": { "unresolvedRate": 0.08, "ambiguousEdgesOnPath": 1, "parseErrorsInTouchedFiles": 0 }
}

Correct output:
{
  "whatChanged": "OrderRepository.save(Order) in src/main/java/com/acme/repo/OrderRepository.java was modified; its signature is unchanged.",
  "whoIsAffected": "OrderService.place(Order) reaches this method through one of several candidate implementations, so the exact call path is not certain from the graph alone; its usage is a call only, with the result discarded, and the signature remains compatible.",
  "whatToCheck": "The path from OrderService.place(Order) includes an ambiguous edge — confirm which implementation actually runs before relying on this analysis. A notable share of calls in the base graph are unresolved, so treat this analysis as a starting point rather than exhaustive."
}`;

const REPAIR_PREFIX = `Your previous response used the following terms that do not appear anywhere in the context object below. Every one of them is invented and must not appear again. Rewrite all three sections using only facts already present in the context object:
`;

export function buildPrompt(
  contextObject: ContextObject,
  promptVersion: string,
  repair?: { violations: readonly ValidationViolation[] },
): string {
  const parts = [INSTRUCTIONS, VOCABULARY, FEW_SHOTS];
  if (repair !== undefined) {
    const offending = [...new Set(repair.violations.map((v) => v.token))].join(', ');
    parts.push(`${REPAIR_PREFIX}${offending}`);
  }
  parts.push(`prompt version: ${promptVersion}`);
  parts.push(`Context object:\n${JSON.stringify(contextObject)}`);
  return parts.join('\n\n');
}
