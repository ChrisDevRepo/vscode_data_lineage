# Contributing

This project prioritizes stability, logical accuracy, and high-performance SQL parsing.

## 1. Engineering Principles
- **Metadata Driven**: SQL extraction regexes live in
  `assets/defaultParseRules.yaml`; TypeScript owns preprocessing,
  normalization, rule execution, and dependency resolution.

## 2. Development Setup

### Prerequisites
- [Node.js](https://nodejs.org/) 20 or newer (`engines.node` in `package.json`).
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
Full command set and scope: the `package.json` scripts and
[`docs/EDH_TESTING.md`](docs/EDH_TESTING.md).

### Parser rule verification

There is no snapshot project or snapshot update command. Run
`npm run test:parser`, add a focused regression case, and review the resulting
dependency edges against the affected SQL. Do not treat a green parser run as
proof that output is unchanged when the changed syntax has no test case.

## 4. Coding Standards
- **TypeScript**: Strict typing is mandatory. Avoid `any` at architectural boundaries.
- **Zod**: Use Zod for all IPC and tool-call validation.
- **TSDoc**: Document exported TypeScript contracts with `/** */` where the
  intent is not evident from types and names. Focus on architectural
  constraints and the "why"; do not restate types, and do not use JSDoc
  `{Type}` braces. Plain `.mjs` scripts keep type-bearing JSDoc because that
  is the only place the type can be stated.
- **Logging**: Use the standard logger (`src/utils/log.ts`) with category tags (e.g., `[AI]`, `[Parse]`).

## 5. Dependency Overrides

Every entry in the `overrides` block of `package.json` is deliberate. Record why a
new one exists and when it can be dropped, so a later maintainer can retire it
rather than inherit it.

| Entry | Purpose | Removable when |
| --- | --- | --- |
| `langsmith` | Redirects LangChain's transitive dependency to the empty shell in `stubs/langsmith/` so the real client is never resolved. | Never — the stub is permanent. |
| `esbuild` | Lifts transitive copies to the patched release the build already uses. | Every dependent requests a patched range. |
| `dompurify` | `monaco-editor` pins a range with known advisories. `$dompurify` points the override at our direct dependency so the version is stated once. | `monaco-editor` ships a patched DOMPurify. |
| `serialize-javascript` | Lifts a transitive copy past a known advisory. | Dependents update. |
| `diff` | Lifts a transitive copy past a known advisory. | Dependents update. |

Vendored third-party source is registered in `THIRD_PARTY_NOTICES.md` with its
source, license, destination, and the modifications applied.

---

MIT License · [Christian Wagner](https://github.com/ChrisDevRepo/vscode_data_lineage)
