# Test Environments

What a machine needs for each test tier. Commands are in the [testing guide](README.md).

| Tier | Commands | Needs |
|---|---|---|
| Deterministic | `npm ci`, `npm run build`, `npm test`, `npm run gate`, `npm run package` | Git, Node.js `>=20`, npm `>=10`, npm registry access. No display, database, model provider or credentials. |
| VS Code Electron | `npm run test:edh`, `npm run test:gui:host` with `npm run test:gui:smoke` | Deterministic tier, plus a display (desktop session or virtual display), Electron runtime libraries and download access to the VS Code test build. |
| Live model | `npm run test:ai:smoke`, `npm run test:ai:headless` | `AI_TEST_*` settings and network access to that provider. |
| Database | `npm run test:db:smoke` | `DB_TEST_*` settings and network access to a disposable or demo database. |

Settings come from an ignored `.env` (template: [`.env.example`](../../.env.example)) or process environment variables.

No automated tier covers interactive F5 debugging, visual review, Microsoft Entra ID sign-in, the VS Code account's own chat models, private-network databases, or timing on representative hardware. Never copy customer database content or real conversations onto a shared machine.

## Network hosts

npm needs `registry.npmjs.org`. The VS Code test build (`@vscode/test-electron`) needs `update.code.visualstudio.com` and its download redirect `vscode.download.prss.microsoft.com`; an allowlist that matches exact hosts must name both.

## Linux without a desktop session

Install a virtual display and Electron's libraries (Ubuntu 24.04):

```sh
apt-get install -y xvfb libgtk-3-0t64 libnss3 libgbm1 libasound2t64 libxss1 \
  libsecret-1-0 libxkbfile1 libatk-bridge2.0-0t64
```

Prefix Electron and Playwright commands with `xvfb-run -a`, for example `xvfb-run -a npm run test:edh`. Keep the clone path short: VS Code fails with `listen EINVAL` when its profile socket path exceeds 107 characters.

A machine is ready when `npm run gate` is green and every Electron lane (`npm run test:edh`, under `xvfb-run -a` on headless Linux) reports `passing`. Report a tier whose prerequisites are missing as not runnable, never as passed.
