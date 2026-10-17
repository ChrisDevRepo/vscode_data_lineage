---
name: testing
description: Select the smallest deterministic check for a code change. Use when adding, changing, selecting, or diagnosing parser, lineage, runtime, webview, or tooling tests.
---

# Testing workflow

Run commands from the repository root. Apply the [testing rules](../../rules/testing.md). Lanes, catalogs, host commands, and live-run cost are in the [testing guide](../../../docs/testing/README.md).

1. Follow the testing rule for the narrowest deterministic lane, using the lane table in the testing guide. When that contract already has a catalog, add a row as described in [Case catalogs](../../../docs/testing/README.md#case-catalogs).
2. For a host or rendered-chat check, run the one command in [VS Code host checks](../../../docs/testing/README.md#vs-code-host-checks).
3. Run a live model case only by [When a live run is worth its cost](../../../docs/testing/README.md#when-a-live-run-is-worth-its-cost). Confirm prerequisites in [Test environments](../../../docs/testing/ENVIRONMENTS.md).
4. Report `PASSED`, `FAILED`, or `NOT RUNNABLE` as [Test environments](../../../docs/testing/ENVIRONMENTS.md#reporting) describes, including the deterministic result.
5. Finish with the gate required by the testing rules. For a prompt or model-visible behavior change, follow [baseline review](../../../docs/testing/README.md#before-deployment-baseline-review) and record whether the live result shows connectivity or behavior.
