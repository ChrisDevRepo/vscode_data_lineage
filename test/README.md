# Test Suite

## Running Tests

```bash
npm test              # Run engine/parser tests
npm run test:integration  # Run VS Code integration tests
```

## Test Files

| File | Purpose |
|------|---------|
| `engine.test.ts` | Parser baseline tests - validates SQL body parsing rules |
| `webview.integration.test.ts` | VS Code webview integration tests |
| `runTest.ts` | Test runner for VS Code extension tests |
| `suite/index.ts` | Mocha test suite configuration |

## Test Dacpacs

| File | Type | Description |
|------|------|-------------|
| `AdventureWorks.dacpac` | Classic | Full DDL style with CREATE statements |
| `AdventureWorks_sdk-style.dacpac` | SDK-style | Minimal model (Fabric/modern) |

Both classic and SDK-style dacpacs are supported.

## Adding Tests

When modifying parse rules:
1. Run `npm test` before changes
2. Make your changes
3. Run `npm test` after - zero regressions allowed

## Test Data Rules

Only AdventureWorks dacpacs allowed here. Customer data goes in `customer-data/` (gitignored).
