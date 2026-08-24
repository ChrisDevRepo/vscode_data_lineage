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
security checks. `npm run gate` is the complete client-side pre-push gate —
run it before opening a PR. Full command set and scope: the `package.json`
scripts and [`docs/EDH_TESTING.md`](docs/EDH_TESTING.md).

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

## 5. Dependency Overrides

Every entry in the `overrides` block of `package.json` is deliberate. Record why a
new one exists and when it can be dropped, so a later maintainer can retire it
rather than inherit it.

| Entry | Purpose | Removable when |
| --- | --- | --- |
| `langsmith` | Redirects the package to the empty shell in `stubs/langsmith/`. One of the four LangSmith containment layers. | Never — containment is permanent. |
| `esbuild` | Lifts transitive copies to the patched release the build already uses. | Every dependent requests a patched range. |
| `dompurify` | `monaco-editor` pins a range with known advisories. `$dompurify` points the override at our direct dependency so the version is stated once. | `monaco-editor` ships a patched DOMPurify. |
| `serialize-javascript` | Lifts a transitive copy past a known advisory. | Dependents update. |
| `diff` | Lifts a transitive copy past a known advisory. | Dependents update. |

Vendored third-party source is registered in `THIRD_PARTY_NOTICES.md` with its
source, license, destination, and the modifications applied.

## 6. Pull Request Guidelines
1. **Bug Fixes**: Include a reproduction test case in `tests/unit/`.
2. **Features**: Ensure new features are covered by unit and/or integration tests.
3. **Documentation**: Update the relevant `.md` files in `docs/` if architecture or rules change.
4. **Consistency**: Follow existing naming conventions and architectural patterns, especially the Map & Router contract where `NavigationEngine` owns process state.

---

MIT License · [Christian Wagner](https://github.com/ChrisDevRepo/vscode_data_lineage)
