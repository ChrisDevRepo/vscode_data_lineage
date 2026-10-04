---
name: trace-debug
description: Load when investigating a specific AI turn, state-machine dump, NDJSON trace, extension log, or Langfuse trace.
---

# Trace Debug Workflow

1. Reproduce the reported turn and identify its request/trace correlation id. Preserve the original artifacts before interpreting them.
2. Read `docs/ARCHITECTURE.md` for the runtime phase and tool contracts. Inspect the extension output log, state-machine dump, and NDJSON in timestamp order; align events by request id and hop.
3. Reconstruct the exact context at the relevant model call: user request, prior messages, tool schemas, tool results, active instructions and available state. Verify each claim against the captured payload.
4. Separate provider/network failures, runtime/tool failures, missing context, and answer-quality issues. A model response alone does not identify the cause.
5. If a separate Langfuse integration is configured, use it to follow parent/child spans and compare provider latency, input/output, tool calls and errors with the captured artifacts. The exported trace can be incomplete; note missing spans rather than inferring them.
6. Remove secrets, database identifiers and customer content before sharing any trace. Do not add traces or dumps to the public repository.

## Artifact Reading

- A state-machine dump (`sm-dump`) is a point-in-time view of navigation/runtime state; it is not the full model transcript.
- NDJSON is an event stream. Preserve line order and correlate messages, tool calls, tool results and state changes; do not flatten it into one answer string before checking sequence. Check the opening `trace-open` record: `origin` identifies the producer, and `verbose` indicates whether full system prompts and provider payloads were captured. Default traces omit those verbose payloads; record missing evidence instead of claiming an exact reconstruction.
- Langfuse is useful for span relationships and provider-side timing. It does not replace the request payload or prove that the model received an artifact absent from the trace.

The public extension writes local NDJSON diagnostics; it does not export Langfuse traces.
