# VS Code Extension Host Tests

Extension Development Host (EDH) tests run the extension inside the VS Code Electron host. They cover activation and public VS Code API contracts that unit tests cannot exercise. They stay outside `npm test` and the gate.

## Run

`npm run test:edh` builds the extension and webview, compiles the integration tests and runs every lane in `.vscode-test.mjs`. To run one lane, build first, then pick it (lanes share the build output and test profile, so run them one at a time):

```sh
npm run pretest:integration
npm run test:bare-environment
npm run test:tools
npx vscode-test --label kill-switch
```

On Linux without a desktop session, prefix each command with `xvfb-run -a`; see [Test Environments](testing/ENVIRONMENTS.md#linux-without-a-desktop-session). Never attach a test to your normal VS Code window, and do not rebuild `out/` while a host is running.

| Lane | What it verifies |
|---|---|
| `bare-environment` | The extension activates when optional host integrations are absent. |
| `tools` | Contributed read-only language-model tools register and respond through the VS Code API. |
| `kill-switch` | Disabling the AI feature before activation leaves the non-AI extension surface available. |

## Test safety

The default lanes need no database or credentials and use the bundled public demo fixture. Keep credentials in the ignored `.env`. Do not commit credentials, customer SQL, database archives, raw conversations, traces or generated test output. A fixed-response lane is not evidence of model quality; review live answers against the SQL yourself.
