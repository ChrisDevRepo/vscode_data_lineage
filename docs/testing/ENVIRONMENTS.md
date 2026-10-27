# Test environments

What a machine needs for each test tier, and how to report one it cannot run. Commands are the same on every OS and are in the [testing guide](README.md).

| Tier | Commands | Needs |
|---|---|---|
| Deterministic | `npm ci`, `npm test`, `npm run gate`, `npm run package` | Node.js `>=22`, npm `>=10`, Git. |
| VS Code Electron | `npm run test:edh`, `npm run test:gui:host` with `npm run test:gui:smoke`, chat-UI fixture lane | A graphical display, or `xvfb-run -a` on headless Linux. |
| Live model | `npm run test:ai:smoke`, `npm run test:ai:headless`, chat-UI `live` | `AI_TEST_*` settings and access to the configured hosted or local model endpoint. |
| Database smoke | `npm run test:db:smoke` | Local SQL Server with disposable fixture data and `DB_TEST_AUTH_TYPE=sqlLogin`; set `DB_TEST_SERVER`, `DB_TEST_PORT`, `DB_TEST_DATABASE`, `DB_TEST_USER` and `DB_TEST_PASSWORD`. Azure SQL requires an explicitly selected manual profile when available. |
| AI trace capture | Headless, native chat UI and provider API smoke | `LANGFUSE_*` settings and access to that endpoint. Review correlates verbose NDJSON, debug log, actual Langfuse trace/span data and applicable exploration state; a recorded no-hop turn needs no state-machine dump. All runs keep local captures and export Langfuse traces/spans; file attachments upload only with `--attach` or in baseline mode (`--baseline --branch NAME`, native `AI_TEST_BASELINE=1` with `AI_TEST_BRANCH`; a separate explicit step per branch, default off). Generated comparisons/reviews stay local only; baseline helpers can hydrate uploaded evidence. Exported data can contain SQL and model/tool content. |

Settings come from the process environment or an untracked local environment file copied from [`.env.example`](../../.env.example). A non-empty process value wins. On tested Node24.19 behind an HTTP proxy, set `NODE_USE_ENV_PROXY=1` before launching the test process so fetch-based trace exports use it; setting it later through `.env` is too late. Keep credentials in that file, not command arguments. Keep the external test profile's provider, model, and reasoning effort. That profile is separate from the coding agent reviewing the repository.

Autonomous database checks use a local SQL Server installation; do not select a saved Azure profile or wait for cloud authentication. Keep local overrides in the child test process and TLS verification enabled. For a separately selected manual Azure SQL check, `DB_TEST_AUTH_TYPE=entraId` can use an existing token or signed-in Azure CLI; the runner never starts interactive login.

A supplied `DB_TEST_TOKEN` takes precedence. If `DB_TEST_CLIENT_ID` is explicitly set, the runner instead requires `DB_TEST_TENANT_ID`, `DB_TEST_USER` and `DB_TEST_PASSWORD` for the existing noninteractive test-account path. Invalid explicit client configuration fails rather than silently selecting another identity. Without either, it uses native Azure CLI, the Windows CLI launcher on Windows, or the Windows launcher discovered from WSL when native CLI is absent. For a nonstandard installation, `DB_TEST_AZURE_CLI_COMMAND` is a JSON array of executable and launcher arguments (for example `["az"]`); token-request arguments are appended and execution uses no shell. Missing CLI, expired cached sign-in or unavailable credentials fail before querying. The runner does not parse token-cache files, save tokens or perform interactive account setup.

## Coverage limits

Automated harnesses do not establish interactive F5 debugging, visual UX quality, Microsoft Entra ID sign-in through the account UI, the VS Code account's own chat-model integration, access to a particular private-network database, Windows/macOS-specific behavior or representative performance. Entra smoke verifies unattended token acquisition from the configured cached identity and database access; interactive sign-in remains a separate workstation check. Review these separately on the intended workstation. Never copy customer database content or real conversations onto a shared or hosted test machine.

## Display note

Inspect installed VS Code and `.vscode-test` caches first and reuse a complete compatible host. The runner otherwise downloads its configured VS Code build; Linux also needs Chromium runtime libraries. For baseline/candidate comparisons, verify matching actual host versions in launcher logs. On a headless Linux host with those libraries and Xvfb installed, use `xvfb-run -a npm run test:edh`. GUI smoke also needs the explicitly started test host and loopback CDP access.

Network: npm needs `registry.npmjs.org`; the VS Code test build needs `update.code.visualstudio.com` and its redirect `vscode.download.prss.microsoft.com` (an exact-host allowlist must name both). On Ubuntu 24.04: `apt-get install -y xvfb libgtk-3-0t64 libnss3 libgbm1 libasound2t64 libxss1 libsecret-1-0 libxkbfile1 libatk-bridge2.0-0t64`. Keep the clone path short: VS Code fails with `listen EINVAL` when its profile socket path exceeds 107 characters.

A new machine is ready when `npm ci`, `npm run gate` and `xvfb-run -a npm run test:edh` exit 0. CI (`.github/workflows/gate.yml`) runs `npm ci` and `npm run gate` on Ubuntu with Node.js 22.

## Reporting

Report deterministic assertions as `PASSED` or `FAILED`; a check that could not execute is `NOT RUNNABLE` with its missing prerequisite. Report model execution separately as completed/error and content as unreviewed/SQL-supported/issue; runtime completion or matching metrics does not establish answer quality. Record the fixture and, for live checks, the provider, model and reasoning effort.
