---
name: trace-debug
description: Diagnose an AI turn from captured events and report an evidence-backed cause or missing evidence. Use for a specific request, state-machine dump, NDJSON quick analysis, extension log, or Langfuse debug trace; use prompt-playground to compare model variants.
---

# Trace debug workflow

1. Reproduce the reported turn and identify its request/trace correlation id. Preserve the original artifacts before interpreting them. A headless reproduction passes the reported question with `npm run test:ai:headless -- --prompt "QUESTION"`.
2. Read the relevant [runtime and tool contracts](../../../docs/ARCHITECTURE.md). Inspect the extension output log, state-machine dump, and NDJSON in timestamp order; align events by request id and hop.
3. Reconstruct the context where captured; explicitly record missing evidence rather than inventing it: user request, prior messages, tool schemas, tool results, active instructions and available state. Verify each claim against the captured payload.
4. Separate provider/network failures, runtime/tool failures, missing context, and answer-quality issues. A model response alone does not identify the cause.
5. If Langfuse debug tracing is configured, use it for span relationships, provider timing, and the verbose input and output. The export can be incomplete; note missing spans rather than inferring them. The local NDJSON remains the production quick-analysis record.
6. Remove secrets, database identifiers and customer content before sharing any trace. Do not add traces or dumps to the public repository. A diagnosis does not add trace-metrics or Langfuse tests to the gate. Report the affected request/hop, evidence-backed cause or next diagnostic step, and limitations.

## Artifact reading

- A state-machine dump (`sm-dump`) is a point-in-time view of navigation/runtime state; it is not the full model transcript.
- NDJSON is the production quick-analysis log. Preserve line order and correlate messages, tool calls, tool results and state changes; do not flatten it into one answer string before checking sequence. Check the opening `trace-open` record: `origin` identifies the producer, and `verbose` indicates whether full system prompts and provider payloads were captured. Default traces omit those verbose payloads; record missing evidence instead of claiming an exact reconstruction.
- Langfuse is the debug trace (`--langfuse` on the headless runner). It is useful for span relationships and provider-side timing. It does not replace the quick NDJSON record, and it does not prove that the model received an artifact absent from the capture.
- Optional `trace-metrics.mjs` diagnostics describe recorded calls and operational failures. Content differences are signals for [manual baseline/SQL review](../../../docs/testing/README.md#before-deployment-baseline-review), not quality verdicts. Inspect each request id and terminal; a successful first turn does not establish that a follow-up completed.

The public extension writes local NDJSON diagnostics. It does not export Langfuse traces.
