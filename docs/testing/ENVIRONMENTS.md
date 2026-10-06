# Test Environments

What a machine needs to run each test tier, independent of where it runs: a
developer workstation, a container, a hosted CI runner or a cloud agent
sandbox. Host-specific setup is in the last section.

## Requirements By Tier

| Tier | Commands | Needs |
|---|---|---|
| Deterministic | `npm ci`, `npm run typecheck`, `npm run build`, `npm test`, `npm run gate`, `npm run package` | Git, Node.js `>=20`, npm `>=10`, npm registry access. No display, database, model provider or credentials. |
| VS Code Electron | `npm run test:edh`, chat-UI fixture lane, `npm run test:gui:host` + `npm run test:gui:smoke` | Deterministic tier, plus a display (desktop session or virtual display), Electron runtime libraries, and download access to the pinned VS Code test build. |
| Live model | `npm run test:ai:smoke`, `npm run test:ai:headless`, chat-UI `live`/`badge` lanes | `AI_TEST_*` settings and network access to that provider. `badge` also needs a recorded successful live trace under `tmp/lm-trace/`. |
| Database | `npm run test:db:smoke` | `DB_TEST_*` settings and network access to a disposable or demo SQL Server/Azure SQL database. |
| Tracing export | `npm run test:ai:headless -- --langfuse` | `LANGFUSE_*` settings and network access to that Langfuse host. |

Settings come from an ignored `.env` (template: [`.env.example`](../../.env.example))
or from process environment variables, so a host can inject them as secrets.

Not covered by any automated tier, and done on a developer workstation:
interactive F5 debugging and visual UX review, Microsoft Entra ID sign-in and
mssql-extension connection profiles, the VS Code account's own chat models,
private-network databases, Windows/macOS-specific behavior and representative
performance timings. Never copy customer database content or real
conversations onto a shared or hosted machine.

## Network Hosts

| Purpose | Hosts |
|---|---|
| npm packages | `registry.npmjs.org` |
| VS Code test build (`@vscode/test-electron`) | `update.code.visualstudio.com`, `vscode.download.prss.microsoft.com` (download redirect target) |
| OS packages (Ubuntu) | `archive.ubuntu.com`, `security.ubuntu.com` |
| Optional VS Code install via apt | `packages.microsoft.com` |

Allowlists that match exact hosts must name the VS Code hosts individually; a
`visualstudio.com` or `microsoft.com` entry without a wildcard does not cover them.

## Linux Without A Desktop Session

- Install a virtual display and Electron's runtime libraries. On Ubuntu 24.04:

  ```sh
  apt-get install -y xvfb libgtk-3-0t64 libnss3 libgbm1 libasound2t64 libxss1 \
    libsecret-1-0 libxkbfile1 libatk-bridge2.0-0t64
  ```

- Prefix every Electron and Playwright command with `xvfb-run -a`, for example
  `xvfb-run -a npm run test:edh`.
- Keep the clone path short. VS Code places its profile socket under the test
  profile directory, and fails with `listen EINVAL` when that socket path
  exceeds 107 characters.

## Verify A New Machine

Run from the repository root:

```sh
npm ci
npm run gate
npm run test:edh                                          # desktop session
xvfb-run -a npm run test:edh                              # Linux without a desktop
xvfb-run -a npx vscode-test --config .vscode-test.chat-ui.mjs
```

The machine is ready when the gate reports all steps green and every Electron
lane reports `passing` with exit code 0. Optional tiers are verified by their
own commands once their settings are present.

## Host-Specific Setup

### Claude Code cloud environment

Verified on the Anthropic-hosted image (Ubuntu 24.04 x86_64, root, Node.js 22,
npm 10). The image already contains Git, Node.js, npm and `xvfb`.

Environment settings (cloud environment menu → **Edit**):

1. **Network access**: **Full**, or **Custom** keeping the default package
   registries and adding `update.code.visualstudio.com` and
   `vscode.download.prss.microsoft.com`. The default **Trusted** list does not
   name these hosts, so the VS Code test build download can be refused.
2. **Setup script** (provisions the VM image; keep it OS-level so it stays
   under the roughly five-minute caching limit):

   ```bash
   #!/bin/bash
   set -e
   export DEBIAN_FRONTEND=noninteractive
   apt-get update
   apt-get install -y xvfb libgtk-3-0t64 libnss3 libgbm1 libasound2t64 libxss1 \
     libsecret-1-0 libxkbfile1 libatk-bridge2.0-0t64
   ```

3. **Environment variables**: add only the `AI_TEST_*`, `DB_TEST_*` or
   `LANGFUSE_*` values for the optional tiers that environment should run. Use
   disposable or demo databases and test-only provider keys.
4. **Secrets from Azure Key Vault** (optional): instead of storing a provider
   key in `.env` or in the environment variables, set `KV_NAME` to the vault
   name and keep only non-secret settings such as `AI_TEST_PROVIDER`,
   `AI_TEST_ENDPOINT` and `AI_TEST_MODEL` as variables. The session's egress
   proxy injects the vault access credential, so the session holds no token
   or key at rest. An empty secret setting such as `AI_TEST_API_KEY` is read
   from the vault into the environment of the one command that needs it;
   never write it to `.env` or any other file, shell history or output. If
   the vault lookup fails or returns nothing, report the tier as not runnable.

Rebuilding: a changed setup script or network setting rebuilds the cached image
for new sessions; the cache also expires after about seven days. A session that
is already running keeps its VM, so start a new session after changing the
environment. The repository's dependencies are not part of the image: run
`npm ci` in each new session, then the commands in
[Verify A New Machine](#verify-a-new-machine). The session's VM is discarded
after inactivity, so commit and push anything worth keeping, and expect
`.vscode-test/` and `tmp/` (including recorded traces) to start empty.
