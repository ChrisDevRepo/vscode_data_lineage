/**
 * Model-tier banner printed by every Extension Development Host lane.
 *
 * @remarks
 * A passing mocha line from a lane that never called a model reads exactly like a passing line from
 * one that did, so a lane result quoted without its tier overstates what was proven. Each lane
 * therefore states its tier itself, in its own output, rather than leaving it to a doc a reader of
 * the log may never open.
 *
 * Four tiers exist in this repository. Only the last is the product's real path, and it has no
 * automated coverage:
 * - `none` — no provider registered in the host at all.
 * - `scripted` — the fixture extension registers a `vscode.LanguageModelChatProvider` that replays
 *   fixed text and tool calls. Genuine `vscode.lm` wiring, zero inference, zero network.
 * - live provider (measured internally, never an EDH lane) — real inference over the
 *   network, but headless: the harness supplies its own model port and a `vscode` shim, so
 *   `vscode.lm` is bypassed entirely.
 * - the product path — real VS Code, the user's own Copilot model. UAT only.
 */

/** Model involvement of one lane. An EDH lane can only ever be one of these two. */
export type ModelTier = 'none' | 'scripted';

const TIER_LINE: Record<ModelTier, string> = {
  none: 'MODEL: none — no provider is registered in this host. Nothing here infers.',
  scripted: 'MODEL: scripted — fixture provider replaying fixed output. No inference, no network, not Copilot.',
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
    + '    NOT evidence about prompt quality, model behaviour, or answer correctness. Inference is\n'
    + '    measured internally, headless, never by this repository\'s tracked suite, and the\n'
    + '    product path itself — real VS Code with your own Copilot model — only by UAT.\n',
  );
}
