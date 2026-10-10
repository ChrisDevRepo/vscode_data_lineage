// Selects the recorded live analysis the chat-UI `badge` lane replays for its setup.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

/** Origin of the public AdventureWorks question the live lane records. */
const REPLAY_ORIGIN = '[ai].[spimportorders]';

/** What the badge lane needs before it can run; the start of every setup error. */
export const BADGE_REPLAY_SETUP =
  'Badge acceptance needs a recorded successful public AdventureWorks AI synthesis.';

/**
 * Whether one NDJSON trace records the successful public analysis the badge lane replays: an
 * admitted `[ai].[spImportOrders]` exploration with both classifications whose accepted synthesis
 * reached an OK terminal. Native approval may continue in a fresh request of the same session.
 *
 * @param path - Trace file to read.
 * @returns `false` for a non-matching or unreadable (for example truncated) trace.
 */
function isSuccessfulPublicAnalysis(path) {
  let records;
  try {
    records = readFileSync(path, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
  } catch {
    return false;
  }
  if (!records.some(row => row?.type === 'trace-open' && row.origin === 'extension-host')) return false;
  // Tool lifecycle rows have no callId: only one outcome before the next response/terminal is unambiguous.
  const dispatchOutcome = (index, name) => {
    const requestId = records[index].requestId;
    if (typeof requestId !== 'string' || !requestId) return undefined;
    const outcomes = [];
    for (const row of records.slice(index + 1)) {
      if (row?.requestId !== requestId) continue;
      if (row.type === 'wire-response' || row.type === 'turn-terminal') break;
      if (row.type === 'tool' && row.toolName === name) outcomes.push(row);
    }
    return outcomes.length === 1 ? outcomes[0] : undefined;
  };
  const sessionOf = (requestId, before) => {
    const turns = records.slice(0, before).filter(row => row?.type === 'turn-start' && row.requestId === requestId);
    return turns.length === 1 && typeof turns[0].sessionFingerprint === 'string' && turns[0].sessionFingerprint
      ? turns[0].sessionFingerprint : undefined;
  };
  const gatesAfter = (start, before) => records.slice(start.index + 1, before).filter(row =>
    row?.type === 'gate' && row.phase === 'confirm_sm_start' && typeof row.gateId === 'string' && row.gateId
    && start.gateRequests.includes(row.requestId) && sessionOf(row.requestId, before) === start.session);
  let start;
  let successful = false;
  for (const [index, row] of records.entries()) {
    if (row?.type !== 'wire-response') continue;
    const calls = Array.isArray(row.toolCalls) ? row.toolCalls : [];
    const starts = calls.filter(call => call?.name === 'lineage_start_exploration');
    if (starts.length) {
      const input = starts[0].input;
      const outcome = dispatchOutcome(index, 'lineage_start_exploration');
      const session = sessionOf(row.requestId, index);
      // Refinement uses the sm_entry wire phase and inherits only its recorded held proposal.
      const heldRefinement = starts.length === 1 && row.phase === 'sm_entry' && start?.status === 'gate'
        && session && session === start.session && gatesAfter(start, index).length > 0;
      const refining = heldRefinement && Number.isInteger(input?.proposalRevision);
      // These failures precede storePendingExploration; unexpected/backend failures give no such proof.
      if (heldRefinement && ((outcome?.status === 'rejected' && [
        'invalid_type', 'invalid_enum', 'invalid_value', 'unknown_field', 'missing_field',
        'ct_field_forbidden_in_bb', 'asymmetric_depth_both_zero', 'unknown_node_ids', 'origin_not_found',
        'unknown_columns', 'target_columns_name_objects', 'stale_proposal_revision', 'no_op_refine',
      ].includes(outcome.rejectionCode)) || (outcome?.status === 'refused' && outcome.rejectionCode === 'over_active_scope_budget'))) {
        start.gateRequests.push(row.requestId);
        continue;
      }
      successful = false;
      start = starts.length === 1 && session && ['accepted', 'gate'].includes(outcome?.status)
        ? { index, requestId: row.requestId, session, status: outcome.status, gateRequests: [row.requestId],
          origin: input?.origin ?? (refining ? start.origin : undefined),
          classification: input?.classification ?? (refining ? start.classification : undefined) } : undefined;
    }
    if (!start || typeof start.origin !== 'string' || start.origin.toLowerCase() !== REPLAY_ORIGIN
      || start.classification !== 'both' || row.phase !== 'synthesis'
      || calls.filter(call => call?.name === 'lineage_present_result').length !== 1
      || dispatchOutcome(index, 'lineage_present_result')?.status !== 'accepted'
      || sessionOf(row.requestId, index) !== start.session) continue;
    const sameRequest = start.requestId === row.requestId;
    if (!sameRequest || start.status === 'gate') {
      const workerIndex = records.findIndex((event, eventIndex) => eventIndex > start.index && eventIndex < index
        && event?.type === 'wire-response' && event.requestId === row.requestId && event.phase === 'active_worker'
        && Array.isArray(event.toolCalls) && event.toolCalls.filter(call => call?.name === 'lineage_submit_findings').length === 1
        && dispatchOutcome(eventIndex, 'lineage_submit_findings')?.status === 'accepted');
      const gates = gatesAfter(start, workerIndex);
      const turnIndex = records.findIndex(event => event?.type === 'turn-start' && event.requestId === row.requestId);
      const nativeApproval = gates.some(gate => records.some((event, eventIndex) => eventIndex > records.indexOf(gate)
        && event?.type === 'gate-resolution'
        && event.requestId === gate.requestId && event.gateId === gate.gateId && event.gate === 'confirm_sm_start'
        && event.action === 'approve' && (event.outcome === 'accepted' ? gate.requestId === row.requestId
          : event.outcome === 'no_owning_turn' && gate.requestId !== row.requestId && eventIndex < turnIndex)));
      const typedApproval = records.slice(start.index + 1, workerIndex).some((event, offset) =>
        event?.type === 'wire-response' && event.requestId === row.requestId && event.phase === 'detect_entry'
        && gates.some(gate => records.indexOf(gate) < start.index + 1 + offset)
        && Array.isArray(event.toolCalls) && event.toolCalls.length === 1 && event.toolCalls[0]?.name === 'structured_output'
        && event.toolCalls[0].input?.action === 'approve' && Object.keys(event.toolCalls[0].input).length === 1);
      // A held proposal alone proves no admission; require a recorded decision and accepted worker dispatch.
      if (workerIndex < 0 || (!nativeApproval && !typedApproval)) continue;
    }
    if (records.slice(index + 1).find(event => event?.requestId === row.requestId
      && event.type === 'turn-terminal')?.status === 'ok') successful = true;
  }
  return successful;
}

/**
 * Finds the newest recorded trace the badge lane can replay.
 *
 * @param rootDir - Repository root, which is also the live lane's workspace; traces are read from
 * `<rootDir>/tmp/lm-trace` regardless of the process working directory.
 * @returns Absolute path of the newest qualifying `.ndjson` trace.
 * @throws Error starting with {@link BADGE_REPLAY_SETUP} when the directory is absent or holds no
 * qualifying trace; any other file-system failure is rethrown unchanged.
 */
export function findBadgeReplayTrace(rootDir) {
  const traceDir = join(rootDir, 'tmp', 'lm-trace');
  const setupError = () => new Error(
    `${BADGE_REPLAY_SETUP} Expected a successful live-lane trace under ${traceDir}; record one with `
    + '`npx vscode-test --config .vscode-test.chat-ui.mjs --label live`.',
  );
  let names;
  try {
    names = readdirSync(traceDir);
  } catch (error) {
    if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') throw setupError();
    throw error;
  }
  const trace = names.filter((name) => name.endsWith('.ndjson'))
    .map((name) => join(traceDir, name))
    .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)
    .find(isSuccessfulPublicAnalysis);
  if (!trace) throw setupError();
  return trace;
}
