# Contributing

This project prioritizes stability, logical accuracy, and high-performance SQL parsing.

## 1. Engineering Principles
- **Metadata Driven**: SQL extraction regexes live in
  `assets/defaultParseRules.yaml`; TypeScript owns preprocessing,
  normalization, rule execution, and dependency resolution.

## 2. Development Setup

### Prerequisites
- [Node.js](https://nodejs.org/) 22 or newer.
- [VS Code](https://code.visualstudio.com/) at a version allowed by
  `engines.vscode` in `package.json`.
- A VS Code Language Model Chat provider, such as GitHub Copilot or a compatible
  BYOK provider (for `@lineage`)

### Local Setup
1. Clone the repository and run `npm ci`.
2. Press `F5` in VS Code to launch the **Extension Development Host**.
3. Open a folder containing a `.dacpac` file or use the **Try with demo data** option in the wizard.

## 3. Testing Protocol
All changes must pass the applicable maintained checks locally before push.
GitHub does not run the test suite; its workflow is limited to repository
security checks. `npm run gate` is the complete client-side pre-push gate.

| Tier | Command | Scope |
| :--- | :--- | :--- |
| **Full local gate** | `npm run gate` | Type-checking, tool-manifest drift, the AI template schema-version gate, all three unit projects, production builds, and package checks. |
| **Unit suite** | `npm test` | Every `tests/unit/**/*.test.ts` file. |
| **Core** | `npm run test:core` | Parser and non-AI engine units (`tests/unit/parser`, `tests/unit/engine`). |
| **Agent runtime** (no model) | `npm run test:runtime` | AI-core and state-machine units (`tests/unit/ai-core`, `tests/unit/sm`), including `NavigationEngine`, result closure, and trace safety. Stubbed `vscode`, no external model. |
| **Prompt goldens** | `npm run test:prompts` | Prompt-composition golden files (`tests/unit/prompts`). |
| **Parsing** | `npm run test:parser` | DACPAC, DMV, T-SQL, and targeted SQL fixtures. Core subset. |
| **BFS** | `npm run test:bfs` | Graph construction, traversal, and analysis (`graphBuilder`, `graphAnalysis`, `graph-analysis-aw`). Core subset. |
| **Optional scripted provider** | `npm run test:scripted-provider` | Scripted selected-model/runtime check in a VS Code host. Fixture provider, no inference; not part of the gate. |

Use the narrowest maintained command that matches the change:
- Parser or parse-rule work: `npm run test:parser`
- Graph construction, traversal, or analysis: `npm run test:bfs`
- `NavigationEngine`, state machine, tools, or prompts: `npm run test:runtime`
- Prompt text or template wording: `npm run test:prompts`
- Any other unit behavior: `npm test`
- Before pushing: `npm run gate`

For one file or test name, use:

```bash
node tests/tools/run-vitest.mjs run tests/unit/path/file.test.ts
node tests/tools/run-vitest.mjs run -t "test name"
```

### Parser rule verification

There is no snapshot project or snapshot update command. Run
`npm run test:parser`, add a focused regression case, and review the resulting
dependency edges against the affected SQL. Do not treat a green parser run as
proof that output is unchanged when the changed syntax has no test case.

## 4. Coding Standards
- **TypeScript**: Strict typing is mandatory. Avoid `any` at architectural boundaries.
- **Zod**: Use Zod for all IPC and tool-call validation.
- **JSDoc**: Document exported contracts where the intent is not evident from
  types and names. Focus on architectural constraints and the "why"; avoid
  narrating implementation that is already clear from the code.
- **Logging**: Use the standard logger (`src/utils/log.ts`) with category tags (e.g., `[AI]`, `[Parse]`).

## 5. Pull Request Guidelines
1. **Bug Fixes**: Include a reproduction test case in `tests/unit/`.
2. **Features**: Ensure new features are covered by unit and/or integration tests.
3. **Documentation**: Update the relevant `.md` files in `docs/` if architecture or rules change.
4. **Consistency**: Follow existing naming conventions and architectural patterns, especially the Map & Router contract where `NavigationEngine` owns process state.

---

MIT License · [Christian Wagner](https://github.com/ChrisDevRepo/vscode_data_lineage)
