import {
  getAllowedLmToolNames,
  activeModeOf,
} from '../../../src/ai/tools/toolPolicy';
import { describe, expect, it } from 'vitest';

describe("toolPolicy", () => {
  const cases: Array<{
    name: string;
    stage: Parameters<typeof getAllowedLmToolNames>[0];
    expected: string[];
  }> = [
    {
      name: 'discover',
      stage: { kind: 'discover' },
      expected: [
        'lineage_get_context',
        'lineage_get_screen_state',
        'lineage_search_objects',
        'lineage_get_scope_bundle',
        'lineage_search_ddl',
        'lineage_get_object_detail',
        'lineage_detect_graph_patterns',
      ],
    },
    {
      name: 'visual preview',
      stage: { kind: 'visual_preview' },
      expected: ['lineage_present_result'],
    },
    {
      // The screen card resolves an origin the user referred to as "this trace", so sm_entry
      // exposes three tools, not the two the origin-resolution path started with.
      name: 'sm entry',
      stage: { kind: 'sm_entry' },
      expected: [
        'lineage_get_screen_state',
        'lineage_search_objects',
        'lineage_start_exploration',
      ],
    },
    {
      name: 'active / sm_bb',
      stage: { kind: 'active', mode: 'sm_bb' },
      expected: ['lineage_submit_findings', 'lineage_get_neighbor_columns'],
    },
    {
      name: 'active / sm_ct',
      stage: { kind: 'active', mode: 'sm_ct' },
      expected: ['lineage_submit_findings', 'lineage_get_neighbor_columns'],
    },
    {
      name: 'synthesis',
      stage: { kind: 'synthesis' },
      expected: ['lineage_present_result'],
    },
    {
      name: 'completed',
      stage: { kind: 'completed' },
      expected: [
        'lineage_present_result',
        'lineage_get_object_detail',
        'lineage_get_screen_state',
        'lineage_search_ddl',
        'lineage_search_objects',
        'lineage_start_exploration',
      ],
    },
  ];

  it.each(cases)('$name exposes exactly its allowed tools', ({ name, stage, expected }) => {
    const actual = [...getAllowedLmToolNames(stage)].sort();
    expect(JSON.stringify(actual), `${name}: exact tool set`).toBe(JSON.stringify([...expected].sort()));
  });

  it.each([
    { columnTrace: false, expected: 'sm_bb' as const },
    { columnTrace: true, expected: 'sm_ct' as const },
  ])('maps columnTrace=$columnTrace to $expected', ({ columnTrace, expected }) => {
    expect(activeModeOf(columnTrace), `columnTrace=${columnTrace}`).toBe(expected);
  });
});
