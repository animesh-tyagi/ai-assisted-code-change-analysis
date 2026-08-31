# BUILD_PLAN.md

The milestone-by-milestone plan for building this with Claude Code. Read alongside
`ARCHITECTURE.md` (the design) and `DECISIONS.md` (the why). Work **one milestone per
branch/PR**, in **plan mode** — approve the plan before code is written.

Ordering principle: build the **risky, novel core first and standalone** (the parser and the
graph — the parts that can actually fail and have the least boilerplate help), reach a
**manually-triggered end-to-end path** before adding webhook/queue orchestration, and leave
frontend and eval last but budget real time for them.

---

## Step 0 — Close the open questions (do this first) ✅ DONE

Answers appended to ARCHITECTURE §16.1. Summary:

- [x] **Q1 (renames):** new node, old one disappears with its version. Rename-linking → roadmap.
- [x] **Q2 (test sources):** **excluded** `src/test/java` from the graph in v1 (leaner scope).
  Test-coverage edges ("which tests cover this change") → roadmap.
- [x] **Q3 (multi-module):** checked both real repos (`dummy-proj/Dummy`,
  `oberservability-final/Dummy`) — both are **single-module** (no `<modules>` in either
  `pom.xml`). §8's per-source-root discovery stands as written either way.
- [x] **Q4 (data surfaces):** keep `data` under `reachableSurfaces` but distinct from
  `entrypoints`; it's a forward relationship. Confirmed as documented.
- [x] **Q5 (base SHA):** `pull_request.base.sha` for v1; merge-base → roadmap.
- [x] **Q6 (auth posture):** single-tenant, no login, behind a network boundary. Paired with the
  free-tier Gemini training note.
- [x] **Q7 (source to LLM):** changed method's unified diff only, ~200 lines capped. No caller bodies.
- [x] **Q8 (retention of analyses/explanations):** keep — they're small and they *are* the eval
  corpus.
- [x] **Q9 (scale ceiling):** deferred — set the hard file/edge cap once M2 gives real timings
  against both target repos.
- [x] **Q10 (frontend graph cap):** ~150 nodes, collapse beyond. Confirmed; revisit visually in M7.

---

## Step 1 — Repo scaffold & foundations
**Goal:** a monorepo skeleton Claude Code can build into, plus local infra.
- [ ] Monorepo layout per CLAUDE.md (`/api /worker /parser /web /shared /eval`).
- [ ] `docker-compose.yml` bringing up MongoDB + Redis locally.
- [ ] TypeScript strict config, linting, a test runner wired on the Node side.
- [ ] `/shared` holds the TS types for the graph model and the context object (transcribe
      from ARCHITECTURE §6 and §10) — one source of truth both services import.
- [ ] CLAUDE.md, ARCHITECTURE.md, DECISIONS.md committed at the root.
**Acceptance:** `docker compose up` gives working Mongo + Redis; `npm test` runs (even if
empty); shared types compile.

---

## Step 2 — Parser service, standalone (HIGHEST RISK — do it early)
**Goal:** prove the Spring implicit-edge rules on a **real repo** before building anything
around them. If the graph is wrong, nothing downstream matters.
- [ ] Spring Boot app; add JavaParser + JavaSymbolSolver.
- [ ] `CombinedTypeSolver = ReflectionTypeSolver + JavaParserTypeSolver` per source root (D2),
      behind a small interface.
- [ ] Extract functions with the node key of ARCHITECTURE §6.1 (qualified signature →
      normalized key). **Unit-test the key derivation hard** — it's load-bearing.
- [ ] Resolved `calls` / `implements` / `overrides` edges. Unresolved calls → `unresolved:`
      nodes, never dropped (§6.5).
- [ ] **Spring rules (§6.4):** interface → single `@Service`/`@Component`/`@Repository` impl
      (with `@Primary`/`@Qualifier`/ambiguous handling); `@RequestMapping` route → controller
      method; Spring Data derived query → entity → table.
- [ ] Emit `inferred` + `confidence` on every edge.
- [ ] Start as a **CLI** (point at a directory, dump the §8 JSON); eyeball the edges on code
      you know before adding HTTP.
- [ ] Then wrap in `POST /v1/parse` (full + subset modes), `GET /v1/version`, health checks
      per ARCHITECTURE §8.
- [ ] **Snapshot-test** the parser output on a fixture repo (it's a pure function — §8).
**Acceptance:** run against **both your real Spring repos**; the call graph and the three
Spring edge types are correct on manual inspection; `unresolvedRate` is sane; identical input
gives byte-identical output.

---

## Step 3 — Graph persistence & the full index flow
**Goal:** parser JSON → a queryable, versioned graph in Mongo, with the atomic swap.
- [ ] Collections + indexes per ARCHITECTURE §7 (`functions`, `functionVersions`, `surfaces`,
      `edges`, `graphVersions`, `repos`).
- [ ] Index flow §5.1: build a `graphVersion` `building` → bulk insert stamped rows → flip
      `repos.currentGraphVersionId` (atomic swap, D3) → mark previous `superseded`.
- [ ] Retention: delete superseded versions' rows, respecting `pinnedBy` (§9.5).
- [ ] Trigger **manually** (a CLI/script that takes a repo path + SHA) — no webhook yet.
**Acceptance:** index a real repo at a SHA; the graph is queryable; re-indexing a new SHA swaps
atomically and prunes the old version; reverse-lookup by `to` is fast (uses the §7 index).

---

## Step 4 — Traversal → context object
**Goal:** the curated, ranked context object of ARCHITECTURE §10, as a pure function over the
stored graph.
- [ ] Change detection (§5.2 step 6): added / removed / modified / signature_changed.
- [ ] Zone 1 `directCallers` (reverse, 1–2 hops, ranked signature-incompatible first, capped
      with true `directCallerTotal`).
- [ ] Zone 2 `reachableSurfaces` (reverse to depth cap, collapse to terminal surfaces, dedupe)
      + `data` (forward `queries`/`maps_to`).
- [ ] `nowDependsOn` (forward, 1 hop, `isNew` by diffing head overlay vs base).
- [ ] `signatureCompatible` per §10, with its stated limitation.
- [ ] `viaInferredEdge` / `minHops` on surfaces.
- [ ] Test with hand-built graph fixtures — no LLM, no live repo needed.
**Acceptance:** given a fixture graph and a changed method, the context object matches an
expected snapshot; counts are exact; a util-method change yields a short surface list, not
hundreds of nodes.

---

## Step 5 — LLM step + validator (plug in Gemini here)
**Goal:** context object → three prose sections, mechanically grounded.
- [ ] `LLMProvider` interface; `GeminiProvider` (Gemini 2.5 Flash, `@google/genai`, JSON
      `responseSchema` for the fixed sections). No provider specifics leak past the interface.
- [ ] The frozen prompt (instruction block + edge/confidence vocabulary + few-shots).
- [ ] Post-generation validator (§11.3): symbol + numeric allowlist, extract candidates,
      reject on violation, one repair attempt, deterministic template fallback + `degraded`.
- [ ] `explanations` cache keyed by `contextHash + promptVersion + model`.
- [ ] Record `validation` + `usage`; wire the validator-rejection metric.
**Acceptance:** real context objects produce sane 3-section output; a deliberately
symbol-injecting prompt is caught and repaired/degraded; re-running an identical analysis hits
the cache and makes no API call.

---

## Step 6 — Webhook + queue + orchestration (connect it end-to-end)
**Goal:** a real PR flows from GitHub to a stored explanation with no manual steps.
- [ ] GitHub App registration; installation callback; `installations`/`repos` upsert.
- [ ] `POST /api/webhooks/github`: raw-body signature verify, delivery dedupe, event switch,
      202 fast (§9.1). p99 < 500ms.
- [ ] BullMQ `index` / `analyze` / `history` queues with deterministic job IDs + per-repo lock
      (§9.2), retries with classification (§9.3), analyze-waits-for-base-graph backoff (§9.4).
- [ ] Worker wires M2–M5 together for the analyze flow (§5.2); pinning (§9.5).
- [ ] Read endpoints + polling (§9.6).
**Acceptance:** open a PR on a real repo → webhook → job → analysis appears via polling;
redelivered webhook and double-run are deduped; a missing base graph triggers an index and
resolves.

---

## Step 7 — Frontend (demo-critical)
**Goal:** the thing that makes it visceral in a 40-second recording.
- [ ] PR view: the three sections + the `degraded`/caveat line.
- [ ] **Force-directed impact graph** of what the change touches, node cap ~150 with collapse
      (Q10). Colour/annotate inferred vs literal edges and confidence.
- [ ] Polling UI with progress (`step`, `pct`).
**Acceptance:** a real PR renders both the explanation and a legible impact graph; the graph
reads clearly on a repo you know; record a short demo clip.

---

## Step 8 — The eval (the differentiator — do not skip)
**Goal:** a number that answers "why not just paste the diff into ChatGPT?"
- [ ] Collect 20–30 real PRs from your two repos into `/eval`.
- [ ] Hand-write the "what a reviewer needed to know" ground truth per PR.
- [ ] Two conditions: graph-grounded context object vs diff-only-to-LLM baseline.
- [ ] Rubric: caught affected callers? flagged the breaking signature change? hallucinated?
- [ ] Run across Gemini Flash **and** at least one other model via `LLMProvider` (the
      cross-provider comparison).
- [ ] Write the results + failure analysis into the README with the headline number.
**Acceptance:** a reproducible `npm run eval` produces the scores; the README states the
graph-vs-baseline result and what the system still gets wrong.

---

## Working-with-Claude-Code notes
- Feed **CLAUDE.md + ARCHITECTURE.md** every session; point at DECISIONS.md for rationale.
- Drive each milestone in **plan mode**; approve the plan before it writes code.
- Get the **node-key derivation (§6.1)** and the **graph model** under tests before building on
  them — a bug there is silent.
- Build fixtures from your **two real repos**, not toy examples — the Spring rules only prove
  out on real code.
- Keep the parser's **determinism** (§8) as a test invariant; snapshot its output.
- Don't wire the webhook/queue (M6) until M2–M5 work by hand — orchestration is only worth
  building once there's something real to orchestrate.
