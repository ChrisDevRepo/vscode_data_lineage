/** Model-tier banner printed by every Extension Development Host lane. */

/** Model involvement of one deterministic EDH lane. */
export type ModelTier = 'none' | 'fixture';

const TIER_LINE: Record<ModelTier, string> = {
  none: 'MODEL: none — no provider is registered in this host. Nothing here infers.',
  fixture: 'MODEL: fixture — fixed responses through the VS Code API. No inference or provider network call.',
};

/** Prints the lane's model tier and what a green result may and may not be quoted as. */
export function announceLaneTier(laneLabel: string, tier: ModelTier, proves: string): void {
  console.log(
    `\n  ── LANE ${laneLabel} ──\n`
    + `    ${TIER_LINE[tier]}\n`
    + `    Proves: ${proves}\n`
    + '    NOT evidence about prompt quality, model behaviour, or answer correctness.\n',
  );
}
