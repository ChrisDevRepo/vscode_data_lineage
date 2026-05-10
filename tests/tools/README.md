# tests/tools — LM Traffic Analysis Tools

Post-session diagnostic scripts for `src/ai/lmTracer.ts`. These tools analyze NDJSON trace files produced by the tracer to measure token spend, detect behavioral problems, and track improvement over time.

**Not shipped in the VSIX** — `tests/**` is excluded via `.vscodeignore`.

## Prerequisites

1. Set `ENABLED = true` at the top of [`src/ai/lmTracer.ts`](../../src/ai/lmTracer.ts) (disabled by default).
2. Rebuild the extension and run a `@lineage` chat session.
3. The trace file appears at `tmp/lm-trace/trace-{iso}.ndjson` (gitignored).

## trace-analyze.js

Analyzes a captured trace. All flags can be combined freely.

```
node tests/tools/trace-analyze.js <file.ndjson> [flags] [--sid <id>]
```

| Flag | Output |
|---|---|
| `--summary` | Per-session totals: rounds, tokens, tools, rejections. Default when no flag given. |
| `--phase` | Token breakdown per phase (compose / discover / active / synthesis / completed). |
| `--patterns` | Which prompt structural blocks appear in which phase; flags cross-phase anomalies. |
| `--redundancy` | Duplicate content across message parts in the same request. |
| `--rejected` | All tool result rejections with error codes and hints; marks expected gate rejects (`start_exploration` + `confirm_sm_start`) separately. |
| `--loops` | Same tool called consecutively with identical input (≥2×). |
| `--wipes` | All context wipe events with triggers and message counts. |
| `--waste` | Tokens in-flight at wipe time vs total sent. |
| `--tools` | Tool call frequency, avg duration, rejection rate, cache hits. |
| `--growth` | Per-round total context size in chars + growth % vs previous round. |
| `--tool-bloat` | Per-tool result payload size: avg/max chars, % of total. |
| `--detail-metrics` | Per-round content depth: sections, badge/caption limits, chat output, math violations. |
| `--ct` | Column tracing analysis: CT session detection, per-hop flow coverage, CT-specific rejections, column propagation edges. |
| `--report` | Full round-by-round narrative: prompt excerpts, tool calls, results. |
| `--sizes` | Per-round message composition breakdown: system / history / tool_results / prompt. |
| `--timeline` | Chronological event dump from SESSION_START to SESSION_END. |
| `--journal-metrics` | Emits ONE compact JSON line to stdout. Includes `expected_gate_rejects`, `unexpected_rejects`, and prune metrics (`prune_verdict_count`, `prune_neighbors_count`, `ct_auto_prune_count`). Pipe to `>> tmp/lm-journal/journal.jsonl`. |
| `--sid <id>` | Filter all output to one session ID. |

**Full diagnostic run (all flags):**
```
node tests/tools/trace-analyze.js tmp/lm-trace/<file>.ndjson \
  --summary --phase --patterns --redundancy \
  --rejected --loops --wipes --waste \
  --tools --growth --tool-bloat --detail-metrics
```

**Append to journal:**
```
node tests/tools/trace-analyze.js tmp/lm-trace/<file>.ndjson --journal-metrics >> tmp/lm-journal/journal.jsonl
```

## generate-ideal.js

Reads a `.dacpac` file to extract model fingerprint metrics, calibrates performance targets from the latest trace (summing all phases), and writes `tmp/lm-ideal/ideal-run.md`.

```
node tests/tools/generate-ideal.js [path/to/dacpac]
```

Default dacpac: `assets/demo.dacpac`. Run once after a representative session to set baseline targets. Regenerate after a run that consistently beats existing targets.

## Output directories (gitignored, local only)

| Path | Contents |
|---|---|
| `tmp/lm-trace/` | Raw NDJSON trace files — one per session |
| `tmp/lm-journal/` | `journal.jsonl` (one metrics line per run) + `journal.md` (human-readable entries) |
| `tmp/lm-ideal/` | `ideal-run.md` — performance targets for gap comparison |

## Full diagnostic protocol

For the complete 17-question diagnostic workflow — including ideal baseline comparison and journal — see the **LM traffic tracer** section in [`docs/DEVELOPER_GUIDE.md`](../../docs/DEVELOPER_GUIDE.md).
