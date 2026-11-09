# Test environments

What a machine needs for each test tier. Commands are the same on every OS and are in the [testing guide](README.md).

| Tier | Commands | Needs |
|---|---|---|
| Deterministic | `npm ci`, `npm test`, `npm run gate`, `npm run package` | Node.js 22.x ≥22.22.2, 24.x ≥24.15, or ≥26, npm `>=10`, Git. |
| VS Code Electron | `npm run test:edh` | A graphical display, or `xvfb-run -a` on headless Linux. |
| Live model | `npm run test:ai:smoke` | `AI_TEST_*` settings and access to the configured hosted or local model endpoint. |

Settings come from the process environment or an untracked local environment file copied from [`.env.example`](../../.env.example). A non-empty process value wins. Behind an HTTP proxy on Node 22.21+ or 24, set `NODE_USE_ENV_PROXY=1` before launching the test process so fetch-based provider requests use it; setting it later through `.env` is too late. Keep credentials in that file, not command arguments.

## Coverage limits

Automated harnesses do not establish interactive F5 debugging, visual UX quality, interactive Microsoft Entra ID sign-in, the VS Code account's own chat-model integration, access to a particular private-network database, Windows/macOS-specific behavior or representative performance. Never copy customer database content or real conversations onto a shared or hosted test machine.

## Display note

Inspect installed VS Code and `.vscode-test` caches first and reuse a complete compatible host. The runner otherwise downloads its configured VS Code build; Linux also needs Chromium runtime libraries. On a headless Linux host with those libraries and Xvfb installed, use `xvfb-run -a npm run test:edh`.

Network: npm needs `registry.npmjs.org`; the VS Code test build needs `update.code.visualstudio.com` and its redirect `vscode.download.prss.microsoft.com` (an exact-host allowlist must name both). On Ubuntu 24.04: `apt-get install -y xvfb libgtk-3-0t64 libnss3 libgbm1 libasound2t64 libxss1 libsecret-1-0 libxkbfile1 libatk-bridge2.0-0t64`. Keep the clone path short: VS Code fails with `listen EINVAL` when its profile socket path exceeds 107 characters.

A new machine is ready when `npm ci`, `npm run gate` and `xvfb-run -a npm run test:edh` exit 0. CI (`.github/workflows/gate.yml`) runs `npm ci` and `npm run gate` on Ubuntu with Node.js 22.
