import { describe, expect, it } from 'vitest';
import type { LineageNode } from '../../../src/engine/types';
import { makeNode } from '../helpers/modelFixtures';
import {
  column,
  columnViewFor,
  engineFor,
  storedArrivalCases,
} from './helpers/lineageCaseHarness';

const navigationFor = engineFor;

describe('stored-column arrival admission and delivery', () => {
  const producer = '[d].[Producer]',
    stored = '[d].[Stored]';
  const record = (focus_node_id: string) => ({
    focus_node_id,
    summary: 'Inspect the supplied stored-column task.',
    sections: [
      {
        angle: 'technical' as const,
        text: 'The supplied SQL establishes the input dispositions.',
      },
    ],
  });

  function storedWorld(
    readers: LineageNode[],
    branches: Array<[string, string]>,
    question: string,
    storedColumns = ['X', 'Y'],
  ) {
    const nodes = [
      makeNode({
        id: producer,
        schema: 'd',
        name: 'Producer',
        type: 'procedure',
        columns: [],
        bodyScript: 'INSERT d.Stored(X,Y) SELECT 10,20;',
      }),
      makeNode({
        id: stored,
        schema: 'd',
        name: 'Stored',
        type: 'table',
        columns: storedColumns.map(column),
      }),
      ...readers,
    ];
    const pairs: Array<[string, string]> = [[producer, stored], ...branches];
    const engine = navigationFor(nodes, pairs);
    expect(
      engine.init({
        origin: producer,
        question,
        analysisMode: 'ct',
        targetColumns: ['X', 'Y'],
        direction: 'downstream',
        depthIntent: {
          upstream: { levels: 0, exactness: 'exact' },
          downstream: { levels: 'all', exactness: 'exact' },
        },
      }),
    ).toHaveProperty('ok', true);
    engine.getHopContext();
    expect(
      engine.submitFindings({
        ...record(producer),
        column_flow: ['X', 'Y'].map((out_col) => ({
          out_node: stored,
          out_col,
          upstream_columns: [{ node: producer, col: out_col }],
        })),
        questions: [{ nodeId: stored, question }],
      }),
    ).toHaveProperty('ok', true);
    const producerEdges = structuredClone(engine.columnAspect!.edges);
    return { engine, nodes, pairs, producerEdges };
  }
  it.each(storedArrivalCases)('$id', (row) => {
    const receiver = '[d].[Receiver]',
      sink = '[d].[Sink]';
    const { engine, nodes, pairs, producerEdges } = storedWorld(
      [
        makeNode({
          id: receiver,
          schema: 'd',
          name: receiver,
          type: row.receiver_type,
          columns: row.receiver_columns.map(column),
          bodyScript: row.sql,
        }),
        makeNode({
          id: sink,
          schema: 'd',
          name: sink,
          type: row.receiver_type === 'procedure' ? 'table' : 'view',
          columns: row.sink_columns.map(column),
        }),
      ],
      [
        [stored, receiver],
        [receiver, sink],
      ],
      'Determine how the stored X and Y are used downstream.',
    );
    expect(engine.getHopContext()).toMatchObject({
      focus_node: { id: receiver },
      analysis_mode: 'ct',
    });
    expect(engine.columnAspect!.edges).toEqual(producerEdges);
    expect(engine.getCurrentTasks()).toContainEqual(
      expect.objectContaining({
        activeColumns: ['X', 'Y'],
        sourceRefs: [
          { node: stored, col: 'X' },
          { node: stored, col: 'Y' },
        ],
        question: 'Determine how the stored X and Y are used downstream.',
      }),
    );
    const submission = {
      ...record(receiver),
      column_flow: row.column_flow,
      questions: [
        {
          nodeId: sink,
          question:
            'Inspect the retained result, or explain the object dependency if no traced input is used.',
        },
      ],
    };
    const admitted = engine.submitFindings({ ...submission });
    expect(admitted, JSON.stringify(admitted)).toHaveProperty('ok', true);
    const pending = engine.investigationTasks.find(
      (task) => task.nodeId === sink && task.status === 'pending',
    )!;
    expect(pending).toMatchObject(
      row.expect.sink_mode === 'ct'
        ? { kind: 'column_lineage', activeColumns: row.expect.sink_columns }
        : { kind: 'analytical' },
    );
    if (row.receiver_type === 'procedure') {
      expect(engine.getHopContext()).toHaveProperty('done', true);
      expect(
        engine.getResult().node_states.find((state) => state.nodeId === sink),
      ).toMatchObject({ action: 'passthrough', source: 'engine' });
    } else
      expect(engine.getHopContext()).toMatchObject({
        focus_node: { id: sink },
        analysis_mode: row.expect.sink_mode,
      });
    const relations = engine.columnAspect!.edges;
    expect(
      relations
        .filter(
          (edge) => edge.hop_node === receiver && edge.from_node === stored,
        )
        .map((edge) => edge.from_col),
    ).toEqual(row.expect.mapped_inputs);
    expect(relations.filter((edge) => edge.hop_node === producer)).toEqual(
      producerEdges,
    );
    const view = columnViewFor(nodes, pairs, relations);
    expect(
      view.nodes
        .find((node) => node.id === receiver)!
        .rows.map((row) => row.name),
    ).toEqual(row.expect.receiver_rows);
    expect(
      view.nodes
        .find((node) => node.id === stored)!
        .rows.map((row) => row.name),
    ).toEqual(['X', 'Y']);
  });
});
