# Test inventory

“All tests” includes every lane below. `npm test` and the gate cover deterministic contracts; they do not run the optional database, Electron, Playwright or provider-backed lanes. Selectable parser/lineage/runtime commands overlap the aggregate and are not additional cases. Run one provider runner and one VS Code host at a time.

## Executable lanes

| Lane | Inventory | Command |
|---|---|---|
| Core/runtime | Parser, lineage and AI/trust contracts; canonical partition in `tests/tools/unit-lanes.mjs` | `npm test`, then `npm run gate` |
| Support | Remaining unit/tooling/webview/database adapter contracts | `npm run test:support` |
| Backend case catalog | `scripted` rows in `tests/cases/lineage-cases.yaml`, expanded by BB/CT modes; included in runtime | `npm run test:runtime -- tests/unit/backend/lineage-cases.test.ts` |
| Electron API | Bare environment, kill switch, public tools and participant-turn scenarios in `tests/integration/` | `npm run test:edh` |
| Native scripted UI | Seven control/lifecycle tests | `npm run pretest:integration`, then `npx vscode-test --config .vscode-test.chat-ui.mjs` |
| Native provider UI | Six approval/cancellation/scope controls | `npx vscode-test --config .vscode-test.chat-ui.mjs --label live` |
| Separate provider API smoke | One real turn through VS Code public model API; separate from native UI | `npm run test:ai:smoke` |
| Graph Playwright | `playwright-open-demo`: command palette opens demo and renders graph | `npm run test:gui:host`, then `npm run test:gui:smoke`; stop host afterward |
| Headless provider catalog | Basic demo test cases (`assets/demo.dacpac`) | `npm run test:ai:headless` |
| Layout scale | 1,500-node layout scenario | `npm run test:scale` |
| Connected database | Read-only metadata discovery/import against configured database | `npm run test:db:smoke` |

Use `xvfb-run -a` before host commands on Linux without a display. Build integration tests before selecting host labels. This checkout supplies the default and `live` chat-control cases; its badge/column selectors have no matching tests and establish no coverage. Headless and native checks exercise different transports, consent and rendering even when their questions overlap.

Approval, cancellation, follow-ups and retries can make multiple requests per identity. No provider-backed suite belongs to the deterministic gate.

## Headless questions

Public basic demo test cases live in `tests/cases/lineage-cases.yaml` with runner `headless`, using the public demo fixture (`assets/demo.dacpac`). Extended benchmark evaluation is out of scope for this repository.

| IDs | Requested behavior |
|---|---|
| headless-summary | Database summary, then hub-table follow-up |
| headless-procedure-dependencies | Procedure dependencies with scope refinement and approval |
| headless-view-chain | View upstream/downstream dependencies |

List available rows without calling a provider using `npm run test:ai:headless -- --list`. Select a row with `npm run test:ai:headless -- --case headless-summary`.

Explicit all mode executes the existing focused runner serially with separate captures and scores. Its ignored `test-results/headless/all-UUID/inventory.json` records every planned identity/turn, completed/error execution, capture gaps, comparisons and unreviewed content. A completed provider run is not a SQL review. `--all --list` remains provider-free.

A focused question uses `npm run test:ai:headless -- --dacpac assets/demo.dacpac --prompt "QUESTION"`. Preserve the exact question and fixture when comparing runs. A full-catalog run is not a retry strategy for one failing question.

## Native UI cases

The scripted suite uses the `electron-fixture-trace` catalog prompt. Its seven tests are:

1. Cancel button discards the plan; stale Approve does not start analysis.
2. Typed `no` cancels.
3. Typed `stop` cancels.
4. Typed `no stop` cancels.
5. Typed scope revision changes the proposal without clicking Change scope.
6. Typed approval starts analysis without clicking Approve.
7. A question at the plan is answered, scope changes, then approval resumes once without exposing internal instructions.

The live suite runs cases 1–6. The scripted-only case 7 and absent badge/column scenarios are not live coverage. The separate `ai-smoke` suite checks one configured-provider public demo question through the public participant/model API. Each surface's capture and rendered assertions remain distinct.
