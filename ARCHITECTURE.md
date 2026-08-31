# ARCHITECTURE.md

**Product:** a web app that explains the *impact* of a pull request, not the diff.
**v1 target:** Java Spring Boot repositories.
**Stack:** MongoDB, Express, React, Node — plus one auxiliary Spring Boot service for Java parsing.

Status: design document. No code has been written.

---

## 1. The load-bearing idea

Correctness comes from a statically derived call graph. The LLM is a rendering
step at the very end of the pipeline: it receives a structured, already-verified
context object and turns it into English. It has no repository access, no
database handle, no tools, and no retrieval. If the graph does not contain a
fact, the explanation cannot contain it either.

Everything in this document exists to protect that boundary.

---

## 2. Fixed constraints

These were decided before design and are recorded here as constraints, not
options:

| # | Constraint |
|---|---|
| C1 | Truth comes from static analysis. The LLM converts a verified context object to prose and never decides what is true. |
| C2 | Parsing uses JavaParser + JavaSymbolSolver (real type resolution), in a separate Spring Boot service the Node backend calls over HTTP. Not tree-sitter. |
| C3 | The valuable work is resolving Spring's implicit edges: interface → single `@Service` impl, `@RequestMapping` route → controller method, Spring Data derived query → entity/table. |
| C4 | Function identity key is `fqcn#method(paramTypes)`. A signature change is the same node with a new version. |
| C5 | The graph lives in a separate `edges` collection (`{from, to, type}`, indexed both ways). Not caller/callee arrays embedded on nodes. |
| C6 | GitHub webhooks: re-index on push to the default branch, analyze on `pull_request` `opened`/`synchronize`. The handler must return 2xx well within GitHub's ~10s delivery timeout, so all real work runs async on a BullMQ queue that the frontend polls. |
| C7 | Per-function change history uses `git log -L <start>,<end>:<file>`, cached per function key. |

## 3. Decisions taken during design

| # | Decision | Rationale |
|---|---|---|
| D1 | **Node clones; parser reads a shared volume.** The Node worker materialises a worktree at a SHA and passes an absolute path. The parser service does no git and no network I/O. | Keeps the parser stateless and credential-free; the whole source tree is on disk, which SymbolSolver requires. Cost: the two services must share a filesystem in v1. |
| D2 | **Type resolution is source + JDK only.** `CombinedTypeSolver` = `ReflectionTypeSolver` + `JavaParserTypeSolver` per source root. No Maven/Gradle invocation. | The impact surface is entirely intra-repo edges, which source resolution covers fully. Spring's implicit edges are matched by annotation *name* off the raw AST and never require resolving Spring's own types. Unresolved external calls are recorded as edges to an `unresolved:` node, never dropped. See §6.6 for the overload limitation. The TypeSolver sits behind a small interface so classpath resolution (cached per `pom.xml`/`build.gradle` hash) can be added later without touching the graph model or node keys. |
| D3 | **Full re-index into an immutable, SHA-stamped graph version, with an atomic pointer swap.** | At target scale (~50–300 files) a full parse is seconds. *Incremental* is rejected for v1: a change in file A invalidates edges in untouched files (a new `@Service` impl breaks the single-impl heuristic; a signature change ripples to callers) — corrupting exactly the cross-file edges the product depends on. *One mutable graph* is rejected: a PR analysed mid-reindex reads a torn graph. Retention: current + in-progress only. Graph history is **not** the change-history feature — that reads git (C7). |
| D4 | **On a PR, parse only the files the PR touched, at the head SHA.** The full head worktree is on disk, so SymbolSolver still resolves against the whole tree; we simply extract nodes/edges for the touched files. | Yields added/removed methods, signature diffs, and real callee edges for `isNew` at a fraction of a full parse. Reverse impact is read from the pinned base graph. |
| D5 | **`functions` (permanent identity) + `functionVersions` (per-graph-version facts) + `edges`.** | Identity survives retention pruning; a PR needs base and head facts simultaneously, which a single overwritten current-state document cannot provide. |
| D6 | **A post-generation symbol validator enforces C1 mechanically**, on top of prompt discipline. | Deterministic, cheap, and catches the failure mode that actually destroys trust: invented class names, routes, and counts. Its known gap — a wrong *relationship* between two real symbols — is stated in §11.4. |
| D7 | **GitHub App** for webhooks and cloning. | Short-lived per-installation tokens, managed webhooks, signed deliveries. No long-lived PAT at rest. |
| D8 | **PR analysis pins the base graph version** for the whole run and never re-reads "current" mid-analysis. | Reproducibility, and it is what makes D3's pointer swap safe. |

---

## 4. Topology

```
                    ┌──────────────┐
   GitHub ─webhook─▶│  Express API │──enqueue──▶ Redis (BullMQ)
                    │  (stateless) │                  │
   Browser ◀─poll──▶└──────────────┘                  │
                            │                         │
                            │                         ▼
                            │                 ┌───────────────┐
                            ▼                 │  Node worker  │
                     ┌────────────┐           │  (index /     │
                     │  MongoDB   │◀──────────│   analyze)    │
                     └────────────┘           └───────┬───────┘
                                                      │ git clone / worktree
                                        shared volume │ HTTP POST /v1/parse
                                                      ▼
                                             ┌───────────────────┐
                                             │  Parser service   │
                                             │  Spring Boot +    │
                                             │  JavaParser +     │
                                             │  SymbolSolver     │
                                             │  (stateless,no DB)│
                                             └───────────────────┘
                                                      │
                               Node worker ──context object──▶ LLM (Gemini)
```

Five processes: Express API, Node worker(s), Redis, MongoDB, parser service.
Only the Node worker touches git, Mongo writes, the parser, and the LLM.
The API process only validates, enqueues, and reads.

**Workspace layout on the shared volume**

```
/data/repos/<repoId>.git          # one cache clone per repo, fetched incrementally
/data/work/<repoId>/<sha>/        # git worktree per SHA, removed after the job
```

A cache clone plus worktrees keeps clone cost near zero on repeat events and
gives `git log -L` (§12) a real repository to walk.

---

## 5. End-to-end data flow

### 5.1 Index flow — `push` to the default branch

1. Webhook received, signature verified, delivery deduped, `index` job enqueued, **202 returned**.
2. Worker takes a per-repo lock, fetches into the cache clone, adds a worktree at the SHA.
3. Worker inserts a `graphVersions` doc `{repoId, sha, status: "building", kind: "branch"}`.
4. Worker `POST /v1/parse` with `mode: "full"` and the worktree path.
5. Parser returns functions, surfaces, edges, diagnostics. Parser holds no state.
6. Worker upserts `functions` (identity), bulk-inserts `functionVersions`, `surfaces`, `edges`, all stamped with the new `graphVersionId`.
7. Worker flips `graphVersions.status → "ready"` and sets `repos.currentGraphVersionId` — **the atomic swap**. Readers see the old graph until this single update lands.
8. Retention: mark the previous version `superseded` and delete its rows, *unless* it is pinned by an in-flight analysis (§9.5).
9. Worktree removed.

Nothing before step 7 is visible to readers. A failed parse leaves
`status: "failed"` and the previous graph serving.

### 5.2 Analyze flow — `pull_request` `opened` / `synchronize`

1. Webhook verified and deduped; any prior analysis for the same PR is superseded; `analyze` job enqueued; **202 returned** with an `analysisId` the frontend can poll immediately.
2. Worker resolves the base graph for `pull_request.base.sha`. If it is not `ready`, the worker enqueues an index job for that SHA and re-schedules itself with backoff (§9.4).
3. Worker **pins** the base graph version.
4. Worker creates a worktree at `head.sha` and computes the changed file list (`git diff --name-status base...head`).
5. Worker `POST /v1/parse` with `mode: "subset"` and that file list → the **head overlay**: nodes and edges for the touched files only, stored as a `graphVersion` with `kind: "pr_overlay"`.
6. **Change detection.** For each function key present in the overlay or in the base graph for those files:
   - in base only → `removed`
   - in overlay only → `added`
   - in both, `bodyHash` differs → `modified`
   - in both, param types / return type / `throws` differ → `signature_changed`
   - in both, identical → ignored
7. **Traversal** (§10) over the pinned base graph, per changed function, producing one context object each.
8. **Explanation** (§11): context object → validator-guarded LLM call → stored `explanation`, keyed by context hash so re-runs and identical re-pushes are free.
9. `analyses.status → "ready"`. The next poll returns the result.
10. Overlay graph version deleted; base graph unpinned; worktree removed.

---

## 6. The graph model

### 6.1 Node identity

Key format, namespaced so `edges.from` / `edges.to` stay flat indexable strings:

```
fn:com.acme.user.UserService#findById(java.lang.Long)
route:GET /api/users/{id}
job:com.acme.billing.NightlyJob#run()
listener:kafka:orders.created
entity:com.acme.user.User
table:user_account
unresolved:org.springframework.data.repository.CrudRepository#save(java.lang.Object)
```

Derivation for `fn:` keys: resolve the declaration via SymbolSolver, take
`ResolvedMethodDeclaration.getQualifiedSignature()`, then normalise — the `.`
before the method name becomes `#`, generics are erased to their raw type
(`List<String>` → `java.util.List`), varargs become array types
(`String...` → `java.lang.String[]`), parameter types are fully qualified, and
parameter *names* are discarded.

Per C4, this key is stable across: body edits, formatting, line movement, file
moves within a package, return-type changes, parameter *name* changes,
visibility and annotation changes, and `throws` changes. Those are the "same
node, new version" cases; the new facts land in a new `functionVersions` row.

It is **not** stable across class rename, package move, method rename, or any
parameter type change — those produce a different key. See open question **Q1**.

### 6.2 Node kinds

`functions` holds method nodes. `surfaces` holds everything else:
`http_route`, `scheduled_job`, `message_listener`, `entity`, `table`,
`unresolved`.

### 6.3 Edge types and direction

**Convention: an edge points from the dependent to the depended-upon.**
`from` needs `to`. Reverse traversal (find everything affected by a change to X)
means matching `to = X` and collecting `from`.

| type | from → to | meaning |
|---|---|---|
| `calls` | fn → fn | a resolved method invocation |
| `implements` | fn → fn | impl method → the interface method it satisfies |
| `overrides` | fn → fn | subclass method → superclass method |
| `handles` | route → fn | an HTTP route is served by this controller method |
| `triggers` | job/listener → fn | a scheduler or broker invokes this method |
| `queries` | fn → entity | a repository method reads/writes this entity |
| `maps_to` | entity → table | JPA mapping |
| `unresolved` | fn → unresolved:* | a call site we could not bind (never dropped) |

Every edge carries `inferred` (was it written in the source, or derived by a
Spring rule?) and `confidence` (`exact`, `single_impl`, `ambiguous`, `regex`).
Those two fields are what let the UI and the context object say *how* we know
something, and they propagate into the explanation.

### 6.4 Spring implicit edges

This is the part that makes the product work, so the rules are spelled out.

**Interface → single implementation.** For interface `I` with method `m`, find
classes implementing `I` annotated `@Service`, `@Component`, or `@Repository`.

- Exactly one impl → emit `implements` (impl.m → I.m) and, for every call site
  that resolved to `I.m`, emit an additional `calls` edge to `Impl.m` with
  `inferred: true, confidence: "single_impl"`.
- Several impls → prefer `@Primary`; else read `@Qualifier` at the injection
  site; else emit edges to **all** candidates with `confidence: "ambiguous"`.
  Never guess one, never drop them.

**Route → controller method.** Concatenate the class-level `@RequestMapping`
path with the method-level `@GetMapping` / `@PostMapping` / `@PutMapping` /
`@DeleteMapping` / `@PatchMapping` / `@RequestMapping(method=…)`. Normalise path
variables to `{name}`. Emit an `http_route` surface plus a `handles` edge.
Unresolved `${property}` placeholders are kept verbatim and flagged
`confidence: "ambiguous"`.

**Spring Data derived queries.** For an interface extending `JpaRepository<T,ID>`,
`CrudRepository`, or `PagingAndSortingRepository`, take the entity from the type
argument `T`. Map entity → table from `@Table(name=…)`, else `@Entity(name=…)`,
else Spring Boot's default `CamelCaseToUnderscoresNamingStrategy`
(`UserAccount` → `user_account`). Parse derived method names on the
`findBy|readBy|getBy|queryBy|countBy|existsBy|deleteBy` prefix and emit
`queries` (fn → entity) plus `maps_to` (entity → table). `@Query` methods:
extract referenced names by regex from the JPQL/native string and mark
`confidence: "regex"`.

**Entry points.** `@Scheduled` → `scheduled_job` surface. `@KafkaListener`,
`@RabbitListener`, `@JmsListener`, `@EventListener` → `message_listener`
surface. Both connect via `triggers`.

### 6.5 Unresolved edges

Any call site SymbolSolver cannot bind becomes an edge to an `unresolved:` node
carrying the best available textual target and a `reason` (`external_type`,
`ambiguous_overload`, `parse_error`, `missing_source`).
`unresolvedRate = unresolvedEdges / totalEdges` is tracked per graph version and
surfaced as a health metric — a spike means the analysis quietly got worse.

### 6.6 Known limitation: overload resolution

When an argument's type is itself unresolved (typically a library type), the call
cannot be bound to a specific overload. Policy: if exactly one method with that
name and arity exists on the target type, bind it (confidence downgraded from
`exact` to `single_impl`); otherwise emit `unresolved` with
`reason: "ambiguous_overload"` and record the candidate list. This is a direct
consequence of D2 and is the main thing classpath resolution would fix later.

---

## 7. MongoDB schema

All `_id`s are ObjectIds unless stated. All collections are single-tenant in v1
(access control is out of scope), but every document carries `repoId` so
multi-repo queries are already correct.

### `installations`
```js
{ _id, githubInstallationId, accountLogin, accountType,
  repositorySelection, suspendedAt, createdAt, updatedAt }
```
No token is stored. Installation access tokens are minted on demand from the
app's private key and held in Redis with a TTL shorter than their 1-hour life.

Index: `{ githubInstallationId: 1 }` unique.

### `repos`
```js
{ _id, provider: "github", githubRepoId, owner, name, defaultBranch,
  installationId, currentGraphVersionId, indexingStatus,
  lastIndexedSha, lastIndexedAt, createdAt }
```
Index: `{ provider: 1, githubRepoId: 1 }` unique.

### `graphVersions`
```js
{ _id, repoId, sha, kind: "branch" | "pr_overlay",
  status: "building" | "ready" | "failed" | "superseded",
  parserVersion, ruleVersion,
  stats: { functions, edges, surfaces, unresolvedRate, parseErrors },
  pinnedBy: [analysisId], startedAt, completedAt, error }
```
`parserVersion` + `ruleVersion` are stored so a parser upgrade can invalidate
graphs deliberately rather than silently mixing analyses produced by different
inference rules.

Indexes: `{ repoId: 1, sha: 1, kind: 1 }` unique; `{ repoId: 1, status: 1 }`.

### `functions` — permanent identity
```js
{ _id, repoId, key, fqcn, className, methodName, paramTypes: [],
  firstSeenAt, lastSeenAt }
```
Survives retention pruning; this is what a stable permalink and the
change-history cache key point at.

Index: `{ repoId: 1, key: 1 }` unique.

### `functionVersions` — per-graph-version facts
```js
{ _id, repoId, graphVersionId, functionKey, sha,
  filePath, startLine, endLine, bodyHash,
  returnType, paramNames: [], modifiers: [], annotations: [],
  isAbstract, isInterfaceMethod }
```
Indexes: `{ graphVersionId: 1, functionKey: 1 }` unique;
`{ repoId: 1, functionKey: 1 }`.

### `surfaces`
```js
{ _id, repoId, graphVersionId, key,
  kind: "http_route" | "scheduled_job" | "message_listener"
      | "entity" | "table" | "unresolved",
  attrs: { /* kind-specific: httpMethod, path, cron, topic, tableName, reason */ } }
```
Index: `{ graphVersionId: 1, key: 1 }` unique.

### `edges` — the graph (C5)
```js
{ _id, repoId, graphVersionId, from, to, type,
  inferred: Boolean,
  confidence: "exact" | "single_impl" | "ambiguous" | "regex",
  callSites: [ { filePath, line } ],   // deduped; multiple call sites collapse
  reason }
```
Indexes:
```js
{ graphVersionId: 1, from: 1, type: 1 }          // forward traversal
{ graphVersionId: 1, to: 1, type: 1 }            // reverse traversal — the hot path
{ graphVersionId: 1, from: 1, to: 1, type: 1 }   // unique
```
Repeated call sites collapse into the `callSites` array rather than duplicating
edge documents, so the unique index holds and reverse traversal never
double-counts a caller.

### `analyses`
```js
{ _id, repoId, prNumber, baseSha, headSha,
  baseGraphVersionId, overlayGraphVersionId, deliveryId, jobId,
  status: "queued" | "cloning" | "parsing" | "traversing"
        | "explaining" | "ready" | "failed" | "superseded",
  progress: { step, pct },
  changedFunctions: [ { functionKey, changeKind, contextHash, explanationId } ],
  error, createdAt, updatedAt }
```
Indexes: `{ repoId: 1, prNumber: 1, headSha: 1 }` unique;
`{ status: 1, updatedAt: -1 }`.

### `explanations`
```js
{ _id, contextHash, promptVersion, model,
  sections: { whatChanged, whoIsAffected, whatToCheck },
  raw, validation: { passed, attempts, violations: [] },
  usage: { inputTokens, outputTokens, cacheReadTokens }, createdAt }
```
Index: `{ contextHash: 1, promptVersion: 1, model: 1 }` unique — this is the
cache. Identical context objects never pay for a second generation.

### `changeHistory`
```js
{ _id, repoId, functionKey, headSha,
  commits: [ { sha, authorName, authoredAt, subject, insertions, deletions } ],
  truncatedAtRename: Boolean, computedAt }
```
Index: `{ repoId: 1, functionKey: 1, headSha: 1 }` unique; TTL on `computedAt`.
`headSha` is part of the key because line ranges move (§12).

### `webhookDeliveries`
```js
{ _id: <X-GitHub-Delivery>, event, action, repoId, receivedAt, processedAt }
```
The GitHub delivery UUID is the `_id`, so a redelivered webhook fails to insert
and is dropped in O(1). TTL 30 days.

---

## 8. Parser service HTTP contract

Spring Boot, stateless, no database, no network egress, no git. It reads a path
on the shared volume and returns JSON. It is the only component that knows Java.

### `POST /v1/parse`

Request:
```json
{
  "requestId": "uuid",
  "repoId": "…",
  "sha": "…",
  "workspacePath": "/data/work/<repoId>/<sha>",
  "mode": "full",
  "files": ["src/main/java/com/acme/user/UserService.java"],
  "options": { "includeTestSources": false, "sourceRoots": null }
}
```
`files` is required when `mode` is `"subset"` and ignored when `"full"`.
When `sourceRoots` is null the service discovers every `**/src/main/java`
directory and registers a `JavaParserTypeSolver` for each (see **Q3**).

Response `200`:
```json
{
  "requestId": "uuid",
  "sha": "…",
  "mode": "subset",
  "sourceRoots": ["src/main/java"],
  "functions": [
    {
      "key": "fn:com.acme.user.UserService#findById(java.lang.Long)",
      "fqcn": "com.acme.user.UserService",
      "className": "UserService",
      "methodName": "findById",
      "paramTypes": ["java.lang.Long"],
      "paramNames": ["id"],
      "returnType": "com.acme.user.User",
      "filePath": "src/main/java/com/acme/user/UserService.java",
      "startLine": 41,
      "endLine": 55,
      "bodyHash": "sha256:…",
      "modifiers": ["public"],
      "annotations": [{ "name": "Transactional", "values": {} }],
      "isAbstract": false,
      "isInterfaceMethod": false
    }
  ],
  "surfaces": [
    {
      "key": "route:GET /api/users/{id}",
      "kind": "http_route",
      "attrs": { "httpMethod": "GET", "path": "/api/users/{id}" }
    }
  ],
  "edges": [
    {
      "from": "route:GET /api/users/{id}",
      "to": "fn:com.acme.user.UserController#get(java.lang.Long)",
      "type": "handles",
      "inferred": true,
      "confidence": "exact",
      "callSites": [{ "filePath": "…/UserController.java", "line": 28 }]
    }
  ],
  "diagnostics": {
    "durationMs": 3120,
    "filesParsed": 214,
    "parseErrors": [{ "filePath": "…", "message": "…" }],
    "totalEdges": 1840,
    "unresolvedEdges": 96,
    "unresolvedRate": 0.052,
    "ambiguousOverloads": ["…"]
  }
}
```

Errors: `400` malformed request · `404` `workspacePath` does not exist ·
`422` no Java source roots found · `500` internal failure, body still carrying
`diagnostics` so a partial failure is diagnosable.

Contract properties:

- **Pure function of (workspace contents, mode, files, options).** Same inputs, same output — which is what makes graph versions reproducible.
- **Synchronous.** The caller is already an async worker; a callback would add a state machine for nothing. Client timeout 120s.
- **Never partial-silently.** Files that fail to parse appear in `diagnostics.parseErrors`; they do not vanish.
- **Concurrency:** CPU-bound; in-flight parses capped at `cores - 1`, single-flight per `workspacePath`.

### `GET /v1/version`
```json
{ "parserVersion": "1.4.0", "ruleVersion": 3, "javaParserVersion": "3.25.x" }
```
Recorded on every `graphVersion`, so changing a Spring inference rule becomes a
visible, invalidating event rather than silent behavioural drift.

### `GET /healthz`, `GET /readyz`
Liveness and readiness. `readyz` fails if the shared volume is not mounted.

---

## 9. Webhook and queue flow

### 9.1 Receiving

`POST /api/webhooks/github`

1. Read the **raw** body (the JSON body parser must preserve the buffer).
2. Verify `X-Hub-Signature-256` with `crypto.timingSafeEqual`. Invalid → `401`.
3. Insert `webhookDeliveries` with `_id = X-GitHub-Delivery`. Duplicate key → `200`, done.
4. Switch on event:
   - `push` to the default branch → enqueue `index`
   - `pull_request` `opened` / `synchronize` / `reopened` → create the `analyses` doc, enqueue `analyze`
   - `installation`, `installation_repositories` → upsert `installations` / `repos`
   - anything else → ack and ignore
5. Respond **`202`** with `{ deliveryId, analysisId? }`.

Budget: p99 under 500ms against GitHub's ~10s timeout (C6). The handler performs
no clone, no parse, and no collection scan — two small writes and an enqueue.

### 9.2 Queues

Redis-backed BullMQ.

| queue | jobId (natural dedupe) | concurrency |
|---|---|---|
| `index` | `index:{repoId}:{sha}` | 1 per repo (Redis lock `lock:repo:{repoId}`) |
| `analyze` | `analyze:{repoId}:{pr}:{headSha}` | N, but blocks on the repo lock while cloning |
| `history` | `history:{repoId}:{functionKey}:{sha}` | N, lazy, best-effort |

Deterministic job IDs mean a redelivered webhook or a double-clicked re-run
cannot start duplicate work.

### 9.3 Retries

3 attempts, exponential backoff 5s → 30s → 2m. Errors are classified: a network
blip or a busy parser retries; "repository has no Java sources", "installation
suspended", or a 4xx from the parser fails immediately with an actionable
message on the `analyses` document. Silent infinite retry is never correct here —
someone is watching a spinner.

### 9.4 Analyze waiting on its base graph

If the base SHA has no `ready` graph, the analyze job enqueues the index job for
that SHA and re-delays itself (10s → 30s → 60s, capped at 10 minutes total). On
expiry the analysis fails with "base commit was never indexed", which is a true
and fixable statement, rather than analysing against the wrong graph.

### 9.5 Pinning and retention

An analysis pushes its id into `graphVersions.pinnedBy` before reading and pulls
it in a `finally`. The retention sweep deletes `superseded` versions only when
`pinnedBy` is empty and the version is past a grace period. This is what stops
D3's pointer swap from deleting the graph an in-flight analysis is walking.

### 9.6 Frontend polling

`GET /api/analyses/:id` → `{ status, progress: { step, pct }, result? }`.
Poll at 2s, backing off to 5s after 30s, giving up at 10 minutes.
`GET /api/repos/:repoId/pulls/:number/latest` resolves the newest non-superseded
analysis, so a page reload finds the run without holding an id.

---

## 10. Impact traversal → the context object

The traversal produces a **curated, ranked context object**, not a raw subgraph:
two reverse zones plus a small, explicitly labelled forward section. This shape
is also the eval ground truth — `directCallers`, `reachableSurfaces`, and the
`signatureCompatible` flags are exactly what the rubric scores, so the schema and
the rubric change together.

```jsonc
{
  "schemaVersion": 1,
  "repo": { "owner": "acme", "name": "billing", "prNumber": 412 },

  "changedMethod": {
    "key": "fn:com.acme.user.UserService#findById(java.lang.Long)",
    "displayName": "UserService.findById(Long)",
    "changeKind": "signature_changed",
    "filePath": "src/main/java/com/acme/user/UserService.java",
    "signatureDiff": {
      "base": "public User findById(Long id)",
      "head": "public Optional<User> findById(Long id)",
      "returnTypeChanged": true,
      "paramsChanged": false,
      "throwsAdded": [],
      "visibilityChanged": false
    },
    "sourceDiff": "@@ -41,7 +41,7 @@ …"     // unified diff of this method only, capped
  },

  "affectedBy": {                            // REVERSE — who is hurt by this
    "directCallers": [                       // 1–2 hops, detailed, RANKED
      {
        "key": "fn:com.acme.user.UserController#get(java.lang.Long)",
        "displayName": "UserController.get(Long)",
        "hops": 1,
        "callSite": { "filePath": "…/UserController.java", "line": 28 },
        "usage": "return value assigned and dereferenced",
        "signatureCompatible": false,
        "edgeConfidence": "exact",
        "inferred": false
      }
    ],
    "directCallerTotal": 14,                 // true count; the list above is capped
    "directCallersTruncated": true,

    "reachableSurfaces": {                   // deeper reverse walk, TERMINALS ONLY
      "entrypoints": [
        { "key": "route:GET /api/users/{id}", "kind": "http_route",
          "minHops": 2, "viaInferredEdge": false },
        { "key": "job:com.acme.billing.NightlyJob#run()", "kind": "scheduled_job",
          "minHops": 4, "viaInferredEdge": true }
      ],
      "data": [
        { "key": "table:user_account", "kind": "table", "access": "read",
          "viaInferredEdge": true, "confidence": "single_impl" }
      ]
    },

    "traversal": { "maxDepth": 5, "depthCapHit": false, "nodesVisited": 231 }
  },

  "nowDependsOn": {                          // FORWARD — 1 hop only
    "callees": [
      { "key": "fn:com.acme.user.UserRepository#findById(java.lang.Long)",
        "displayName": "UserRepository.findById(Long)",
        "isNew": true, "edgeConfidence": "single_impl", "inferred": true }
    ]
  },

  "changeHistory": {
    "commits": [
      { "sha": "a1b2c3d", "authorName": "…", "authoredAt": "2026-07-14T…",
        "subject": "Make findById null-safe", "insertions": 6, "deletions": 2 }
    ],
    "truncatedAtRename": false
  },

  "quality": {
    "unresolvedRate": 0.052,
    "ambiguousEdgesOnPath": 1,
    "parseErrorsInTouchedFiles": 0
  }
}
```

### Traversal rules

- **Zone 1, `directCallers`:** reverse over `calls` / `implements` / `overrides`, 1–2 hops, full detail. Ranked with signature-incompatible callers first, then by hop count, then by `edgeConfidence` (`exact` above `ambiguous`). Capped at N (start at 15), with `directCallerTotal` always reporting the true number — the count is a fact from the graph, never an LLM estimate.
- **Zone 2, `reachableSurfaces.entrypoints`:** continue the reverse walk to a safety cap of depth 5, **discarding intermediate functions** and keeping only terminal surfaces, deduped and flattened. This is why a change to a util method yields a short list instead of three hundred nodes.
- **`reachableSurfaces.data`:** collected in the *forward* direction (a table is downstream of the method, not upstream) from the changed method and its immediate callees, following `queries` and `maps_to`. It sits under `reachableSurfaces` because "which tables does this touch" is what a reviewer wants, but it is a different relationship from `entrypoints` — see open question **Q4**.
- **`nowDependsOn`:** forward, exactly one hop. `isNew` is computed by diffing the head overlay's outgoing edges against the base graph's. Kept structurally separate from `affectedBy` so the LLM cannot conflate "affected by" with "depends on".
- **`viaInferredEdge`** is set when any edge on the shortest path was Spring-inferred rather than literally written. The UI and the explanation both need to say "…via the single `@Service` implementation" rather than assert the connection flatly.
- **Rejected:** unbounded reverse traversal keeping all nodes (util changes fan out to hundreds), and symmetric full both-directions traversal (doubles tokens and blurs the two relationships).

### `signatureCompatible`

Computed from the base/head signature pair against the call site: incompatible if
arity changed, a parameter type changed, the return type changed
non-wideningly, or a checked exception was added.

Limitation, stated plainly: a *full* binding check would require re-resolving
each caller at head, and per D4 only the touched files are parsed. For callers in
untouched files this flag is a signature-level heuristic, not a compiler verdict.
It is correct for the cases that matter (arity and type changes) and can be wrong
at the margins (overload sets, generic inference).

---

## 11. The LLM boundary

### 11.1 What crosses it

Exactly one thing: the serialised context object from §10. No repository handle,
no database access, no tools, no retrieval, no follow-up turn that could fetch
more. If a fact is not in that JSON, the model has no path to it.

Everything numeric — caller counts, hop distances, commit counts — is
pre-computed. The model is never asked to count.

### 11.2 Call shape

TypeScript, from the Node worker only, **behind an `LLMProvider` interface** —
`generate(contextObject, promptVersion) → sections`. No provider specifics leak
past that interface, so swapping the model stays a config change (the same seam as
D2's TypeSolver, applied to the LLM). This also keeps the eval's cross-provider
comparison a one-line switch. v1 implementation: `GeminiProvider` using
`@google/genai`.

- Model `gemini-2.5-flash` (free tier). This is bounded rewriting of a supplied
  structure, not open-ended reasoning, so a small fast model is the right default;
  move to a larger Gemini — or another provider behind the same interface — only
  if eval scores say so.
- **Structured outputs:** `responseMimeType: "application/json"` with a
  `responseSchema` whose properties are the fixed sections (§11.5), so a missing or
  extra claim is structurally visible. This is the load-bearing setting, and it
  carries over cleanly — the fixed-section schema is provider-independent.
- `thinkingConfig` left unset (no thinking budget) in v1; raise only on eval
  evidence.
- `maxOutputTokens` ≈ 4000, non-streaming (the user is polling a job, not watching
  a cursor).
- **Reliability note.** Flash follows a strict JSON schema slightly less reliably
  than a frontier model, so the validator's repair loop (§11.3 step 5) will fire
  more often. That is expected, not a regression: the correctness guarantee is the
  validator, never the model — which is exactly what makes a free, smaller model a
  safe choice here rather than a compromise.

**No provider-level prompt caching in v1.** Gemini's context caching is explicit
(cached content with a TTL and a high minimum token count) and is unnecessary at
this scale, where per-call LLM cost is effectively zero. The cost-saver that
matters is the application-level `explanations` cache below, which is
provider-independent. The frozen instruction block, the edge/confidence
vocabulary, and the few-shot examples are still grouped ahead of the per-request
context object, so if a provider with automatic prefix caching is adopted later, a
cache breakpoint drops in there without restructuring the prompt.

**Cost control (the cache that actually governs cost).** `explanations` is keyed by
`sha256(canonicalJson(contextObject)) + promptVersion + model`. Re-opening a PR,
re-running an analysis, or pushing a commit that does not change a given function's
context all hit this cache and make no API call. `promptVersion` and `model` in the
key mean editing the prompt or switching models invalidates deliberately.

### 11.3 The validator (D6)

After generation, before storage:

1. Build a **symbol allowlist** from the context object: every FQCN, class name, method name, route path, HTTP method, table name, entity name, file path, commit SHA, and author name it contains.
2. Build a **numeric allowlist**: every integer appearing in the context object (`directCallerTotal`, `minHops`, insertion counts, …).
3. Extract candidates from the generated prose — Java-style dotted names, `ClassName.method(...)` forms, `METHOD /path` routes, `snake_case` table names, file paths — and all integers.
4. Any candidate outside its allowlist is a **violation**.
5. On violation: one repair attempt, re-sending the same context object with the violation list appended as an operator instruction.
6. On a second failure: discard the generation, render a deterministic template-only summary from the context object, and mark the result `degraded: true` in the UI. A plain, slightly wooden true answer beats a fluent false one.

Every rejection is logged with the offending token. The rejection rate is a
first-class metric: if it climbs, the prompt or the context schema is at fault.

### 11.4 What the validator does not catch

It catches invented symbols and invented numbers. It does **not** catch a wrong
*relationship* asserted between two symbols that both legitimately appear —
"`NightlyJob` calls `findById`" when the real path runs through three hops.

Two mitigations, both structural rather than hopeful: the output sections map 1:1
onto context-object fields, so a relationship claim has exactly one place it can
live; and `minHops` / `viaInferredEdge` ride along on every surface, so the prompt
can require hedged phrasing for indirect and inferred paths. Claim-level
citations (each sentence carrying the context field it came from, verified
server-side) are the natural next step and are on the roadmap, not in v1.

### 11.5 Output shape

```jsonc
{
  "whatChanged":   "…",   // from changedMethod only
  "whoIsAffected": "…",   // from affectedBy only
  "whatToCheck":   "…"    // from affectedBy + nowDependsOn + quality
}
```

Rendered next to the impact graph. Any `quality.unresolvedRate` above threshold,
or any `ambiguousEdgesOnPath > 0`, forces a visible caveat line — the system says
how confident it is in the same place it says what it found.

---

## 12. Change history

Per C7, from git, in the cache clone (never the worktree):

```bash
git log -L <startLine>,<endLine>:<filePath> --format=%H%x00%an%x00%aI%x00%s -n 20
```

Cached in `changeHistory` keyed by `{repoId, functionKey, headSha}`. The SHA is
part of the key because a function's line range moves with every commit — a key
of `functionKey` alone would serve stale ranges. Run on the `history` queue with
a 5s timeout, best-effort: a failure degrades the `changeHistory` block to empty
and never fails the analysis.

**Limitation, stated rather than papered over:** `git log -L` cannot be combined
with `--follow` and does not cross file renames. History therefore stops at the
commit where the file was renamed, and we set `truncatedAtRename: true` so the UI
and the explanation say so. Stitching segments across renames (via
`git log --follow --name-status`) is roadmap, not v1.

---

## 13. Failure modes and degradation

| Failure | Behaviour |
|---|---|
| Parser service down | `index` / `analyze` jobs retry; the analysis shows "analysis unavailable"; **the last good graph keeps serving**. |
| Parse errors in some files | Those files' nodes are missing; `diagnostics.parseErrors` surfaces in `quality`; the rest of the graph is built. |
| Base commit never indexed | Analysis waits with backoff, then fails with that exact message (§9.4). |
| High `unresolvedRate` | Graph still built; the caveat line fires; the metric alerts. |
| Ambiguous `@Service` impl | Edges to all candidates, `confidence: "ambiguous"`, explanation hedges. |
| LLM call fails, or validator rejects twice | Deterministic template summary, `degraded: true`. The impact graph is unaffected — it never depended on the LLM. |
| Redis down | Webhooks cannot enqueue → return 500 so GitHub retries the delivery. Better a redelivery than a silently dropped push. |
| Worktree disk full | Job fails fast; a sweeper reaps worktrees older than the job timeout. |

The general shape: **the graph degrades visibly, and the explanation degrades
before the graph does.**

---

## 14. Metrics

*Graph quality:* `unresolvedRate`, ambiguous-edge rate, parse errors per index,
node and edge counts per version.

*Pipeline:* webhook ack latency p50/p99 (against the 10s budget), queue depth and
wait time, parse duration, end-to-end push→ready and PR→ready latency.

*LLM:* validator rejection rate, repair-attempt rate, degraded-output rate,
explanation cache hit rate (the `explanations` collection — the metric that
actually governs cost here; a low hit rate, not a caching flag, is what to watch),
and tokens per analysis from Gemini's `usageMetadata`
(`promptTokenCount` / `candidatesTokenCount`).

`unresolvedRate` and the validator rejection rate are the two that indicate the
product is quietly getting worse. They should alert.

---

## 15. Out of scope for v1

Explicitly not designed here: a natural-language chat box over the graph; teams,
multi-repo access control, and user accounts; anything beyond a basic
force-directed impact graph in the UI; languages other than Java; build-system
integration; writing results back to GitHub as a check run or PR comment.

---

## 16. Open questions

Underspecified points, each with the assumption the document currently runs on.
These want answers before implementation rather than guesses.

**Q1 — Node key vs. renames.** C4 says the key is "stable across renames", but
`fqcn#method(paramTypes)` changes when the class or method is renamed or a
parameter type changes; §6.1 records what it is actually stable across.
*Assumption:* a rename produces a new node and the old one disappears with its
graph version. Is linking them (a `previousKey` derived from git rename detection
plus `bodyHash` matching) wanted in v1, or is roadmap fine?

**Q2 — Test sources.** *Assumption:* `src/test/java` is excluded from the graph.
But "which tests cover the code you changed" is arguably the most useful impact
answer available, and it is nearly free once tests are parsed. Include them as a
`test` surface kind?

**Q3 — Multi-module builds.** *Assumption:* discover every `**/src/main/java`
root and register a `JavaParserTypeSolver` for each, so cross-module calls
resolve. Are v1 target repos single-module? If a multi-module repo is in scope,
should modules be separate graphs or one?

**Q4 — Direction of data surfaces.** Entry points are found by reverse traversal;
tables and entities are *downstream* (forward) of the change. §10 splits them into
`entrypoints` and `data` under one `reachableSurfaces` key. Is that the intended
reading, or should `data` move under `nowDependsOn`?

**Q5 — Base SHA semantics.** *Assumption:* use `pull_request.base.sha` from the
payload. That is the tip of the base branch at event time, not the merge base.
For a long-lived PR the merge base is usually the more honest comparison. Which?

**Q6 — App-level authentication.** Access control is out of scope, but with a
GitHub App the web app renders private source diffs. *Assumption:* single-tenant,
no login, deployed behind a network boundary. Please confirm — this is a security
posture, not a feature cut.

*LLM data posture:* the v1 model is Gemini's free (AI Studio) tier, which may use
inputs for training — and the inputs are source code. Acceptable for my own two
repos; the paid Gemini/Vertex tier (which does not train on inputs) or a Claude
provider behind the same `LLMProvider` interface is the boundary to cross before
this ever touches anyone else's private code.

**Q7 — How much source reaches the LLM.** *Assumption:* `sourceDiff` is the
unified diff of the changed method only, capped around 200 lines. Should caller
bodies ever be included? They currently are not, which is what keeps the context
object small and the boundary clean.

**Q8 — Retention.** Graph versions are current + in-progress. What about
`analyses` and `explanations` — keep indefinitely (they are small, and they make
the eval corpus), or TTL them?

**Q9 — Scale ceiling.** Sizing assumes 50–300 files and a seconds-long full parse.
What is the hard cap at which indexing should fail loudly, rather than silently
taking minutes and blowing the PR→ready latency budget?

**Q10 — Frontend graph size.** *Assumption:* the force-directed view caps at ~150
nodes, collapsing beyond that. Confirm the cap and the collapse behaviour.

### 16.1 Answers (BUILD_PLAN Step 0)

Closed before implementation, so Claude Code doesn't stall on §16 mid-milestone.

- **Q1 (renames):** new node; the old one disappears with its graph version.
  Rename-linking via git rename detection + `bodyHash` matching → roadmap.
- **Q2 (test sources):** **excluded** — `src/test/java` is out of the v1 graph.
  Leaner scope; test-coverage edges ("which tests cover this change") → roadmap.
- **Q3 (multi-module):** checked both real target repos
  (`dummy-proj/Dummy/pom.xml`, `oberservability-final/Dummy/pom.xml`) — neither
  declares a `<modules>` block, so both are **single-module**. §8's "discover every
  `**/src/main/java` root" stands as written (it is a no-op on a single-module repo
  and free multi-module support later); one graph per repo either way. Revisit if a
  multi-module repo enters the corpus.
- **Q4 (data surfaces):** confirmed as documented — `data` stays under
  `reachableSurfaces`, distinct from `entrypoints`, because it is a forward
  relationship reported alongside the reverse one for reviewer convenience, not
  merged into `nowDependsOn`.
- **Q5 (base SHA):** use `pull_request.base.sha` for v1. Merge-base comparison →
  roadmap.
- **Q6 (auth posture):** single-tenant, no login, deployed behind a network
  boundary. Paired with the Gemini free-tier training note above — both are the
  same posture: acceptable for the author's own repos, both are the boundary to
  cross before this touches anyone else's private code.
- **Q7 (source to LLM):** the changed method's unified diff only, ~200 lines
  capped. No caller bodies — keeps the context object small and the LLM boundary
  clean.
- **Q8 (retention):** **keep** `analyses` and `explanations` indefinitely — both
  are small, and together they are the eval corpus (§DECISIONS "An eval is the
  differentiator").
- **Q9 (scale ceiling):** deferred to M2 — pick the hard file/edge cap once real
  parse timings exist against both target repos, rather than guess a number now.
- **Q10 (frontend graph cap):** ~150 nodes, collapse beyond that. Confirmed;
  revisit visually in M7.

---

## 17. Roadmap (documented, not built)

- **Classpath type resolution** — `mvn dependency:build-classpath` / the Gradle equivalent, a `JarTypeSolver` per jar, cached per `pom.xml` / `build.gradle` hash. Sits behind the TypeSolver interface from D2, so it lands without touching the graph model or node keys. Fixes the overload limitation (§6.6). *Trigger:* `unresolvedRate` persistently high enough to degrade explanations.
- **Incremental indexing** — dirty-set expansion (re-parse changed files plus files whose resolution depends on them), with a periodic full rebuild as a correctness backstop. *Trigger:* full re-index time exceeding an acceptable webhook-to-ready latency.
- **Claim-level citations** (§11.4).
- **Rename-crossing change history** (§12).
- **Test-coverage edges** (Q2).
