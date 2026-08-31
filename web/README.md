# `/web` — React frontend

**Not yet built. Owned by BUILD_PLAN Step 7 (M7).**

The demo-critical surface: what makes the impact analysis visceral rather than abstract.

## Scope

- The three explanation sections (`whatChanged` / `whoIsAffected` / `whatToCheck`), plus the
  `degraded` / caveat line when analysis quality is low (ARCHITECTURE §11.5).
- A **force-directed impact graph** of what the change touches. Node cap ~150 with collapse
  beyond that (Q10, §16.1). Colour and annotate _inferred_ versus literal edges, and surface
  the confidence level — the UI has to show how it knows, not just what it found.
- Polling UI with progress (`step`, `pct`) against `GET /api/analyses/:id` (§9.6).

## Out of scope for v1

No natural-language chat box. No teams, multi-repo access control, or user accounts. Anything
beyond a basic force-directed graph.

Types for everything rendered here come from `@impact/shared` — do not redefine them locally.
