---
name: testing
description: Load when adding, changing, selecting, or diagnosing repository tests, including core, Electron, database, Playwright, performance, or real-model smoke checks.
---

# Testing Workflow

1. Read `docs/testing/README.md` and `docs/EDH_TESTING.md`; identify the tier that exercises the changed contract.
2. Read `.agents/rules/testing.md`. Keep deterministic tests free of network and credentials.
3. For parser changes run `npm run test:parser`; for graph/engine changes run `npm run test:bfs`; for runtime changes run `npm run test:runtime`; for webview changes run the relevant unit project or `npm run test:core`.
4. For VS Code host behavior run `npm run test:edh`. This downloads/starts the configured VS Code Electron test host and tests activation, tool registration, or participant wiring. Its fixed-response provider is not an inference test.
5. Use optional database, GUI, performance, or real-model checks only when their prerequisites and environment variables are configured. Record the provider/service and model identity, elapsed time, and whether the result is a connectivity smoke or behavior check. Never report connectivity as correctness evidence.
6. When the change is complete, run `npm run gate`; report commands and outcomes accurately. Do not claim an optional tier ran if its prerequisite was absent.

## What The Test Tiers Mean

- `npm test` and focused Vitest scripts cover deterministic parser, engine, AI contract and webview behavior.
- `npm run test:edh` runs the real VS Code/Electron host lanes. The `participant-turn` lane injects fixed responses through `vscode.lm`; it checks request lifecycle and streaming, not a model's answer.
- Optional live database and real-model checks must use the public demo DACPAC or a disposable database. They are opt-in and must not make the default test command depend on credentials, network access, or a GUI.
- Playwright UI checks should attach to an explicitly started Extension Development Host through CDP and use accessible roles/labels. Keep rendering/interaction assertions separate from timing measurements.
- Performance checks should state host, dataset size, warm/cold state and repetitions. Report distributions (at least median and p95); do not make universal latency claims from one device.
