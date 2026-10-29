import {
  inspectPresentResult, type PresentNodeIdStateLookup, type PresentReference, type PresentResultInput, type PresentResultStage, type PresentResultViolation,
} from '../../../src/ai/tools/presentResult';

/** Runs the production inspection over an authored report: one reference per node id at the position the native schema admits it. */
export function inspectPresentInput(
  input: PresentResultInput, resolvedNodeIds: string[],
  externalViolations: readonly PresentResultViolation[] = [], stage: PresentResultStage = 'completed',
  nodeIdState?: PresentNodeIdStateLookup,
) {
  const references: PresentReference[] = [];
  for (const field of ['sections', 'highlight_groups'] as const) input[field]?.forEach((entry, index) => entry.node_ids?.forEach((nodeId, idIndex) =>
    references.push({ field, heldPath: `${field}.${index}`, path: `${field}.${index}.node_ids.${idIndex}`, nodeId })));
  input.notes?.forEach((note, index) => references.push({ field: 'notes', heldPath: `notes.${index}.node_id`, path: `notes.${index}.node_id`, nodeId: note.node_id }));
  return inspectPresentResult({ references, coverageKnown: true }, resolvedNodeIds, externalViolations, stage, nodeIdState);
}
