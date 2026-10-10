# Test Environments

What a machine needs to run each test tier, independent of where it runs: a
developer workstation, a container, a hosted CI runner or a cloud agent
sandbox. Host-specific setup is in the last section.

## Requirements By Tier

| Tier | Commands | Needs |
|---|---|---|
| Deterministic | `npm ci`, `npm run typecheck`, `npm run build`, `npm test`, `npm run gate`, `npm run package` | Git, Node.js `>=20`, npm `>=10`, npm registry access. No display, database, model provider or credentials. |
| VS Code Electron | `npm run test:edh`, `npm run test:mcp:live`, chat-UI fixture lane, `npm run test:gui:host` + `npm run test:gui:smoke` | Deterministic tier, plus a display (desktop session or virtual display), Electron runtime libraries, and download access to the configured VS Code test build (`stable` for EDH, `1.140.0` for chat UI). |
| Live model | `npm run test:ai:smoke`, `npm run test:ai:headless`, chat-UI `live`/`badge` lanes | `AI_TEST_*` settings and network access to that provider. `badge` also needs a recorded successful live trace under `tmp/lm-trace/`. |
| Database | `npm run test:db:smoke` | `DB_TEST_*` SQL-login settings and network access to a disposable or demo database that accepts that login (SQL Server, Azure SQL, or Synapse Dedicated SQL Pool). |
| Tracing export | `npm run test:ai:headless -- --langfuse` | `LANGFUSE_*` settings and network access to that Langfuse host. |

Settings come from an ignored `.env` (template: [`.env.example`](../../.env.example))
or from process environment variables, so a host can inject them as secrets.

Not covered by any automated tier, and done on a developer workstation:
interactive F5 debugging and visual UX review, Microsoft Entra ID sign-in,
mssql-extension connection profiles, the VS Code account's own chat models,
private-network databases, Windows/macOS-specific desktop behavior, and
representative performance timings.
Never copy customer database content or real conversations onto a shared or hosted machine.

## Network Hosts

| Purpose | Hosts |
|---|---|
| npm packages | `registry.npmjs.org` |
| VS Code test build (`@vscode/test-electron`) | `update.code.visualstudio.com`, `vscode.download.prss.microsoft.com` (download redirect target) |
| OS packages (Ubuntu) | `archive.ubuntu.com`, `security.ubuntu.com` |
| Optional VS Code install via apt | `packages.microsoft.com` |

Allowlists that match exact hosts must name the VS Code hosts individually; a
`visualstudio.com` or `microsoft.com` entry without a wildcard does not cover them.
If downloading through `@vscode/test-electron` is restricted or times out, the test build
archive can be downloaded directly or linked from a system installation into
`.vscode-test/vscode-<platform>-<arch>-<version>/` stamped with an empty `is-complete` file.

## Platform Setup & Graphical Sessions

### Windows & macOS (Desktop Sessions)
- **Windows**: Run integration lanes directly in PowerShell or cmd (`npm run test:edh`, `npm run test:tools`). No virtual display wrapper is required. In WSL2 without a GUI server, treat as headless Linux below.
- **macOS**: Run integration lanes directly in Terminal (`npm run test:edh`, `npm run test:tools`). No virtual display wrapper is required.

### Linux (Desktop Sessions vs Headless/CI)
- **Desktop session** (GNOME, KDE, X11, Wayland): Run directly (`npm run test:edh`).
- **Headless / Container / CI / WSL**:
  - Install a virtual display (`xvfb`) and Electron's runtime dependencies (e.g. on Ubuntu/Debian: `apt-get install -y xvfb libgtk-3-0t64 libnss3 libgbm1 libasound2t64 libxss1 libsecret-1-0 libxkbfile1 libatk-bridge2.0-0t64`).
  - Prefix every Electron, VS Code test, and Playwright command with `xvfb-run -a` (e.g., `xvfb-run -a npm run test:edh`).
  - Keep the clone path short: VS Code places its profile socket under the test profile directory, and fails with `listen EINVAL` when that socket path exceeds 107 characters.

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

### Hosted cloud agent environment

Inspect the current image for Git, Node.js, npm, a display and Electron libraries;
hosted images and network policies vary between sessions.

Configure the host environment:

1. **Network access**: allow the package registries and the VS Code download
   hosts listed above, plus the provider/database hosts for optional tiers.
   Respect the host's enforced policy; repository code cannot change it.
2. **Setup script** for an Ubuntu 24.04 image:

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
Repository runners read environment variables and `.env`; they do not fetch Key
Vault secrets. Configure secret injection in the host environment when needed.
After changing host setup, verify the new session with the commands above.
