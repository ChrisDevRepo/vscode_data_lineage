/** The error class of a broken runtime invariant: a contract between this extension's own modules that no user action and no model reply can affect (a transcript that lost its tool pairing, a model port that recorded two provider calls for one attempt, a graph guard that selected no stop). */
export class InternalInvariantError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InternalInvariantError';
  }
}

/** The chat text of a turn ended by an {@link InternalInvariantError}. */
export const INTERNAL_INVARIANT_STOP_TEXT =
  'Analysis stopped: an internal error occurred. The run is incomplete, so no result is shown and the graph was not changed. Details are in the debug log. Ask again.';
