# Public Test Suite

> The AI eval-loop uses the in-extension-host tool proxy at `tests/e2e/suite/eval/toolProxy.ts`, launched via `npm run test:eval` (`@vscode/test-electron`). See `tests/README.md` for the full test-tier overview.

The project uses a multi-layered public testing approach to ensure stability across the parsing engine, graph topology, and the VS Code integration.

## Running Tests

### 1. Pure Logic Tests (Fast)
These verify the core engine logic (parsing, graph analysis) using the public AdventureWorks test data.
```bash
npm test                                       # Core engine unit tests (Parsing, Graph, DMV)
npm run test:project                           # Project store serialization tests
npm run test:snapshot                          # Parser baseline check (31 AW procedures)
```

### 2. Infrastructure & Integrity (Pre-Package)
These verify that the extension activates correctly and that all components are bundled properly.
```bash
npm run test:sanity                            # Bundle Integrity: verifies out/extension.js loads without ReferenceErrors
npm run test:vscode                            # Functional Integration: launches headless VS Code to verify activation and commands
```

## Test Files

| File | Type | Purpose |
|------|-------|---------|
| `test/dacpacExtractor.test.ts` | Unit | Dacpac extraction, filtering, and edge integrity. |
| `test/graphBuilder.test.ts` | Unit | Graph construction, BFS trace, and directional edge filtering. |
| `test/parser-edge-cases.test.ts` | Unit | Primary regression guard for regex rule verification in `sqlBodyParser.ts`. |
| `test/bundle-sanity.js` | Sanity | Verifies the final bundled code is executable in a clean Node.js environment. |
| `src/test/suite/extension.test.ts` | Integration | Functional E2E verification: activation and command registration. |

## Automated Testing Strategy

### The "Decoupled Bridge" Pattern
To avoid brittle UI automation, the extension host uses a `BridgeHost` interface.
1.  **Logic Separation**: Message handlers in `panelProvider.ts` are decoupled from the real `WebviewPanel`.
2.  **Mockability**: Integration tests can provide a `MockBridgeHost` to verify IPC logic without a real window.
3.  **Stability**: This pattern is used to catch bundling/import issues before release.

### Mandatory Validation Checklist
Before committing changes or generating a VSIX, the following MUST pass:
- [ ] **Type Check**: `npx tsc -p tsconfig.extension.json --noEmit`
- [ ] **Sanity Check**: `npm run test:sanity` (Catches bundling/import issues)
- [ ] **Integration Check**: `npm run test:vscode` (Verifies real VS Code activation)
- [ ] **Logic Tests**: `npm test` (Ensures no parsing regressions)

## Test Data Rules
Only **AdventureWorks** dacpacs are allowed in the `test/` directory. No customer data or sensitive schemas should ever be added to this public suite.
