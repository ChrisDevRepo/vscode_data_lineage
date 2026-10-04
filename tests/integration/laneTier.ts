/**
 * Model-tier banner printed by every Extension Development Host lane.
 *
 * @remarks
 * A passing mocha line from a lane that never called a model reads exactly like a passing line from
 * one that did, so a lane result quoted without its tier overstates what was proven. Each lane
 * therefore states its tier itself, in its own output, rather than leaving it to a doc a reader of
 * the log may never open.
 *
 * `none` means no model provider is installed; `fixture` means a test provider returns fixed
 * responses through the public VS Code language-model API. Neither tier performs inference.
 */

/** Model involvement of one deterministic EDH lane. */
export type ModelTier = 'none' | 'fixture';

const TIER_LINE: Record<ModelTier, string> = {
  none: 'MODEL: none — no provider is registered in this host. Nothing here infers.',
  fixture: 'MODEL: fixture — fixed responses through the VS Code API. No inference or provider network call.',
};

/**
 * Prints the lane's model tier and what a green result may and may not be quoted as.
 *
 * @param laneLabel - The `.vscode-test.mjs` label, so the banner and the runner agree.
 * @param tier - Model involvement of this lane.
 * @param proves - What a green run of this lane does establish, in one clause.
 */
export function announceLaneTier(laneLabel: string, tier: ModelTier, proves: string): void {
  console.log(
    `\n  ── LANE ${laneLabel} ──\n`
    + `    ${TIER_LINE[tier]}\n`
    + `    Proves: ${proves}\n`
    + '    NOT evidence about prompt quality, model behaviour, or answer correctness.\n',
  );
}
