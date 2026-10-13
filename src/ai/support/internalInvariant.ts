/**
 * The error class of a broken runtime invariant: a contract between this extension's own modules
 * that no user action and no model reply can affect (a transcript that lost its tool pairing, a
 * model port that recorded two provider calls for one attempt, a graph guard that selected no stop).
 *
 * @remarks
 * The host runtime ends the turn on one with the stable internal-error text and logs the message
 * and stack; the message is written for the debug log, never for the chat. Every other thrown
 * `Error` keeps its own message, since some are written for the user (an unsupported tracing flag,
 * for one).
 */
export class InternalInvariantError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InternalInvariantError';
  }
}

/** The chat text of a turn ended by an {@link InternalInvariantError}. */
export const INTERNAL_INVARIANT_STOP_TEXT =
  'Analysis stopped: an internal error occurred. The run is incomplete, so no result is shown and the graph was not changed. Details are in the debug log. Ask again.';
