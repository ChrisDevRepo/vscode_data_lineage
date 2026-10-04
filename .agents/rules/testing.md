# Testing Rules

- Match the test to the behavior: Vitest for deterministic logic; Extension Development Host tests for VS Code API and activation behavior; optional integrations for real services and UI behavior.
- A fixed-response language-model fixture verifies API wiring and runtime lifecycle only. It provides no evidence about inference, prompt quality or answer correctness.
- Keep tests based on the demo fixture or synthetic data. Never add customer data, credentials, raw conversations, or generated provider traces.
- Keep tests repeatable, bounded by timeouts and explicit about required services. Exclude optional service checks from default commands; an explicitly requested check must fail clearly when its configuration is missing.
- Test malformed input, cancellation and failure behavior when those paths change.
- Use `.test.ts` / `.test.tsx`.
- Run the narrowest applicable tier while iterating. Run `npm run gate` for the configured deterministic repository gate before reporting a complete change.
