# Testing

Test tiers, lanes and commands. Machine needs are in [Test environments](ENVIRONMENTS.md); VS Code host lanes in [EDH testing](../EDH_TESTING.md).

## Default checks

These need no database, model provider or display. Run `npm run gate` before a push.

| Command | What it runs |
|---|---|
| `npm test` | Maintained unit suites (Vitest) |
| `npm run test:core` | Parser, engine and webview |
| `npm run test:parser`, `npm run test:bfs` | Parser only; graph traversal only |
| `npm run test:runtime` | AI runtime contracts: tool registry and dispatch, gates, retries, templates, with a fixed-response model |
| `npm run typecheck`, `npm run typecheck:tests` | TypeScript (there is no lint script) |
| `npm run gate` | All of the above, plus coverage floors, layering, build, bundle and package checks |

A `SKIP` in the gate summary is unverified: the template schema-version step compares against the newest `v*` tag or `origin/main` and skips locally when neither exists; with `CI` set it fails instead. Failed step logs go to `test-results/gate/`.

Deterministic tests verify parser, graph and runtime contracts. A structurally valid AI result does not establish complete SQL lineage, and a fixed-response model proves API wiring, not answer quality. Check AI answers against the loaded SQL and graph yourself.

## Build and install a VSIX

```sh
npm ci
npm run package
```

This creates `data-lineage-viz-<version>.vsix` in the repository root without publishing it. In VS Code choose **Extensions → … → Install from VSIX…**, or run `code --install-extension ./data-lineage-viz-<version>.vsix`. Try it in a separate VS Code profile first.

## Optional checks

Opt-in; they stay outside `npm test` and the gate.

| Check | Setup and command | Purpose and limit |
|---|---|---|
| Electron host | `npm run test:edh` | Extension in a real VS Code host; see [EDH testing](../EDH_TESTING.md) |
| Playwright UI smoke | `npm run build`, `npm run test:gui:host`, then `npm run test:gui:smoke` in another terminal | Opens the demo in an isolated VS Code host and confirms the graph renders |
| Database smoke | `DB_TEST_*` settings, `npm run test:db:smoke` | SQL-login connection and metadata import against a disposable or demo database |
| Real-model smoke | `AI_TEST_*` settings, `npm run test:ai:smoke` | One live `@lineage` turn against the demo DACPAC; may incur provider cost; checks completion, not correctness |
| Headless AI | `npm run test:ai:headless -- --prompt "..."` | Runs the production runtime in Node against `assets/demo.dacpac` with simulated approvals; results go to ignored `test-results/headless/` |
| Large layout | `npm run test:scale` | Layout check at the 1,500-node render limit; timings are not thresholds |

## Settings for optional checks

Copy `.env.example` to `.env` (ignored by Git) and fill only the section you need; a non-empty process variable wins. Never commit credentials or print secret values. For the model checks choose one provider profile per run (`AI_TEST_PROVIDER`, `AI_TEST_ENDPOINT`, `AI_TEST_API_KEY`, `AI_TEST_MODEL`, optional `AI_TEST_REASONING_EFFORT`). These variables configure test harnesses only; the extension itself uses the VS Code chat model. Generated answers, traces and test output stay in ignored directories, and can contain database metadata, so use the demo DACPAC or synthetic data.

## Rules for tests

Test files end in `.test.ts` or `.test.tsx`. Use the demo fixture or synthetic SQL; never add customer data, credentials, raw conversations or provider traces. Cover malformed input and failure paths when they change, and keep default tests free of network and credentials.
