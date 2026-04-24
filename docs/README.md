# Documentation

Entry point for every audience. Pick the column that matches you.

## By audience

| I am… | Start with | Then read |
|---|---|---|
| **An end user** — installed the extension, want to use it | [`../README.md`](../README.md) → [`FEATURES.md`](FEATURES.md) | [`TROUBLESHOOTING.md`](TROUBLESHOOTING.md) when stuck |
| **A database admin** — setting up DMV import | [`DMV_QUERIES.md`](DMV_QUERIES.md) | [`TROUBLESHOOTING.md`](TROUBLESHOOTING.md) § Import and connection |
| **A contributor** — want to submit a fix | [`../CONTRIBUTING.md`](../CONTRIBUTING.md) | [`TECHNICAL_ARCHITECTURE.md`](TECHNICAL_ARCHITECTURE.md), [`TESTING.md`](TESTING.md) |
| **An AI integrator / prompt engineer** — hacking on `@lineage` | [`AI_ARCHITECTURE.md`](AI_ARCHITECTURE.md) | [`AI_PROMPTS.md`](AI_PROMPTS.md) |
| **Extending the SQL parser** | [`PARSE_RULES.md`](PARSE_RULES.md) | [`TESTING.md`](TESTING.md) § parser snapshot protocol |
| **Tuning table profiling** | [`PROFILING_PATTERNS.md`](PROFILING_PATTERNS.md) | `FEATURES.md` § profiling |

## Files

| File | Scope |
|---|---|
| [`FEATURES.md`](FEATURES.md) | End-user reference: what each feature does, which settings control it |
| [`TECHNICAL_ARCHITECTURE.md`](TECHNICAL_ARCHITECTURE.md) | High-level layering: extension host, webview, engine, AI |
| [`AI_ARCHITECTURE.md`](AI_ARCHITECTURE.md) | `@lineage` Grounded Router: state machine, memory tiers, tool surface, consent gates, design rationale |
| [`AI_PROMPTS.md`](AI_PROMPTS.md) | Prompt layer: builder hierarchy, YAML capture/render templates, stage routing |
| [`PARSE_RULES.md`](PARSE_RULES.md) | Regex-based SQL body parser + XML fallback; YAML rule customization |
| [`DMV_QUERIES.md`](DMV_QUERIES.md) | Database metadata extraction via DMVs; YAML customization |
| [`PROFILING_PATTERNS.md`](PROFILING_PATTERNS.md) | Live table profiling SQL patterns (quick + standard modes) |
| [`TESTING.md`](TESTING.md) | Test tiers, commands, fixture policy, snapshot-baseline protocol |
| [`TROUBLESHOOTING.md`](TROUBLESHOOTING.md) | End-user problem-solver and diagnostic collection |

## Terminology (canonical terms)

Different subsystems sometimes describe the same idea. These are the preferred terms — prose drift should be corrected toward these:

| Preferred | Also seen (retire) | Meaning |
|---|---|---|
| **Hourglass model** | "Asymmetric Tiering" | Full context at Discovery/Synthesis; narrowed-and-wiped context during Active |
| **Sliding-memory (SM) mode** | "sliding-window", "hop loop alone" | Hop-by-hop execution; engine owns termination; history wiped between successful hops |
| **Inline mode** | "one-shot", "batch mode" | Scope fits budget; AI completes in a single LM turn over the full set |
| **Blackboard (BB) / Column-Trace (CT)** | "dependency mode" | Two navigation modes driven by `engine.columnAspect`; `dependency` was folded into BB |
| **Agenda** / **Scope** | — | Agenda = bodied nodes the AI will focus on; Scope = every reachable node (tables included). Bipartite rule. |
| **Source / Target** | "upstream / downstream" (inconsistently) | Source = where data comes from; Target = where it goes. Matches React Flow edge direction (source → target). |
| **Consent gate** | "action required", "approval modal" | Engine emits a structured envelope; the participant pauses the turn and asks the user yes/no |

## What's not here

- Release process and marketplace publish — handled internally; see `CHANGELOG.md` for the history.
- Customer-specific schema examples — this project ships only the AdventureWorks demo. Do not submit customer dacpacs to issues or PRs.
