/** The simulated consent-gate policy of a headless turn: its rounds and how a card is judged. */
import { z } from 'zod';
import type { AiSession } from '../../src/ai/session/session';

/**
 * How one gate round is answered: the user's next chat turn. The `--gate` JSON array is a list of
 * these.
 *
 * @remarks
 * Round *N* answers the run's *N*-th card, counted across its turns; a card past the list has no
 * answer. An approve round's `onMismatch` is the one typed Change for a card that misses `expect`:
 * it needs `expect` and nothing but a non-empty `instruction`, the text to send.
 */
export const GateRoundSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('approve'),
    expect: z.string().min(1).optional(),
    onMismatch: z.strictObject({ instruction: z.string().trim().min(1) }).optional(),
  }).refine((round) => round.onMismatch === undefined || round.expect !== undefined, {
    message: 'onMismatch needs an approve round with expect',
  }),
  z.strictObject({ kind: z.literal('deny') }),
  z.strictObject({ kind: z.literal('refine'), instruction: z.string().trim().min(1) }),
]);
export type GateRoundPolicy = z.infer<typeof GateRoundSchema>;

/** The declared answer to card number `index`; none past the list, so the card stays open. */
export function gateRound(gate: readonly GateRoundPolicy[] | undefined, index: number): GateRoundPolicy | undefined {
  return gate?.[index];
}

/**
 * Evaluates one `approve.expect` assertion (`field~substring`, `field=count`, `!` negates) against
 * the pending proposal. Exported for the internal gate-logic unit test. @internal
 */
export function evaluateGateExpectation(expr: string, session: Pick<AiSession, 'pendingExploration'>): boolean {
  const proposal = session.pendingExploration;
  if (!proposal) return false;
  const negated = expr.startsWith('!');
  const body = negated ? expr.slice(1) : expr;
  const countMatch = /^([A-Za-z]+)=(\d+)$/.exec(body);
  if (countMatch) {
    const counts: Record<string, number | undefined> = {
      scopeCount: proposal.summary.scopeCount,
      hopCount: proposal.summary.hopCount,
    };
    const actual = counts[countMatch[1]];
    const ok = actual !== undefined && actual === Number(countMatch[2]);
    return negated ? !ok : ok;
  }
  const hasMatch = /^([A-Za-z]+)~(.+)$/.exec(body);
  if (!hasMatch) throw new Error(`gate expect "${expr}" is invalid. Use field~substring or field=count.`);
  const [, field, needle] = hasMatch;
  const init = proposal.init as unknown as Record<string, unknown>;
  const raw = field === 'classification' ? proposal.classification : init[field];
  const values = Array.isArray(raw) ? raw.map((v) => String(v)) : raw === undefined ? [] : [String(raw)];
  const ok = values.some((v) => v.toLowerCase().includes(needle.toLowerCase()));
  return negated ? !ok : ok;
}

/** What an approve round's `expect` check left on its receipt. */
export interface GateExpectationReceipt {
  /** The round's expectation on the card it answered: the revised card when `mismatch` is set. */
  readonly expectation?: { readonly expr: string; readonly ok: boolean };
  /**
   * The onMismatch Change sent because the first card missed `expect`: refine, then the round's
   * decision on the revised card.
   */
  readonly mismatch?: {
    readonly decision: 'refine';
    readonly instruction: string;
    readonly expectation: { readonly expr: string; readonly ok: false };
    readonly proposalRevision?: number;
  };
  /** Set only when the Change left no card: the refine was the round's last answer. */
  readonly decision?: 'refine';
  readonly answer?: string;
}

/**
 * The expectation part of an approve round's receipt. When an open card misses `expect` and the
 * round declares `onMismatch`, `change` sends its instruction once, as the user's typed Change of
 * the card (the path a `refine` round takes); `mismatch` then records that refine and the first
 * card's result, and `expectation` is the revised card's. The caller approves the card left; when
 * the Change left none, the refine was the round's last answer and `decision`/`answer` say so.
 */
export async function answerExpectation(
  round: GateRoundPolicy,
  session: () => Pick<AiSession, 'pendingExploration'>,
  change: (instruction: string) => Promise<void>,
): Promise<GateExpectationReceipt> {
  if (round.kind !== 'approve' || round.expect === undefined) return {};
  const expr = round.expect;
  const ok = evaluateGateExpectation(expr, session());
  if (ok || !round.onMismatch || !session().pendingExploration) return { expectation: { expr, ok } };
  const { instruction } = round.onMismatch;
  await change(instruction);
  const revised = session().pendingExploration;
  return {
    ...(revised ? {} : { decision: 'refine' as const, answer: instruction }),
    mismatch: { decision: 'refine', instruction, expectation: { expr, ok: false }, ...(revised ? { proposalRevision: revised.revision } : {}) },
    expectation: { expr, ok: evaluateGateExpectation(expr, session()) },
  };
}
