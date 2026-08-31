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

## Commands
_Not yet implemented — fill in as milestones land (M1 sets up docker-compose + scaffolds)._
