# VS Code Extension Host Tests

Extension Development Host (EDH) tests run the extension inside the VS Code Electron host. They cover activation and public VS Code API contracts that unit tests cannot exercise. They stay outside `npm test` and the gate.

## Run

`npm run test:edh` builds the extension and webview, compiles the integration tests and runs every lane in `.vscode-test.mjs`. To run one lane, build first, then pick it (lanes share the build output and test profile, so run them one at a time):

```sh
npm run pretest:integration
npm run test:bare-environment
npm run test:tools
npm run test:participant-turn
npx vscode-test --label kill-switch
```

On Linux without a desktop session, prefix each command with `xvfb-run -a`; see [Test Environments](testing/ENVIRONMENTS.md#linux-without-a-desktop-session). Never attach a test to your normal VS Code window, and do not rebuild `out/` while a host is running.

| Lane | What it verifies |
|---|---|
| `bare-environment` | The extension activates when optional host integrations are absent. |
| `tools` | Contributed read-only language-model tools register and respond through the VS Code API. |
| `participant-turn` | The `@lineage` participant completes a turn through the public chat API. A fixture provider supplies fixed responses, so this checks API wiring and turn lifecycle, not inference. |
| `kill-switch` | Disabling the AI feature before activation leaves the non-AI extension surface available. |

## Native chat UI lanes (optional)

`tests/integration/chat-ui.test.ts` drives the real VS Code chat input with Playwright over CDP, in an isolated profile on loopback:

```sh
npm run pretest:integration
npx vscode-test --config .vscode-test.chat-ui.mjs                    # fixture lane
npx vscode-test --config .vscode-test.chat-ui.mjs --label live       # needs AI_TEST_* settings
```

The fixture lane checks the plan buttons (**Approve & Proceed**, **Change scope**, **Cancel**) and typed replies with scripted responses; it proves request lifecycle, not answer quality. The `live`, `badge` and `column` labels use your own provider from `.env` and the public demo DACPAC, and fail rather than skip when configuration is missing. Screenshots and rendered text go to ignored `tmp/chat-ui/`. Use distinct `PLAYWRIGHT_CDP_PORT` values for simultaneous hosts.

## Test safety

The default lanes need no database or credentials and use the bundled public demo fixture. Keep credentials in the ignored `.env`. Do not commit credentials, customer SQL, database archives, raw conversations, traces or generated test output. A fixed-response lane is not evidence of model quality; review live answers against the SQL yourself.
