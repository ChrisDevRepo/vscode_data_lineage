# Test environments

What a machine needs for each test tier, and how to report one it cannot run. Commands are the same on every OS and are in the [testing guide](README.md).

| Tier | Commands | Needs |
|---|---|---|
| Deterministic | `npm ci`, `npm test`, `npm run gate`, `npm run package` | Node.js `>=20`, npm `>=10`, Git. |
| VS Code Electron | `npm run test:edh`, `npm run test:gui:host` with `npm run test:gui:smoke`, chat-UI fixture lane | A graphical display, or `xvfb-run -a` on headless Linux. |
| Live model | `npm run test:ai:smoke`, `npm run test:ai:headless`, chat-UI `live` / `badge` / `column` | `AI_TEST_*` settings and access to the configured hosted or local model endpoint. |
| Database smoke | `npm run test:db:smoke` | `DB_TEST_*` credentials against disposable SQL Server/Azure SQL (`sqlLogin`, or Microsoft Entra ID `entraId` with an access token or explicitly configured noninteractive test login). |
| Trace export | `npm run test:ai:headless -- --langfuse` | `LANGFUSE_*` settings and access to that endpoint; exported data can contain SQL and model/tool content. |

Settings come from the process environment or an ignored `.env` copied from [`.env.example`](../../.env.example). Use it rather than putting credentials in command arguments.

For autonomous Entra database checks, supply `DB_TEST_TOKEN`, or set `DB_TEST_CLIENT_ID`, `DB_TEST_TENANT_ID`, `DB_TEST_USER` and `DB_TEST_PASSWORD` for a test account permitted to use noninteractive authentication. The runner acquires its SQL token in memory and never starts interactive sign-in. An existing token takes precedence.

## Coverage limits

Automated harnesses do not establish interactive F5 debugging, visual UX quality, Microsoft Entra ID sign-in through the account UI, the VS Code account's own chat-model integration, access to a particular private-network database, Windows/macOS-specific behavior or representative performance. Entra token smoke verifies database access with an existing token, not interactive sign-in. Review these separately on the intended workstation. Never copy customer database content or real conversations onto a shared or hosted test machine.

## Display note

Inspect installed VS Code and `.vscode-test` caches first and reuse a complete compatible host. The runner otherwise downloads its configured VS Code build; Linux also needs Chromium runtime libraries. For baseline/candidate comparisons, verify matching actual host versions in launcher logs. On a headless Linux host with those libraries and Xvfb installed, use `xvfb-run -a npm run test:edh`. GUI smoke also needs the explicitly started test host and loopback CDP access.

Network: npm needs `registry.npmjs.org`; the VS Code test build needs `update.code.visualstudio.com` and its redirect `vscode.download.prss.microsoft.com` (an exact-host allowlist must name both). On Ubuntu 24.04: `apt-get install -y xvfb libgtk-3-0t64 libnss3 libgbm1 libasound2t64 libxss1 libsecret-1-0 libxkbfile1 libatk-bridge2.0-0t64`. Keep the clone path short: VS Code fails with `listen EINVAL` when its profile socket path exceeds 107 characters.

A new machine is ready when `npm ci`, `npm run gate` and `xvfb-run -a npm run test:edh` exit 0. CI (`.github/workflows/gate.yml`) runs `npm ci` and `npm run gate` on Ubuntu with Node.js 20.

## Reporting

Report each tier as `PASSED`, `FAILED` or `NOT RUNNABLE`. A check that did not execute because a prerequisite, credential or display is missing is `NOT RUNNABLE` with that prerequisite named. Record the fixture and, for live checks, the provider, model and reasoning effort.
