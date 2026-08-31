# DECISIONS.md

Every load-bearing decision, in one place. Format: **what** was chosen, **why**, what was
**rejected**, and the **interview line** — the one-sentence version to say out loud. This
file doubles as an interview script. Newest context at the bottom of each section.

---

## Product shape

### The graph decides truth; the LLM only phrases it
**Chose:** correctness comes entirely from a statically derived call graph; the LLM is a
final rendering step that receives an already-verified context object and turns it into
prose. It has no repo/DB access, no tools, no retrieval.
**Why:** it confines the model to the one thing it's reliable at (phrasing structured
facts) and keeps hallucination out of the correctness path.
**Rejected:** letting the LLM read the diff and "figure out" impact — that's the generic
wrapper everyone builds, and it's exactly where hallucination destroys trust.
**Interview line:** "I deliberately kept correctness-critical logic out of the LLM and used
it only for the natural-language layer, so the AI is a bounded final step, not a guess."

### The Spring implicit edges are the actual contribution
**Chose:** make resolving Spring's invisible connections the centerpiece — interface → the
single `@Service` impl, `@RequestMapping` route → controller method, Spring Data derived
query → entity/table.
**Why:** these edges don't exist in the source text (Spring wires them at runtime), so a
naive call graph is blind exactly where a reviewer cares most. Resolving them is what makes
the tool non-trivial.
**Interview line:** "It's not just a call graph — it's a call graph that understands
dependency injection."

### An eval is the differentiator
**Chose:** build a small eval — 20–30 real PRs from my two Spring repos, a hand-written
"what a reviewer needed to know" per PR, scored against a diff-only-to-LLM baseline on a
rubric (caught affected callers / flagged the breaking signature change / hallucinated?).
**Why:** it answers the killer question — "why is this better than pasting the diff into
ChatGPT?" — with a number instead of a claim. Almost no student project has one.
**Interview line:** "I measured it: graph-grounded explanations beat a diff-only baseline on
my rubric by X, and here's the failure analysis."

---

## Static analysis & the graph

### JavaParser + JavaSymbolSolver, not tree-sitter (C2)
**Chose:** parse with JavaParser + SymbolSolver in a separate Spring Boot service the Node
backend calls over HTTP.
**Why:** tree-sitter gives a syntax tree with no type resolution or name binding; the Spring
work needs real semantic resolution. Writing the parser in Spring Boot also uses an existing
strength instead of routing around it.
**Rejected:** tree-sitter (no semantic model); a single-language monolith (Java parsing
belongs in the JVM).
**Interview line:** "The parser is a polyglot service boundary — Java tooling does the Java
analysis, and Node orchestrates."

### Type resolution: source + JDK only (D2)
**Chose:** `CombinedTypeSolver = ReflectionTypeSolver + JavaParserTypeSolver`. No Maven/Gradle
invocation. Unresolved external calls become edges to an `unresolved:` node, never dropped.
The TypeSolver sits behind an interface so classpath resolution can be added later.
**Why:** the impact surface is entirely intra-repo edges, which source resolution covers
fully; Spring edges are matched by annotation *name* off the raw AST and never need Spring's
own types resolved. Resolving dependency jars would add a multi-minute build step to every
index for edges outside the thing being explained.
**Rejected:** jar resolution now (cost with no payoff for v1); jars-cached-per-lockfile (the
right *eventual* target, deferred behind the interface until the eval shows unresolved edges
hurt).
**Interview line:** "I resolved only what the feature depends on, left a clean upgrade seam,
and let the unresolved-rate metric tell me when to spend more."

### Indexing: full re-index, immutable & SHA-stamped, atomic swap (D3)
**Chose:** on push to the default branch, build a whole new graph off to the side keyed by
commit SHA, then atomically flip a `currentGraphVersionId` pointer. Retention = current +
in-progress only.
**Why:** at target scale (~50–300 files) a full parse is seconds. Atomic swap gives
consistency with no torn reads.
**Rejected:** *incremental (changed files only)* — a change in file A silently invalidates
edges in untouched files (a new `@Service` impl breaks the single-impl heuristic; a signature
change ripples to callers), corrupting exactly the cross-file edges the product exists to
compute. *Single mutable graph* — a PR analyzed mid-reindex reads a torn graph.
**Interview line:** "I shipped atomic full re-index and specced incremental as future work,
because at repo scale a full parse is seconds while naive incremental corrupts the cross-file
edges the tool depends on — knowing when *not* to optimize."

### Node identity across commits (C4, §6.1)
**Chose:** key = `fn:fqcn#method(paramTypes)`. A signature change = same node, new
`functionVersions` row. Stable across body edits, formatting, line moves, return-type and
param-*name* changes.
**Why:** without a stable key, a rename or signature change looks like delete-then-create and
loses all history and edges — which is the whole feature. Not stable across class/method
rename or param-*type* change (those are genuinely different symbols); linking them is roadmap.
**Interview line:** "Function identity is the sleeper problem in change-tracking; I keyed on
the fully-qualified signature so edits don't masquerade as deletes."

### Storage: separate `edges` collection, and versioned facts (C5, D5)
**Chose:** `edges` as its own collection (`{from,to,type}`, indexed both ways). Split node
data into `functions` (permanent identity) + `functionVersions` (per-graph-version facts).
**Why:** embedding caller/callee arrays means deleting one node forces edits to every node
that mentions it (update anomaly). A separate edges collection makes invalidation a single
`deleteMany`. A PR needs base and head facts *simultaneously*, which one overwritten
current-state doc can't provide — hence versioned facts.
**Rejected:** embedded adjacency arrays; a `versions[]` array on the doc (unbounded array
growth, the same antipattern).
**Interview line:** "I used adjacency in a separate collection instead of Neo4j because the
graph is small per repo — knowing when *not* to reach for a graph DB."

### PR change detection: parse touched files at head only (D4)
**Chose:** on a PR, parse only the files the PR touched, at the head SHA (the full worktree is
on disk so SymbolSolver still resolves against the whole tree). Reverse impact reads the
pinned base graph.
**Why:** yields added/removed methods, signature diffs, and real callee edges for `isNew` at a
fraction of a full parse. The blind spot (a new caller in an untouched file) can't arise from
this PR's own diff.
**Rejected:** full head parse every synchronize (a second full parse for resolution-shift
detection you don't need until merge); mapping diff hunks onto base nodes (can't see
head-only methods, can't compute `isNew`).

### PR analysis pins the base graph version (D8)
**Chose:** an analysis pins its base graph version for the whole run and never re-reads
"current" mid-analysis; retention won't delete a pinned version.
**Why:** reproducibility, and it's what makes D3's atomic swap safe under concurrent reindex.

### Parser is stateless; Node clones (D1)
**Chose:** the Node worker materializes a git worktree at a SHA and passes a path; the parser
does no git and no network I/O, reading a shared volume.
**Why:** keeps the parser stateless and credential-free; SymbolSolver needs the whole tree on
disk. Cost: the two services share a filesystem in v1.

---

## Pipeline & platform

### Webhook semantics + the queue is forced, not chosen (C6)
**Chose:** re-index on push to the default branch; analyze on `pull_request`
opened/synchronize; fetch the diff separately; all real work runs async on BullMQ, webhook
returns 202 fast.
**Why:** GitHub expects a 2xx within ~10s, so the queue isn't a nice-to-have — the platform
forces it.
**Interview line:** "The job queue exists because GitHub times out webhook delivery at ~10
seconds; the handler does two writes and an enqueue, nothing more."

### Change history via `git log -L` (C7)
**Chose:** `git log -L <start>,<end>:<file>` per function, cached per `{repo,functionKey,
headSha}`.
**Why:** byte/line ranges move every commit, so the SHA must be in the cache key; `-L` follows
a line range through history. Known limit: `-L` can't cross file renames — set
`truncatedAtRename` and say so. History comes from git, not from stored graph snapshots — which
is why graph retention can stay at current + in-progress.

### Auth: GitHub App (D7)
**Chose:** a GitHub App for webhooks and cloning.
**Why:** registering and using a GitHub App is **free** on any tier (only Marketplace listing
or seat plans cost money). It issues short-lived, per-installation tokens scoped to installed
repos, and manages the webhook + signing secret — no long-lived broadly-scoped PAT at rest.
**Rejected:** user-pasted PAT + manual webhook (long-lived secret, real security downgrade);
public-repos-only (unusable where a team's code actually lives).
**Interview line:** "Short-lived per-installation tokens instead of storing users' PATs — the
credential-hygiene answer."

---

## The LLM boundary

### Impact traversal → a curated, ranked context object (§10)
**Chose:** two reverse zones plus a small labeled forward section. Zone 1 `directCallers`
(1–2 hops, detailed, ranked signature-incompatible-first). Zone 2 `reachableSurfaces`
(reverse walk kept deep but collapsed to terminal surfaces only, deduped). `nowDependsOn`
(forward, 1 hop, `isNew`). Counts are graph facts, never LLM estimates.
**Why:** the product answers "what breaks / who's affected" (reverse). Collapsing to terminal
surfaces keeps a util-method change from fanning out to hundreds of nodes while staying
complete. Separating `affectedBy` from `nowDependsOn` stops the model conflating the two.
**Rejected:** unbounded reverse keeping all nodes (fan-out); symmetric both-directions
(doubles tokens, blurs the relationships).
**Note:** this schema *is* the eval ground truth — `directCallers`, `reachableSurfaces`, and
the `signatureCompatible` flags are what the rubric scores.

### LLM grounding: a deterministic post-generation validator (D6)
**Chose:** build a symbol + numeric allowlist from the context object; extract identifiers and
integers from the generated prose; reject anything not in the allowlist; one repair attempt;
then fall back to a deterministic template and mark `degraded`.
**Why:** it mechanically enforces "the LLM never decides truth" and kills the trust-killer
(invented class/route/table names). Honest gap: it catches invented symbols, not a wrong
*relationship* between two real ones — mitigated by 1:1 section↔field mapping and by carrying
`minHops`/`viaInferredEdge` so indirect paths must be hedged. Claim-level citations are roadmap.
**Interview line:** "The model literally cannot emit an identifier that isn't in the
graph-derived allowlist — the server rejects and regenerates."

### LLM provider: Gemini 2.5 Flash on the free tier, behind an interface
**Chose:** Google Gemini 2.5 Flash (free tier) as the v1 model, behind an `LLMProvider`
interface, using Gemini's JSON `responseSchema` for the fixed output sections.
**Why:** the task is narrow grounded rewriting — Flash is plenty — and free. The provider
interface (mirroring the TypeSolver interface) keeps the model a config swap and preserves the
run-the-eval-across-providers plan. Cost was never the constraint: even on paid Claude the
whole build is single-digit-to-low-tens of dollars; the real cost-saver is the app-level
`explanations` cache keyed by `contextHash`, which is provider-independent.
**Consequence:** the validator matters *more* with a smaller model, not less — which is the
point: a model-independent correctness guarantee is what makes a free model safe rather than a
compromise. Flag: Flash adheres to strict JSON a little less reliably, so the repair loop earns
its keep.
**Privacy tradeoff (recorded):** the free AI-Studio tier may train on inputs, and inputs are
source code — fine for my own two repos; the paid Gemini/Vertex tier or Claude is the boundary
to cross before this touches anyone else's private code.
**Interview line:** "I benchmarked a free open model against a frontier model on my own rubric
and chose on cost-versus-quality — and my correctness guard is model-independent, so going free
cost me nothing in trust."
