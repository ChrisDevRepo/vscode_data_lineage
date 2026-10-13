---
name: testing
description: Select test tiers and verify repository changes. Use when adding, changing, selecting or diagnosing SQL parser, lineage, runtime, webview or tooling tests, including optional Electron, database, UI, performance and live-model checks.
---

# Testing workflow

Use the changed contract and any failing tests as inputs. Run commands from the repository root. Apply the [testing rules](../../rules/testing.md); lanes, commands, catalog formats and settings are in the [testing guide](../../../docs/testing/README.md).

1. Pick the narrowest lane for the change: `npm run test:parser` or `npm run test:lineage` for parser and lineage (zero-regression); `npm run test:runtime` for schema, redaction, cancellation, template structure and `scripted` catalog rows; `npm run test:support` with the affected path for webview, database connection and AI routing. Add rows as described in [Case catalogs](../../../docs/testing/README.md#case-catalogs).
2. For host and rendered-chat checks, read [VS Code host checks](../../../docs/testing/README.md#vs-code-host-checks) and run the documented command. Do not add Electron, Playwright, or headless cases.
3. For optional database, GUI and live-model checks, confirm the prerequisites in [Test environments](../../../docs/testing/ENVIRONMENTS.md). Record `@lineage /trace` duration and call count for the selected model and configuration; a fixed duration is not a guarantee.
4. Report each check as `PASSED`, `FAILED` or `NOT RUNNABLE` with the missing prerequisite, as described in [Test environments](../../../docs/testing/ENVIRONMENTS.md#reporting). For a live check, name the runner (`test:ai:smoke`, chat-UI `live` / `badge` / `column`, or `test:ai:headless`), the `AI_TEST_PROVIDER` profile, the exact model and the reasoning effort.
5. Run `npm run gate` before reporting a complete change. A green gate does not grade model answers. For a prompt or model change, follow [baseline review](../../../docs/testing/README.md#before-deployment-baseline-review) and record whether the result shows connectivity or behavior.
