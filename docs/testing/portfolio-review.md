# Test portfolio review

The public suite should give a contributor fast product-regression confidence and reusable optional tools. Question banks, answer scoring, trace-replay datasets, provider comparisons, exhaustive acceptance matrices and benchmark history remain local. No test CI or scheduler was added.

## Dispositions

[The inventory](test-inventory.tsv) lists every public test file inspected, its production or harness dependencies, source size, assertion sites and disposition. It also records moved cases and retired checks with retained coverage. Local-only suites are not listed. Assertion-site counts and sizes are a point-in-time inspection aid, not test counts or quality scores, and are not kept current.

| Decision | Applied change and rationale |
|---|---|
| Publish | Cancellation, provider compatibility, scope admission and tool-error envelopes moved into the public runtime suite. These protect deterministic product behavior without requiring inference. |
| Share | Transport, session setup, runtime invocation, logging, trace parsing and Langfuse export now have one public implementation. Local campaign imports use forwarding modules; question registries, lane profiles and score summaries remain local. Scripted-model and tool-handler fixtures are shared too. |
| Move local | Six editorial output-template assertions moved out of the config-parser suite. Public YAML parsing, required fields and schema compatibility remain. |
| Move optional | The 1,500-node layout assertion moved to `test:scale`. Large-model admission, render boundaries, search and traversal remain default. |
| Remove | Prompt-hash refresh, test-name vocabulary policing and export-name/regex-text completeness gates were retired. They did not establish behavior or model quality. Executable parser fixture assertions, template compatibility and coverage floors remain. |
| Retain | Specialized local regressions remain when there is no demonstrated equivalent assertion. Large file counts alone are not sufficient evidence to delete them. Observation/benchmark tools remain optional rather than becoming regression gates. |

The review is file-level source/dependency triage plus focused verification of changed contracts. It does not claim that all optional environments ran, that every local assertion is necessary, or that a text scan proves behavior. No unique production regression was deleted to meet a size quota.

## Size and execution evidence

Reference environment: the maintainer's macOS development machine, Node 22.23.1 / npm 10.9.8, ARM64, warm dependencies. These are observations, not portable performance guarantees.

| Measurement | Before | After |
|---|---|---|
| Public test sources and fixtures | About 1.30 MB | About 1.49 MB, including reusable headless/export tools |
| Default unit suite | 112 files / 1,651 tests passed in 3.44 s with the large-graph file excluded | Public-only checkout: 119 files / 1,705 tests passed in 3.73 s |
| Default timeout/stack | Five-minute timeout and enlarged stacks for every unit worker | Ten-second default; scale-only stack/timeout override |
| Gate steps | 17 | 14, preserving coverage, packaging, manifest, layering and LangSmith protections |
| Optional ceiling layout | Included in default suite | One isolated scale test passed in 20.92 s |
| React lifecycle warnings | `act()` warnings in keyboard/focus/tree tests | Awaited renders/interactions; no `act()` warnings in the measured default run |

Concurrent product work can change assertion counts; the commands and their outcomes are the evidence. The baseline excluded the entire large-graph file, while the new default retains its inexpensive cases, so the durations are not a strict before/after speed comparison.

A public-only scratch checkout, with no `internal-tests` or `.env`, installed 686 packages using `npm ci --offline`, including the LangSmith stub repair. Its full gate passed 14/14 checks, and both optional runner help commands compiled and ran. The normal repository gate also passed 14/14. Existing core coverage floors passed. All four Electron lanes passed (16 host tests), and the isolated VS Code/Playwright demo-render smoke passed. The local shared-port/trace/export suites passed 105 tests; the local integration/harness TypeScript configuration compiled successfully.

The headless runner was exercised offline against the public demo with synthetic HTTP responses and ordered follow-ups. Tests also cover malformed structured responses, cancellation without a request, missing configuration, literal API-key redaction, malformed traces and Langfuse partial/error responses. Live database, paid-model and Langfuse service calls were not used as correctness evidence.

## Maintenance defaults

Use the smallest tier that exercises the changed contract. Review a warm default run above 30 seconds on this reference machine; do not assert wall-clock speed in unit tests. Merge repeated setup and genuinely equivalent cases, preserving distinct failures. Add optional tooling only when it can run from a public clone without local corpora. Keep all test sources and output out of the VSIX. The testing guide is the single command/setup reference; there is no new recurring audit process.
