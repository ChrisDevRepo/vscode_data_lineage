# Summary

<!-- Short description of what this PR does and why. -->

Closes #

## Changes

<!-- Bullet list of the concrete changes in this PR. -->

-

## Testing

<!-- How did you verify this works? Commands you ran + what you observed in the Extension Development Host. -->

- [ ] `npx tsc --noEmit` — clean
- [ ] `npm test` — passes
- [ ] `npm run build` — succeeds
- [ ] Manually verified in the Extension Development Host (press F5)

## Parser rule changes (if applicable)

- [ ] `npm run test:snapshot` was run and left the baseline green (no lost dependencies)
- [ ] Any gained dependencies are justified in the commit message
- [ ] `tests/fixtures/aw-baseline.tsv` is committed if an intentional refresh was needed

## CHANGELOG

- [ ] Entry added under the next `[Unreleased]` section in `CHANGELOG.md` (Added / Changed / Fixed / Removed)
- [ ] Version in `package.json` is correct for the intended release type (preview = MINOR for features, PATCH for fixes)

## Docs

- [ ] Touched user-visible behavior is reflected in `docs/FEATURES.md` / `docs/TROUBLESHOOTING.md`
- [ ] Touched contributor-facing behavior is reflected in `CONTRIBUTING.md` / `docs/TESTING.md` / `docs/TECHNICAL_ARCHITECTURE.md`
- [ ] No references to gitignored paths (`docs-internal/`, `.claude/`, `CLAUDE.md`) in any file that ships publicly
