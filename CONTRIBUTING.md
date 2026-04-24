# Contributing

Bug reports are welcome. Feature requests are not being accepted — this project is maintained for personal use. You're welcome to fork and extend it under the MIT license.

## Reporting bugs

1. Check [existing issues](../../issues) to avoid duplicates.
2. Use the **Bug Report** issue template.
3. Include: VS Code version, extension version, steps to reproduce, and expected vs. actual behavior. For AI (`@lineage`) issues, also attach the relevant `Data Lineage` output-channel log.

## Submitting a fix

1. Fork the repository.
2. Create a branch: `fix/<short-description>` or `feature/<short-description>`.
3. Make your change.
4. Run the relevant tests (see [`docs/TESTING.md`](docs/TESTING.md) for tiers and triggers).
5. Run `npx tsc --noEmit` to confirm the type checker is clean.
6. Open a pull request against `main`.

## Development setup

```bash
git clone https://github.com/ChrisDevRepo/vscode_data_lineage.git
cd vscode_data_lineage
npm install
npm run build
```

Press **F5** in VS Code to launch the **Extension Development Host**.

For a deep dive into the engineering mandates, ingestion strategies, and prompt architecture, see the [Developer Guide](docs/DEVELOPER_GUIDE.md).

### Build commands

| Command | Description |
|---|---|
| `npm run build` | Full build (extension + webview) |
| `npm run build:ext` | Fast build (extension host only) |
| `npm run build:webview` | Fast build (Vite webview only) |
| `npm run watch` | Continuous watch mode (extension only) |
| `npx @vscode/vsce package` | Build a local `.vsix` (no publish) |

## Testing

**See [`docs/TESTING.md`](docs/TESTING.md)** for the full test strategy — tiers, commands, fixture policy, snapshot-baseline protocol, and DB-integration setup. Quick rule: `npm test` before every push.

## Stability-first mandate

This project prioritises correctness and auditability over feature velocity. If you're contributing a PR, please match the same posture:

- **Zero-regression parsing.** Any edit to `assets/defaultParseRules.yaml` must leave the snapshot baseline green (`npm run test:snapshot`). A lost dependency blocks the PR; a gained one needs a one-line justification in the commit message.
- **Explicit over implicit.** State machines are discriminated unions with exhaustive switches — not boolean flag piles. See `src/ai/sessionPhase.ts` for the canonical pattern.
- **Zod at the boundary.** Every untrusted payload (webview messages, AI tool results, file-based overlays) parses through a Zod schema at the edge; inner layers consume the parsed type.
- **Mechanical over prompt.** If an invariant matters to the AI, enforce it in code (tool mode, route validation, parallel-call guard) — don't add it to the prompt and hope.

## Code conventions

- **Inline documentation:** JSDoc (`/** … */`) on every exported function, class, interface, and type; one-line `//` comments for non-obvious WHYs inside function bodies. Names carry the WHAT — comments explain hidden constraints only. Multi-line comment blocks are a signal to extract a type or helper.
- **Discriminated unions over flag pileup** — the compiler narrows, future variants fail to compile everywhere.
- **Naming:** commands use the `dataLineageViz.*` prefix; settings use `dataLineageViz.*` under `contributes.configuration.properties` in `package.json`.

## Architecture pointers

| Topic | Read |
|---|---|
| High-level architecture | [`docs/TECHNICAL_ARCHITECTURE.md`](docs/TECHNICAL_ARCHITECTURE.md) |
| `@lineage` AI chat participant | [`docs/AI_ARCHITECTURE.md`](docs/AI_ARCHITECTURE.md) |
| Prompt system (builders, YAML templates) | [`docs/AI_PROMPTS.md`](docs/AI_PROMPTS.md) |
| SQL parse rules (regex + XML fallback) | [`docs/PARSE_RULES.md`](docs/PARSE_RULES.md) |
| DMV query customization | [`docs/DMV_QUERIES.md`](docs/DMV_QUERIES.md) |
| Table profiling SQL | [`docs/PROFILING_PATTERNS.md`](docs/PROFILING_PATTERNS.md) |
| End-user features | [`docs/FEATURES.md`](docs/FEATURES.md) |
| Troubleshooting | [`docs/TROUBLESHOOTING.md`](docs/TROUBLESHOOTING.md) |

## Versioning

Semantic Versioning. While in preview (`0.x.x`): MINOR = new feature, PATCH = fix. These must match at release:

- `version` in `package.json`
- Top entry in `CHANGELOG.md`
- Git tag in the format `v<version>`

Use [Keep a Changelog](https://keepachangelog.com/) sections: Added / Changed / Fixed / Removed.

## License

By contributing, you agree that your contributions will be licensed under the MIT License.
