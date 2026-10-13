# Testing rules

Lanes, commands and catalog formats are defined in the [testing guide](../../docs/testing/README.md); this file is the policy.

SQL parsing and deterministic lineage are core contracts with zero tolerated regressions. Trim duplicated setup, fixtures and helpers only when every distinct SQL/lineage scenario remains independently exercised with equivalent expected assertions. Do not eliminate distinct core scenarios, skip or weaken their assertions, narrow the parser or lineage lane, or lower coverage floors to obtain a pass. Any core regression blocks push and deployment. Change core SQL/lineage expected results only for a verified correctness fix justified by source SQL and documented semantics; record the evidence and retain the corrected regression case.

Only the parser, lineage and deterministic AI/trust lanes run in `npm test`; `npm run gate` adds the coverage floors; everything else is support. A new engine test file must be classified in `tests/tools/unit-lanes.mjs`; the gate fails otherwise.

Add a supporting check as one `it.each` or fixture row in an existing file, or as one catalog row, following [Case catalogs](../../docs/testing/README.md#case-catalogs). Electron, Playwright and headless runners stay single-path and outside the gate.

- Match the test to the behavior: Vitest for deterministic logic; Extension Development Host tests for VS Code API and activation behavior; optional integrations for real services and UI behavior.
- A fixed-response language-model fixture verifies API wiring and runtime lifecycle only. It provides no evidence about inference, prompt quality or answer correctness. Answer quality, routing and multi-hop behavior are tested only with a real model; do not add scripted conversation sequences or simulated headless runs.
- Keep tests based on the demo fixture or synthetic data. Never add customer data, credentials, raw conversations, or generated provider traces.
- Keep tests repeatable, bounded by timeouts and explicit about required services. Exclude optional service checks from default commands; an explicitly requested check must fail clearly when its configuration is missing.
- Test malformed input, cancellation and failure behavior when those paths change.
- Use `.test.ts` / `.test.tsx`; tests of `tests/tools` use `.test.mjs`.
- Run the narrowest applicable tier while iterating. Run `npm run gate` for the configured deterministic repository gate before reporting a complete change.
