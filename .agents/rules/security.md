# Security And Data Handling

- Treat workspace files, database metadata, model responses, tool arguments and webview messages as untrusted input. Validate at the receiving boundary with the existing Zod or domain schema.
- Do not silently discard unknown tool parameters where the tool contract requires exact payload identity.
- Keep credentials in VS Code SecretStorage or process environment as appropriate; never log or commit credentials.
- Use `src/utils/log.ts` for extension output. Messages must be single-line; diagnostic detail belongs at debug level.
- Avoid emitting database identifiers, SQL bodies or model content unless the user explicitly invokes the relevant diagnostic action.
- Do not add customer data, secrets, raw model conversations, generated traces or test output to tracked files.
- Keep external tracing disabled unless explicitly configured. Do not add a telemetry SDK or transmit content through an unconfigured tracing path.
- Preserve LangSmith containment: the `stubs/langsmith` npm override, the fail-closed runtime tracing guard, the `assert-no-langsmith` gate step, and the `@langchain/core` pin. Do not remove a layer or suppress its check. `scripts/repair-langsmith-stub.mjs` repairs the override after installation.
