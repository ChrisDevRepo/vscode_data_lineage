---
name: trace-debug
description: Diagnose one AI turn from an existing capture and report an evidence-backed cause or the missing evidence. Use for a specific request, state-machine dump, NDJSON quick analysis, extension log, or configured debug trace.
---

# Trace debug workflow

1. Start from the capture that already exists. Preserve it and identify its request or trace correlation id.
2. Read the relevant [runtime and tool contracts](../../../docs/ARCHITECTURE.md). Inspect the extension output log, state-machine dump, and NDJSON in timestamp order. Align events by request id and hop.
3. Reconstruct the captured context and record anything the capture omits. Check each claim against the payload: user request, prior messages, tool schemas, tool results, active instructions, and available state.
4. Separate provider or network failures, runtime or tool failures, missing context, and answer-quality issues. A model response alone does not identify the cause.
5. Use a configured debug trace for span relationships and provider timing. Note missing spans. The local NDJSON remains the quick-analysis record.
6. When no capture exists, run the one question under [When a live run is worth its cost](../../../docs/testing/README.md#when-a-live-run-is-worth-its-cost).
7. Apply the [security rule](../../rules/security.md) before sharing a trace. Report the affected request or hop, the evidence-backed cause or the next diagnostic step, and the limitations.

## Artifact reading

- A state-machine dump (`sm-dump`) is the navigation and runtime state at one moment.
- NDJSON is the quick-analysis log. Preserve line order. On the opening `trace-open` record, `origin` names the producer and `verbose` says whether system prompts and provider payloads were captured. When `verbose` is absent, record that those payloads were not captured.
- A debug trace adds span relationships and provider timing. It stays a supplement to the NDJSON record.
- Trace-metrics reads captures that already exist and describes recorded calls and operational failures. Content differences go to [baseline review](../../../docs/testing/README.md#before-deployment-baseline-review).
