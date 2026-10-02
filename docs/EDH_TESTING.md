# VS Code Extension Host Tests

Extension Development Host (EDH) tests run the extension inside the VS Code Electron host. They cover host activation and public VS Code API contracts that unit tests cannot exercise.

## Run

```sh
npm run pretest:integration
npm run test:bare-environment
npm run test:tools
npm run test:participant-turn
npx vscode-test --label kill-switch
```

`npm run test:edh` builds the extension and webview, compiles the integration tests, and runs all configured lanes. Run one lane at a time because lanes share the build output and VS Code test profile.

| Lane | What it verifies |
|---|---|
| `bare-environment` | The extension activates when optional host integrations are absent. |
| `tools` | Contributed read-only language-model tools register and respond through the VS Code API. |
| `participant-turn` | The `@lineage` participant handles an empty-data case and completes a turn through the public chat API. A fixture provider supplies fixed responses to exercise API wiring and turn lifecycle. |
| `kill-switch` | Disabling the AI feature before activation leaves the non-AI extension surface available. |

The fixture provider does not perform inference and does not test answer correctness, prompt quality, or provider behavior. Use an explicitly configured real-model smoke check for those purposes; the public demo DACPAC is the appropriate data source.

## Electron And UI Automation

EDH tests already launch the extension in VS Code Electron. For UI automation, start one EDH instance with remote debugging enabled and connect Playwright to its CDP endpoint. Keep UI assertions based on visible roles, labels and outcomes. See [Testing](testing/README.md) for optional test configuration and the boundary between smoke and performance checks.

Do not run two EDH hosts at once or rebuild `out/` while a host is running. The active host may have loaded files from that directory.

## Test Safety

The default EDH lanes require no database or model-provider credentials. Data-bearing lanes use the bundled public demo fixture. The optional `test:ai:smoke` lane requires an explicitly configured provider. Keep credentials in the ignored `.env` file. Do not commit credentials, customer SQL, database archives, raw conversations, traces, or generated test output.
