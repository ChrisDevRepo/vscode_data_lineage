/** Shared turn-outcome and round-limit contracts used by every live runner and adapter. */

/** Terminal status of one chat turn, carried on the `TurnEventSink`'s single closing event. */
export type TurnOutcome = 'ok' | 'error' | 'cancelled';

/** Default traversal-hop cap shared by the graph runtime and host runners. */
export const DEFAULT_MAX_ROUNDS = 50;
