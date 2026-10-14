# Security and data handling

- Treat workspace files, database metadata, model responses, tool arguments and webview messages as untrusted input. Validate at the receiving boundary with the existing Zod or domain schema.
- Do not silently discard unknown tool parameters where the tool contract requires exact payload identity.
- A boundary check accepts or rejects; it never repairs invalid values. The logged identifier resolution and valid JSON-text decoding described in `docs/ARCHITECTURE.md` are encoding normalization, not repair. Do not move, rewrite, complete or default a model-supplied value to make it pass. A rejection names the rule broken, the allowed form and the next call; the model reads the reason and the hint, never a bare code. Each further rejection of the same step adds detail, and the step ends as a logged error when its reply limit is spent.
- BB and CT share one admission path: normalize supported encodings, validate shape and assigned-task decisions, then ACK and commit or REJECT before routing, pruning or completing tasks. CT adds qualified mapping and root-connectivity checks; do not duplicate the shared dispatcher or infer SQL meaning. Return route dispositions to the caller rather than hiding them in logs.
- On analyze, require explicit neighbor decisions and investigation questions. Generate CT instruction text only from submitted mappings; only explicit passthrough authorizes automatic forwarding of the incoming question. Preserve legitimate terminal columns; never restart a terminated CT branch from BB, historical edges, matching names or prose.
- An incomplete submission receives the exact missing neighbor or target and a repair hint requesting only the missing entries plus the required tool envelope. Retain unrelated valid fields, merge the correction and revalidate before commit. Do not require the model to regenerate held answers.
- A fault the sender cannot correct (backend state, thrown exception) ends the run as a logged error; it is never returned as a retry request.
- Keep credentials in VS Code SecretStorage or process environment as appropriate; never log or commit credentials.
- Use `src/utils/log.ts` for extension output. Messages must be single-line; diagnostic detail belongs at debug level.
- Avoid emitting database identifiers, SQL bodies or model content unless the user explicitly invokes the relevant diagnostic action.
- Do not add customer data, secrets, raw model conversations, generated traces or test output to tracked files.
- Keep external tracing disabled unless explicitly configured. Do not add a telemetry SDK or transmit content through an unconfigured tracing path.
- Preserve LangSmith containment: the `stubs/langsmith` npm override, the fail-closed runtime tracing guard, the `assert-no-langsmith` gate step, and the `@langchain/core` pin. Do not remove a layer or suppress its check. `scripts/repair-langsmith-stub.mjs` repairs the override after installation.
