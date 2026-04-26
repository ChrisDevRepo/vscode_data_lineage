# Contributing

This project prioritizes stability, logical accuracy, and high-performance SQL parsing.

## 1. Engineering Principles
- **Stability First**: Priority is Stability > Performance > Features.
- **Metadata Driven**: SQL parsing logic is driven by YAML metadata (`assets/defaultParseRules.yaml`), not hardcoded regexes in TypeScript.
- **Zero Regressions**: Any change to parser logic must maintain 100% compatibility with the AdventureWorks baseline.

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

| Tier | Command | Scope |
| :--- | :--- | :--- |
| **Unit** | `npm run test:unit` | Parsing, graph building, and core logic. |
| **AI** | `npm run test:unit:ai` | State machine, memory management, and tool registration. |
| **Snapshot** | `npm run test:snapshot` | Validates parsing against the AdventureWorks baseline. |
| **Integration** | `npm run test:integration` | Live SQL Server connection tests (requires `.env` setup). |
| **E2E** | `npm run test:e2e` | End-to-end flow in a headless VS Code instance. |

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
