# TypeScript And Architecture

- Keep ownership at the existing layer: `src/engine/` owns database-independent models, parsing, graph traversal and analysis; `src/ai/` owns the chat runtime; `src/components/` and `src/hooks/` own webview presentation.
- `src/engine/` must not import from `src/components/` or `src/hooks/`. UI code may import engine types.
- `src/engine/shared/bridgeContract.ts` is the Zod-validated contract for extension/webview messages. Update the contract and both ends together.
- Preserve existing runtime contracts in `docs/ARCHITECTURE.md`; preserve YAML contracts in `docs/PARSE_RULES.md` and `docs/DMV_QUERIES.md`.
- Use ESM `import` and `export`. Avoid adding abstractions for one call site or behavior tied to a fixture, object name, or individual test.
- Exported APIs need TSDoc describing their behavior and constraints. Add `@param`, `@returns`, or `@throws` only when they clarify the contract.
- Keep comments concise and current. Do not add narration, history, commented-out code, or author/date markers.
- AI template schema versions change only for removal, rename, or retyping of a key. Additive keys, wording, examples and ordering do not require a bump; preserve compatibility with older overlays. Version changes require the user's instruction.
