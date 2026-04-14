# Test Suite

The project uses a multi-layered testing approach to ensure stability across the parsing engine, graph topology, and the VS Code / AI bridge.

## Running Tests

### 1. Pure Logic Tests (Fast)
```bash
npm test                                       # Core engine unit tests (Parsing, Graph, DMV)
npm run test:project                           # Project store serialization tests
npm run test:snapshot                          # Parser baseline check (AW SPs vs committed TSV)
```

### 2. Infrastructure & Integrity (Pre-Package)
```bash
npm run test:sanity                            # Bundle Integrity: verifies out/extension.js loads without ReferenceErrors
npm run test:vscode                            # Functional Integration: launches headless VS Code to verify activation and commands
```

### 3. Internal Tests (Live Environment)
```bash
npm run test:ai                                # AI tool function tests (requires internal test-internal dir)
npm run test:db                                # Live SQL Server integration tests
```

## Test Files

| File | Type | Purpose |
|------|------|---------|
| `test/dacpacExtractor.test.ts` | Unit | Dacpac extraction, filtering, edge integrity, and constraint extraction. |
| `test/graphBuilder.test.ts` | Unit | Graph construction, BFS trace, and directional edge filtering. |
| `test/parser-edge-cases.test.ts` | Unit | Primary regression guard for regex rule verification in `sqlBodyParser.ts`. |
| `test/bundle-sanity.js` | Sanity | Verifies the final bundled code is executable in a clean Node.js environment. |
| `src/test/suite/extension.test.ts` | Integration | Functional E2E verification: activation, command registration, and session state. |

## Automated Testing Strategy

### The "Decoupled Bridge" Pattern
To avoid brittle UI automation, the extension host uses a `BridgeHost` interface.
1.  **Logic Separation**: Message handlers in `panelProvider.ts` are decoupled from the real `WebviewPanel`.
2.  **Mockability**: Integration tests can provide a `MockBridgeHost` to verify IPC logic, BFS results, and search behavior without a real window.
3.  **Stability**: This pattern caught the critical `ReferenceError: ColumnStore is not defined` regression before release.

### Mandatory Validation Checklist
Before committing major refactors or generating a VSIX, the following MUST pass:
- [ ] **Type Check**: `npx tsc -p tsconfig.extension.json --noEmit`
- [ ] **Sanity Check**: `npm run test:sanity` (Catches bundling/import issues)
- [ ] **Integration Check**: `npm run test:vscode` (Verifies real VS Code activation)
- [ ] **Logic Tests**: `npm test` (Ensures no parsing regressions)

## Adding Tests

### tsx tests (Engine)
Create a new `.test.ts` file in `test/` and add it to the `test` script in `package.json`.

### VS Code Integration Tests
Add new test cases to `src/test/suite/extension.test.ts`. Use the `extensionApi` returned by `ext.activate()` to inspect the internal `AiSession` singleton.

```typescript
test('Verify Custom Logic', async () => {
    const ext = vscode.extensions.getExtension('datahelper-chwagner.data-lineage-viz')!;
    const api = await ext.activate();
    const sess = api.getSession();
    // Assert against live singleton state...
});
```

## Test Data Rules
Only **AdventureWorks** dacpacs are allowed in the `test/` directory. Customer data must remain in `customer-data/` (gitignored) and must never be committed.
