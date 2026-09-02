# CLAUDE.md

Guidance for Claude Code working in this repo. Keep this file lean — it loads every turn.
Full design lives in `ARCHITECTURE.md`; the "why" behind each choice is in `DECISIONS.md`;
the milestone-by-milestone plan is in `BUILD_PLAN.md`. Read those before large changes.

## What this is
A web app that explains the **impact of a pull request**, not just the diff. It builds a
static call graph of a Java Spring Boot repo, walks it to find what a change affects, and
uses an LLM only to turn that verified structure into English. v1 targets **Java Spring Boot
repos only**.

## Stack
- **Backend:** Node + Express (API), Node worker(s) for indexing/analysis.
- **Parser service:** a separate **Spring Boot** app using **JavaParser + JavaSymbolSolver**.
- **Data:** MongoDB (graph + results), Redis + BullMQ (jobs).
- **Frontend:** React, with a force-directed impact graph.
- **LLM:** Google **Gemini 2.5 Flash** (free tier), behind an `LLMProvider` interface.

## Non-negotiable rules (do not violate without an explicit decision)
1. **The graph decides what is true. The LLM only phrases it.** The model gets one
   serialized context object and nothing else — no repo access, no DB handle, no tools,
   no retrieval. If a fact isn't in the context object, it must not appear in the output.
2. **Parsing is JavaParser + JavaSymbolSolver, never tree-sitter.** Real type resolution
   is required for the Spring edges.
3. **Graph edges live in a separate `edges` collection** (`{from,to,type}`, indexed both
   ways). Never embed caller/callee arrays on nodes.
4. **Node identity key is `fn:fqcn#method(paramTypes)`** (see ARCHITECTURE §6.1). A
   signature change is the *same* node with a *new version*, not a new node.
5. **A deterministic post-generation validator guards every LLM output** (ARCHITECTURE
   §11.3). Any symbol or number in the prose that isn't in the context object is rejected.
   Never weaken the validator to make a model pass.
6. **Everything numeric is precomputed.** The model is never asked to count.
7. **The `LLMProvider` interface stays provider-agnostic.** No Gemini/Anthropic specifics
   leak past it. Swapping models must remain a config change.

## Intended layout (monorepo)
```
/api            Express app: webhook receiver, read endpoints
/worker         Node worker: git, indexing, analysis, LLM call
/parser         Spring Boot parser service (Java)
/web            React frontend
/shared         shared TS types (context object, graph model)
/eval           eval harness + PR corpus
docker-compose.yml   Mongo + Redis for local dev
```

## Conventions
- TypeScript everywhere on the Node side; strict mode on.
- The parser HTTP response is a **pure function** of (workspace, mode, files, options) —
  keep it deterministic so graph versions are reproducible; snapshot-test it.
- Put the node-key derivation and the graph model under tests **before** building on them;
  a bug there is silent.
- One milestone per branch/PR (see BUILD_PLAN.md). Prefer plan mode for each milestone.
- Build fixtures from the two real Spring repos, not toy examples.
- **Verify builds by EXIT CODE, never by grepping output for "ERROR".** A grep that
  finds nothing is not a passing build. `mvn ... ; echo $?` — 0 or it did not pass.
  (Learned the hard way in M2 phase 4: a false green sent work down a dead end.)
- **Measure only after a green build.** Re-running a measurement against a failed
  build measures stale classes. Fix → build green → measure once, not fix → measure
  → fix.
- **Never let a broad `catch` hide a defect.** `catch (RuntimeException ignored)` around
  extraction turned a real bug into "no edges emitted" with no signal. If a catch is
  load-bearing for resilience, count what it swallows and surface the count.

## Commands
```bash
npm install            # once, at the root — npm workspaces
npm run dev:infra      # docker compose up -d  (Mongo + Redis)
npm run dev:infra:down # docker compose down
npm run typecheck      # tsc -b across shared/api/worker/eval
npm test               # vitest run  (npm run test:watch to watch)
npm run lint           # eslint
npm run format         # prettier (code only — *.md is ignored on purpose)
npm run dev:api        # tsx watch; GET http://localhost:3000/healthz
```
Copy `.env.example` → `.env` before running anything that needs credentials.

**Toolchain note:** TypeScript is pinned to **6.0.x**. TS 7 (the native rewrite) is `latest`,
but `typescript-eslint@8` requires `typescript <6.1.0`. Bump both together when
typescript-eslint supports TS 7.

Parser service (`/parser`, Java 21 + Maven):
```bash
cd parser && mvn test                    # unit + regression tests
cd parser && mvn package -DskipTests     # builds target/parser-0.1.0.jar
cd parser && mvn spring-boot:run         # serves on :8080
```
HTTP API (M2 phase 7): `POST /v1/parse`, `GET /v1/version`, `GET /healthz`, `GET /readyz`.
**Kill the server before `mvn clean`** — Windows keeps the running jar's file handle
open and `clean` will fail with "process cannot access the file". Find the real PID
with `netstat -ano | grep ':8080'` (Git Bash's own `$!` PID is not the Windows PID
for a backgrounded `java -jar`), then `taskkill //F //PID <pid>`.

Parser CLI — point it at a repo and dump the §8 JSON (M2 phase 6). Any CLI flag
selects one-shot mode; with none, the jar starts the web service:
```bash
java -jar parser/target/parser-0.1.0.jar --dir <repo> --summary          # digest for eyeballing
java -jar parser/target/parser-0.1.0.jar --dir <repo> --out graph.json   # full JSON
java -jar parser/target/parser-0.1.0.jar --dir <repo> --files a.java,b.java   # subset mode (D4)
```
Exit codes: 0 ok, 2 usage error or no Java source roots (§8's 422 case).

Validating the parser against the two real repos (DECISIONS, "Validation & eval repos").
These tests **skip** when the properties are unset, so a plain `mvn test` stays green
without the checkouts:
```bash
cd parser && mvn test -Dtest=RealRepoExtractionTest -Dvalidation.observability="C:/Users/anime/OneDrive/Desktop/oberservability-final/Dummy" -Dvalidation.petclinic="C:/Users/anime/OneDrive/Desktop/mern-llm-proj/_validation/spring-petclinic-rest"
```
Note the folder on disk is spelled `oberservability-final`; the docs call the repo
`observability-final`.

_Frontend commands land with M7._
