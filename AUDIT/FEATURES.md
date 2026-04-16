# FEATURE INVENTORY

Features cataloged per file, OLD (main) vs NEW (refactor branch).
Format: F-NNN for old features, F-NNN-NEW for new counterparts, MISSING-NNN for gaps, N-NNN for net-new.

---

## Batch 1: Core Decomposition (extension.ts → extension.ts + panelProvider.ts + commands.ts + AI modules)

### OLD (main): src/extension.ts — 3477 lines, 130 features inventoried

| Category | Count | IDs |
|----------|-------|-----|
| Module-level variables | 20 | F-001 to F-020 |
| Types/interfaces | 6 | F-021 to F-026 |
| Utility functions | 8 | F-027 to F-034 |
| activate() + commands | 11 | F-035 to F-045 |
| AI tool registrations | 13 | F-046 to F-058 |
| Chat participant | 3 | F-059 to F-061 |
| Standalone functions | 16 | F-062 to F-077 |
| openPanel + infrastructure | 10 | F-078 to F-088 |
| Message handlers | 27 | F-089 to F-115 |
| Webview HTML + sidebar | 4 | F-116 to F-119 |
| deactivate() | 1 | F-120 |
| Internal chat helpers | 10 | F-121 to F-130 |

### NEW (refactor): Decomposed into 9 files

| File | Lines | Features | Status |
|------|-------|----------|--------|
| extension.ts | 469 | F-035a, F-065, F-066, F-085, F-120 + DEAD CODE (186-469) | REFACTORED |
| panelProvider.ts | 929 | F-019/020, F-067-084, F-086-119, N-020/021/022/023 | REFACTORED |
| commands.ts | 152 | F-036-045, F-062-064 | IDENTICAL |
| ai/lineageParticipant.ts | 324 | F-027, F-059-061, F-121-130, N-017 | REFACTORED |
| ai/toolProvider.ts | 560 | F-028-034, F-046-058, N-018/019 | REFACTORED (F-052 CHANGED) |
| ai/session.ts | 172 | F-001-018, N-002-007 | REFACTORED |
| ai/memoryManager.ts | 167 | F-025-026, N-008-014 | REFACTORED |
| ai/viewSynthesisService.ts | 136 | N-015/016 | NEW (from F-052) |
| ai/types.ts | 51 | F-021-024, N-001 | REFACTORED |

### Mapping Summary

- **IDENTICAL**: 89/130 features
- **REFACTORED**: 40/130 features (same logic, different structure)
- **CHANGED**: 1/130 features (F-052 enrich_view → ViewSynthesisService delegation)
- **MISSING**: 0/130 features
- **NET-NEW**: 23 features (N-001 to N-023)
- **DEAD CODE**: extension.ts:186-469 (old registerChatParticipant, 284 lines, never called)

