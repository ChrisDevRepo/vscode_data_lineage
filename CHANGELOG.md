# Changelog

## [0.9.11] - 2026-04-16

### Improved
- **Rock-Solid Stability** — Implemented a new type-safe communication layer (Zod) between the extension and the UI, eliminating "mystery crashes" and ensuring 100% reliable data flow.
- **Enhanced Performance** — Moved complex graph calculations from the UI to the core engine. The "Star" filter and schema-level views are now up to 50% faster on large databases.
- **Deep Security** — SQL parsing is now protected against "Regex Denial of Service" (ReDoS) by using a new compositional building system for search patterns.
- **Better Documentation** — Created a comprehensive internal developer guide and cleaned up public documentation to be more user-focused and professional.

### Changed
- **Internal Cleanup** — Successfully removed over 1,000 lines of redundant code by centralizing SQL metadata and AI orchestration logic.
- **Verified AI** — Added a functional AI Mock test suite to verify that the assistant's search and trace logic is robust even without a live internet connection.

## [0.9.9] - 2026-04-15

### Added
- **Incremental AI view updates** — You can now ask the AI to add or remove specific tables and update descriptions in an existing graph without restarting the entire analysis.
- **Smarter AI session protection** — Added automatic cleanup for old AI sessions (2-hour timeout) and a confirmation warning if you try to start a new analysis while one is already active.
- **Improved AI "Memory"** — The AI now better remembers its initial findings from the start of a conversation, leading to more consistent results in complex, multi-step traces.

### Fixed
- **Table Statistics Routing & Timeout** — Corrected message routing between the extension host and detail panel to ensure Quick/Standard stats results are displayed. Added a robust timeout mechanism using the `tableStatistics.queryTimeout` setting to prevent hangs on slow connections.
- **Clean slate for new chats** — Starting a new chat window now correctly resets the AI state, preventing buttons or findings from old conversations from appearing.
- **Improved "Show in Graph" button** — The button now only appears when a full AI analysis is ready, and it is correctly hidden after simple table lookups.
- **Smart schema filtering** — The AI can now analyze objects outside your active filters when asked, with better validation to ensure requested schemas exist in your model.
- **Enriched state machine dumps** — Debugging information now includes unique session IDs and timestamps for easier troubleshooting.

### Changed
- **Internal architecture cleanup** — Refactored AI session management for better stability and more reliable state handling across different chat windows.

## [0.9.8] - 2026-04-12
...
