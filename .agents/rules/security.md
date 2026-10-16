# Security and data handling

- Treat workspace files, database metadata, model responses, tool arguments and webview messages as untrusted input. Validate at the receiving boundary with the existing Zod or domain schema.
- Do not silently discard unknown tool parameters where the tool contract requires exact payload identity.
- A boundary check accepts or rejects; it never repairs invalid values. AI tool arguments retain their supplied JSON types and text. Object and column references compare using the permitted SQL representation rules in [`backend-contract.md`](backend-contract.md); metadata binding does not rewrite the submitted payload. Do not decode stringified fields, coerce numeric strings, trim authored prose, infer aliases or supply missing identifiers. Saved-graph compatibility recovery is separate from AI tool binding. Do not move, complete or default a model-supplied value to make it pass.
- Hop submissions (BB and CT) follow [`backend-contract.md`](backend-contract.md): deterministic checks, ACK or REJECT with an escalating self-repair hint, no SQL interpretation, nothing silent.
- Keep credentials in VS Code SecretStorage or process environment as appropriate; never log or commit credentials.
- Use `src/utils/log.ts` for extension output. Messages must be single-line. Debug is the lowest output-log level: database identifiers, SQL text and other diagnostic detail are logged only at debug; error, warn and info give outcomes and counts.
- More detail than debug exists only for AI runs: the local NDJSON trace the user enables per session, and Langfuse debug tracing when configured. Prompts, model responses and tool payloads go only there.
- Do not add customer data, secrets, raw model conversations, generated traces or test output to tracked files.
- Keep external tracing disabled unless explicitly configured. Do not add a telemetry SDK or transmit content through an unconfigured tracing path.
- Preserve LangSmith containment: the `stubs/langsmith` npm override, the fail-closed runtime tracing guard, the `assert-no-langsmith` gate step, and the `@langchain/core` pin. Do not remove a layer or suppress its check. `scripts/repair-langsmith-stub.mjs` repairs the override after installation.
