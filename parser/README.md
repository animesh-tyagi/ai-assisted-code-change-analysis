# `/parser` — Java parser service

**Not yet built. Owned by BUILD_PLAN Step 2 (M2) — the highest-risk milestone.**

A standalone **Spring Boot** service using **JavaParser + JavaSymbolSolver**. It is the only
component that knows Java, and the only one that resolves Spring's implicit edges.

## Contract

Stateless. No database, no network egress, no git. It reads a worktree path on the shared
volume that the Node worker prepared, and returns JSON.

- `POST /v1/parse` — full and subset modes (ARCHITECTURE §8)
- `GET /v1/version` — `parserVersion` + `ruleVersion`, stamped onto every graph version so a
  rule change invalidates deliberately rather than drifting silently
- `GET /healthz`, `GET /readyz`

The response is a **pure function** of (workspace contents, mode, files, options) — keep it
deterministic so graph versions are reproducible, and snapshot-test it (CLAUDE.md).

## Why Java and not tree-sitter

Tree-sitter gives a syntax tree with no type resolution or name binding. The Spring edges need
real semantic resolution. See DECISIONS.md → "JavaParser + JavaSymbolSolver, not tree-sitter".

## Type resolution scope (D2)

`CombinedTypeSolver = ReflectionTypeSolver + JavaParserTypeSolver` per source root. **No
Maven/Gradle invocation in v1.** Unresolved external calls become edges to an `unresolved:`
node — never dropped. Keep the TypeSolver behind a small interface so classpath resolution can
be added later without touching the graph model or node keys.

## Note on node keys

Key _derivation_ (qualified signature → normalised key, generics erasure, varargs) lives
**here**, in Java. `shared/src/nodeKey.ts` only parses and formats the resulting string — it
deliberately does not re-implement derivation. Keep it that way; two sources of truth for the
node key would fail silently.
