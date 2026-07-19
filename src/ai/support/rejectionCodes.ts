/**
 * Single owner for rejection codes that appear on more than one surface.
 *
 * @remarks
 * Most rejection codes live only where they are emitted; a code belongs here as soon as a second
 * surface shows it to the model (instruction prose, a hint payload, a `.describe()` contract).
 * Both surfaces then interpolate the same constant, so a rename cannot silently drift between the
 * emitting guard and the prompt that teaches the recovery. Provider-pure: no `vscode` / AI-SDK
 * imports.
 */
export const REJECTION_CODES = {
  /** `submit_findings` carries a CT-only field (`column_flow`) in a BB session. */
  bbFieldUnknown: 'bb_field_unknown',
  /** Tool called outside the current phase's `toolPolicy` allow-list. */
  offPolicy: 'off_policy',
  /** `start_exploration` while the session's exploration is already live (one-shot per turn). */
  alreadyStarted: 'already_started',
  /** Provider/SDK emitted the same tool-call id twice in one generation — a transport artifact, never charged to the model's semantic budget. */
  duplicateCallId: 'duplicate_call_id',
} as const;
