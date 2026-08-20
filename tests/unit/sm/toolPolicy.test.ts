import { assertEq } from '../helpers/testUtils';
import {
  getAllowedLmToolNames,
  activeModeOf,
} from '../../../src/ai/tools/toolPolicy';
import { describe, it } from 'vitest';

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
        'lineage_search_ddl',
        'lineage_search_objects',
        'lineage_start_exploration',
      ],
    },
  ];

  it.each(cases)('$name exposes exactly its allowed tools', ({ name, stage, expected }) => {
    const actual = [...getAllowedLmToolNames(stage)].sort();
    assertEq(JSON.stringify(actual), JSON.stringify([...expected].sort()), `${name}: exact tool set`);
  });

  it.each([
    { columnTrace: false, expected: 'sm_bb' as const },
    { columnTrace: true, expected: 'sm_ct' as const },
  ])('maps columnTrace=$columnTrace to $expected', ({ columnTrace, expected }) => {
    assertEq(activeModeOf(columnTrace), expected, `columnTrace=${columnTrace}`);
  });
});
