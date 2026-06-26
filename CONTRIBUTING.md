# Contributing

This project prioritizes stability, logical accuracy, and high-performance SQL parsing.

## 1. Engineering Principles
- **Metadata Driven**: SQL parsing logic is driven by YAML metadata (`assets/defaultParseRules.yaml`), not hardcoded regexes in TypeScript.

## 2. Development Setup

### Prerequisites
- [Node.js](https://nodejs.org/) (v18+)
- [VS Code](https://code.visualstudio.com/)
- [GitHub Copilot](https://marketplace.visualstudio.com/items?itemName=GitHub.copilot) (for AI features)

### Local Setup
1. Clone the repository and run `npm install`.
2. Press `F5` in VS Code to launch the **Extension Development Host**.
3. Open a folder containing a `.dacpac` file or use the **Try with demo data** option in the wizard.

## 3. Testing Protocol
All changes must pass the full test suite before submission.

The high-priority regression net is **parsing, BFS, and baseline**. Other tests are narrower guards.

| Tier | Command | Scope |
| :--- | :--- | :--- |
| **Full gate** | `npm test` / `npm run test:unit` | `test:core` + `test:support` + `test:ui`. |
| **Core** | `npm run test:core` | Parser + BFS/orchestration. |
| **Parsing** | `npm run test:parser` | Parser edge cases, real-world SQL fixtures, parser snapshot baseline. |
| **BFS / orchestration** | `npm run test:bfs` | Graph construction, graph analysis, NavigationEngine, traversal contracts, path/present/submit guards. |
| **Support** | `npm run test:support` | Utility, policy, support-contract, and lower-criticality hook tests. |
| **UI** | `npm run test:ui` | React hooks/components tied to user-facing behavior. |
| **Baseline** | `npm run test:baseline` | Parser TSV + graph-analysis JSON regression net. |
| **Snapshot** | `npm run test:snapshot` | Parser baseline only (refresh: `:update`). |
| **Discovery audit** | `npm run test:list` | Lists Vitest-discovered tier membership for `tests/unit/**/*.test.ts(x)`. |

AI behaviour beyond pure-function surface (prompt content, classification semantics, narrative quality) is verified through UAT baseline captures (`tmp/baseline/`), not unit tests.

`npm run test:graph` and `npm run test:hooks` remain compatibility aliases for `test:bfs` and `test:ui`.

Test discovery is now tiered and lean:
- Parser/BFS Node suites run through Vitest node projects with small tier runner files.
- New top-level `tests/unit/*.test.ts` files fall into the support tier by default unless promoted into the parser or BFS runner.
- React hook/component tests are discovered from the include patterns in `vitest.config.ts`.

Use the narrowest tier that matches the change:
- Parser or parse-rule work: `npm run test:parser` and `npm run test:snapshot`
- BFS, graph contracts, `NavigationEngine`, or orchestration work: `npm run test:bfs`
- UI-only work: `npm run test:ui`
- Broader utility/policy work: `npm run test:support`
- Pre-merge code-path gate: `npx tsc --noEmit`, `npm run build`, `npm test`

Coverage remains informational only until the Vitest include scope is broadened beyond `src/engine/**` and `src/hooks/**`.

Current tier timing baselines are documented in `tests/README.md`. Re-measure them whenever tier membership changes materially.

### Parser Snapshots
If you modify `assets/defaultParseRules.yaml`, you must update the baseline:
1. Run `npm run test:snapshot` to view the diff.
2. If the diff is intentional, run `npm run test:snapshot:update`.
3. Commit the updated `tests/fixtures/aw-baseline.tsv`.

## 4. Coding Standards
- **TypeScript**: Strict typing is mandatory. Avoid `any` at architectural boundaries.
- **Zod**: Use Zod for all IPC and tool-call validation.
- **JSDoc**: Provide professional, factual JSDoc for all exported symbols. Focus on the "why" and architectural intent.
- **Logging**: Use the standard logger (`src/utils/log.ts`) with category tags (e.g., `[AI]`, `[Parse]`).

## 5. Pull Request Guidelines
1. **Bug Fixes**: Include a reproduction test case in `tests/unit/`.
2. **Features**: Ensure new features are covered by unit and/or integration tests.
3. **Documentation**: Update the relevant `.md` files in `docs/` if architecture or rules change.
4. **Consistency**: Follow existing naming conventions and architectural patterns, especially the Map & Router contract where `NavigationEngine` owns process state.

---

MIT License · [Christian Wagner](https://github.com/ChrisDevRepo/vscode_data_lineage)
