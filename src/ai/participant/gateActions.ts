import type { PendingGate } from '../session/sessionPhase';

export interface GateAction {
  title: string;
  reply: 'yes' | 'refine' | 'no';
}

/** Stable command-button contract for every pending Copilot scope gate. */
export function gateActions(gate: PendingGate): GateAction[] {
  return [
    { title: '$(check) Approve & Proceed', reply: 'yes' },
    ...(gate.gate === 'confirm_sm_start'
      ? [{ title: '$(edit) Refine scope', reply: 'refine' as const }]
      : []),
    { title: '$(close) Cancel', reply: 'no' },
  ];
}
