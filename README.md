# ai-assisted-code-change-analysis

A web app that explains the **impact of a pull request**, not just the diff.

It builds a static call graph of a Java Spring Boot repository, walks it to find what a change
actually affects, and uses an LLM only to turn that verified structure into English. The graph
decides what is true; the model only phrases it.

The interesting part is resolving Spring's *implicit* edges — the connections that don't exist
in the source text because Spring wires them at runtime:

- interface → its single `@Service` implementation
- `@RequestMapping` route → controller method
- Spring Data derived query → entity → table

## Stack

| Piece | Choice |
|---|---|
| API | Node + Express |
| Worker | Node (git, indexing, analysis, LLM call) |
| Parser service | Spring Boot + JavaParser + JavaSymbolSolver |
| Data | MongoDB (graph + results), Redis + BullMQ (jobs) |
| Frontend | React, force-directed impact graph |
| LLM | Google Gemini 3.6 Flash, behind an `LLMProvider` interface |

v1 targets **Java Spring Boot repositories only**.

## Status

**Not yet functional — under construction.** See [BUILD_PLAN.md](BUILD_PLAN.md) for the
milestone-by-milestone plan and current progress.

## Documentation

- **[ARCHITECTURE.md](ARCHITECTURE.md)** — the full design: data flow, MongoDB schema, parser
  HTTP contract, webhook/queue flow, and the LLM boundary.
- **[DECISIONS.md](DECISIONS.md)** — the *why* behind every load-bearing choice, including what
  was rejected and the reasoning.
- **[BUILD_PLAN.md](BUILD_PLAN.md)** — the milestone plan.
- **[CLAUDE.md](CLAUDE.md)** — working guidance and non-negotiable rules.
