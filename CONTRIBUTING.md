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
| **Unit** | `npm run test:unit` | All `tests/unit/*.test.ts` — parser, graph, baseline, NavigationEngine + cascade + bipartite + supplement, boundary guards. |
| **Parsing** | `npm run test:parser` | SQL parser edge cases + 55 real-world SQL fixtures. |
| **Graph / BFS** | `npm run test:graph` | Graph construction, BFS, analysis algorithms. |
| **Baseline** | `npm run test:baseline` | Parser TSV + graph-analysis JSON regression net. |
| **Snapshot** | `npm run test:snapshot` | Parser baseline only (refresh: `:update`). |
| **Hooks** | `npm run test:hooks` | React hooks (vitest jsdom). |

AI behaviour beyond pure-function surface (prompt content, classification semantics, narrative quality) is verified through UAT baseline captures (`tmp/baseline/`), not unit tests.

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
4. **Consistency**: Follow existing naming conventions and architectural patterns (e.g., Orchestrator-Worker).

---

MIT License · [Christian Wagner](https://github.com/ChrisDevRepo/vscode_data_lineage)
