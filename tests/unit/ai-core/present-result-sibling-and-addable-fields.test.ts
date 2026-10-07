/** A rejected `present_result` call keeps its valid fields despite keys the tool does not define, and its repair may carry further report fields. */
import { expect, it } from 'vitest';
import { RepairDraftStore } from '../../../src/ai/support/repairDraftStore';
import { rejectionFromZodError } from '../../../src/ai/support/toolErrorEnvelope';
import { REJECTION_CODES } from '../../../src/ai/support/rejectionCodes';
import {
  holdRejectedPresentResult, mergePresentResultRepairPatch,
  type PresentResultInput, type PresentResultRepairAuthorization, type PresentResultRepairPatch,
} from '../../../src/ai/tools/presentResult';
import { presentResultSchemaForPhase } from '../../../src/ai/tools/toolSchemas';

const source = '[stage].[orders]';
const target = '[mart].[orders]';

function holdGarbledCall() {
  const store = new RepairDraftStore<PresentResultInput, PresentResultRepairAuthorization>();
  const garbled = {
    name: 'Orders lineage', summary: 'Orders from stage to mart.', title: 'Orders', intro: 'How orders load.',
    sections: 'Stage <parameter name="text">Raw orders.',
    label: 'Stage', node_ids: [source],
  };
  const schema = presentResultSchemaForPhase('synthesis', null, false);
  const parsed = schema.safeParse(garbled);
  expect(parsed.success).toBe(false);
  const rejection = rejectionFromZodError(parsed.error!, { code: REJECTION_CODES.invalidInput, input: garbled, schema });
  const hint = holdRejectedPresentResult(store, garbled, rejection.issuePaths ?? [], 'synthesis');
  return { store, hint, issuePaths: rejection.issuePaths ?? [] };
}

it('holds the valid fields of a call that also carries keys the tool does not define', () => {
  const { store, hint, issuePaths } = holdGarbledCall();

  expect(issuePaths).toEqual(expect.arrayContaining(['label', 'node_ids', 'sections', 'highlight_groups']));
  expect(hint).not.toBeNull();
  expect(store.get()).toEqual({ name: 'Orders lineage', summary: 'Orders from stage to mart.', title: 'Orders', intro: 'How orders load.' });
  expect([...store.getAuthorization()!.fields].sort()).toEqual(['highlight_groups', 'sections']);
});

it('merges a repair that carries report fields the rejection did not name', () => {
  const { store } = holdGarbledCall();
  const authorization = store.getAuthorization()!;
  const repair = {
    highlight_groups: [{ label: 'Source', color: 'source', node_ids: [source] }],
    sections: [
      { label: 'Stage', node_ids: [source], text: 'Raw orders.' },
      { label: 'Mart', node_ids: [target], text: 'Reporting orders.' },
    ],
    notes: [{ node_id: target, caption: 'Loaded nightly.' }],
    closing: 'Orders flow from stage to mart.',
  };

  const parsed = presentResultSchemaForPhase('synthesis', authorization.fields, false).safeParse(repair);
  expect(parsed.success, JSON.stringify(parsed.success ? null : parsed.error.issues)).toBe(true);

  const merged = mergePresentResultRepairPatch(store.get()!, parsed.data as PresentResultRepairPatch, authorization);
  expect(merged.name).toBe('Orders lineage');
  expect(merged.closing).toBe('Orders flow from stage to mart.');
  expect(merged.notes).toHaveLength(1);
  expect(merged.sections?.map(section => section.label)).toEqual(['Stage', 'Mart']);
  expect(merged.highlight_groups).toHaveLength(1);
});

it('still refuses a graph edit the rejection did not authorize', () => {
  const { store } = holdGarbledCall();
  const authorization = store.getAuthorization()!;
  const repair = {
    highlight_groups: [{ label: 'Source', color: 'source', node_ids: [source] }],
    sections: [{ label: 'Stage', node_ids: [source], text: 'Raw orders.' }],
    prune_node_ids: [target],
  };

  expect(presentResultSchemaForPhase('synthesis', authorization.fields, false).safeParse(repair).success).toBe(false);
  expect(() => mergePresentResultRepairPatch(store.get()!, repair as PresentResultRepairPatch, authorization)).toThrow('prune_node_ids');
});

it('holds nothing when only undefined keys failed', () => {
  const store = new RepairDraftStore<PresentResultInput, PresentResultRepairAuthorization>();

  expect(holdRejectedPresentResult(store, { name: 'Orders lineage', label: 'Stage' }, ['label'], 'synthesis')).toBeNull();
  expect(store.get()).toBeFalsy();
});

it('merges a notes repair by node id: one missing caption is one resent entry', () => {
  const store = new RepairDraftStore<PresentResultInput, PresentResultRepairAuthorization>();
  const stale = '[mart].[retired]';
  store.hold({
    name: 'Orders lineage', summary: 'Orders from stage to mart.',
    highlight_groups: [{ label: 'Source', color: 'source', node_ids: [source] }],
    sections: [{ label: 'Stage', node_ids: [source], text: 'Raw orders.' }],
    notes: [{ node_id: source, caption: 'Landed hourly.' }, { node_id: stale, caption: 'Dropped object.' }],
  } as PresentResultInput, { fields: ['notes'] });
  const authorization = store.getAuthorization()!;
  const repair = { notes: [{ node_id: 'mart.orders', caption: 'Loaded nightly.' }, { node_id: stale, remove: true }] };

  const parsed = presentResultSchemaForPhase('synthesis', authorization.fields, false).safeParse(repair);
  expect(parsed.success, JSON.stringify(parsed.success ? null : parsed.error.issues)).toBe(true);

  const merged = mergePresentResultRepairPatch(store.get()!, parsed.data as PresentResultRepairPatch, authorization);
  expect(merged.notes).toEqual([{ node_id: source, caption: 'Landed hourly.' }, { node_id: 'mart.orders', caption: 'Loaded nightly.' }]);
});
