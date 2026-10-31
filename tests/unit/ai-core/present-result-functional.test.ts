/** Owns handlers/presentResult.ts functional CT coverage, origin closure and committed graph amendments. */
import { describe, expect, it, vi } from 'vitest';
import { NavigationEngine } from '../../../src/ai/sm/smBase';
import { buildGraphologyGraph } from '../../../src/engine/graphBuilder';
import { AiSession } from '../../../src/ai/session/session';
import { executePresentResult } from '../../../src/ai/tools/handlers/presentResult';
import type { ToolServices } from '../../../src/ai/tools/handlers/toolServices';
import { DEFAULT_TURN_TOKEN_BUDGET } from '../../../src/ai/support/tokenBudget';
import { buildModel, normalizeName } from '../../../src/engine/modelBuilder';
import type { DatabaseModel } from '../../../src/engine/types';
import type { ResultGraph } from '../../../src/ai/session/types';
import type { ColumnEdge } from '../../../src/ai/sm/smTypes';
import { renderProblem } from '../../../src/ai/support/toolErrorEnvelope';

/** The errors a rendered problem shows, across its category groups. */
const shownErrors = (text: string): Array<Record<string, unknown>> =>
  JSON.parse(text).errors;

function completedWorld(model: DatabaseModel, resultGraph: ResultGraph) {
  const session = new AiSession();
  const epoch = session.beginTurn();
  session.resultGraph = resultGraph;
  session.enterCompleted(epoch);
  const deliverPreview = vi.fn().mockResolvedValue('delivered');
  const services = {
    getSession: () => session,
    turnEpoch: () => epoch,
    requireModel: () => model,
    logger: {
      debug: () => {},
      info: () => {},
      warn: () => {},
      error: () => {},
    },
    budget: DEFAULT_TURN_TOKEN_BUDGET,
    deliverPreview,
    logAndReturn: (_name: string, data: object) => JSON.stringify(data),
    toolError: (_name: string, error: unknown) => {
      throw error;
    },
  } as unknown as ToolServices;
  return { session, services, deliverPreview };
}

function world(cs: boolean) {
  const id = (name: string) => normalizeName(`dbo.${name}`, cs);
  const origin = id('Report'),
    source = id('Source'),
    sibling = id('Sibling');
  const model = buildModel(
    [
      {
        fullName: '[dbo].[Report]',
        type: 'view',
        bodyScript: 'SELECT Value FROM dbo.Source',
        columns: [{ name: 'Value', type: 'int', nullable: 'NULL', extra: '' }],
      },
      { fullName: '[dbo].[Source]', type: 'table' },
      { fullName: '[dbo].[Sibling]', type: 'table' },
    ],
    [],
    undefined,
    undefined,
    true,
    undefined,
    cs,
  );
  return {
    ...completedWorld(model, {
      nodeIds: [origin, source, sibling],
      edges: [
        [source, origin, 'read'],
        [sibling, origin, 'read'],
      ],
      source: 'blackboard',
      originNodeId: origin,
    }),
    model,
    origin,
    source,
    sibling,
  };
}

function ctWorld() {
  const id = (name: string) => normalizeName(`dbo.${name}`, false);
  const origin = id('Report'),
    source = id('Source');
  const model = buildModel(
    [
      {
        fullName: '[dbo].[Report]',
        type: 'view',
        bodyScript: 'SELECT Amount AS Value FROM dbo.Source',
        columns: [{ name: 'Value', type: 'int', nullable: 'NULL', extra: '' }],
      },
      { fullName: '[dbo].[Source]', type: 'table' },
    ],
    [],
    undefined,
    undefined,
    true,
    undefined,
    false,
  );
  const edge = {
    hop_node: origin,
    hop: 1,
    from_node: source,
    from_col: 'Amount',
    to_node: origin,
    to_col: 'Value',
  } as ColumnEdge;
  const { services } = completedWorld(model, {
    nodeIds: [origin, source],
    edges: [[source, origin, 'read']],
    source: 'column_trace',
    originNodeId: origin,
    columnAspect: { edges: [edge] },
  });
  return { services, origin, source };
}

function firstCall(origin: string) {
  return {
    name: 'Report column lineage',
    summary: 'Report.Value from Source.Amount.',
    is_update: true,
    sections: [
      { label: 'Report', node_ids: [origin], text: 'Value is Source.Amount.' },
    ],
    highlight_groups: [
      { label: 'Origin', color: 'target', node_ids: [origin] },
    ],
  };
}

it.each([false, true])(
  'stages accepted node choices and keeps the held report (repeat fault=%s)',
  async (repeatFault) => {
    const { session, services, origin, source, sibling, deliverPreview } =
      world(false);
    const input = {
      ...firstCall(origin),
      sections: [
        {
          label: 'Known',
          node_ids: [origin, source, sibling],
          text: 'All known objects.',
        },
        {
          label: 'Unknown',
          node_ids: ['dbo.missing'],
          text: 'A rejected link.',
        },
      ],
    };
    const rejected = JSON.parse(await executePresentResult(input, services));
    expect(rejected.code).toBe('invalid_input');
    const first = renderProblem(rejected, 1);
    expect(first, 'D-102: the sent id is not echoed').not.toContain(
      'dbo.missing',
    );
    expect(shownErrors(first)).toContainEqual(
      expect.objectContaining({ path: 'sections.1.node_ids.0' }),
    );
    expect(JSON.parse(first)).toMatchObject({ resend: ['sections'] });
    expect(first).not.toContain('Accepted ids');
    expect(first).not.toContain(source);
    expect(first).not.toContain(sibling);
    const repeated = repeatFault
      ? JSON.parse(
          await executePresentResult({ sections: input.sections }, services),
        )
      : rejected;
    expect(repeated.code).toBe('invalid_input');
    expect(shownErrors(renderProblem(repeated, 2))).toContainEqual(
      expect.objectContaining({
        path: 'sections.1.node_ids.0',
        allowed: [origin, sibling, source].sort(),
      }),
    );
    expect(deliverPreview).not.toHaveBeenCalled();
    expect(session.presentResultRepairDraft.get()?.sections).toBeUndefined();
    expect(
      JSON.parse(
        await executePresentResult(
          {
            sections: input.sections.map((section) =>
              section.label === 'Unknown'
                ? { ...section, node_ids: [] }
                : section,
            ),
          },
          services,
        ),
      ).success,
    ).toBe(true);
    expect(session.presentationArtifact?.aiMetadata.description).toContain(
      'All known objects.',
    );
    expect(session.presentationArtifact?.aiMetadata.description).toContain(
      'A rejected link.',
    );
  },
);

it.each([false, true])(
  'accepts a section correction with held presentation fields resent (D-098, repeat full=%s)',
  async (repeatFull) => {
    const { session, services, origin, source, sibling, deliverPreview } =
      world(false);
    const original = {
      ...firstCall(origin),
      title: 'Held title',
      sections: [
        {
          label: 'Known',
          node_ids: [origin, source, sibling],
          text: 'Held known body.',
        },
        {
          label: 'Unknown',
          node_ids: ['dbo.missing'],
          text: 'Held rejected-link body.',
        },
      ],
    };
    expect(
      JSON.parse(await executePresentResult(original, services)).code,
    ).toBe('invalid_input');
    const correction = {
      sections: original.sections.map((section) =>
        section.label === 'Unknown' ? { ...section, node_ids: [] } : section,
      ),
    };
    const resent = repeatFull
      ? {
          summary: original.summary,
          title: original.title,
          name: original.name,
          is_update: true,
        }
      : {};
    expect(
      JSON.parse(
        await executePresentResult({ ...correction, ...resent }, services),
      ).success,
    ).toBe(true);
    expect(deliverPreview).toHaveBeenCalledOnce();
    expect(session.presentationArtifact?.name).toBe(original.name);
    expect(session.presentationArtifact?.aiMetadata.summary).toBe(
      original.summary,
    );
    expect(session.presentationArtifact?.aiMetadata.description).toContain(
      original.title,
    );
    expect(session.presentationArtifact?.aiMetadata.description).toContain(
      'Held known body.',
    );
    expect(session.presentationArtifact?.aiMetadata.description).toContain(
      'Held rejected-link body.',
    );
  },
);

it('stages committed section choices after first feedback and keeps a call without sections acceptable', async () => {
  const { session, services, origin, source, sibling } = world(false);
  session.explorationRunId = 'staging-amend';
  const original = {
    ...firstCall(origin),
    sections: [
      {
        label: 'Committed sources sentinel',
        node_ids: [origin, source, sibling],
        text: 'The committed body.',
      },
    ],
  };
  expect(
    JSON.parse(await executePresentResult(original, services)).success,
  ).toBe(true);
  const rejected = JSON.parse(
    await executePresentResult(
      {
        ...firstCall(origin),
        sections: [{ label: 'New label', node_ids: [' '] }],
      },
      services,
    ),
  );
  const first = renderProblem(rejected, 1);
  expect(first, 'D-102: the sent label is not echoed').not.toContain(
    'New label',
  );
  expect(rejected.errors).toContainEqual(
    expect.objectContaining({
      path: 'sections.0.label',
      code: 'uncommitted_label',
    }),
  );
  expect(first).not.toContain('Committed sources sentinel');
  expect(shownErrors(renderProblem(rejected, 2))).toContainEqual(
    expect.objectContaining({
      path: 'sections.0.label',
      allowed: ['Committed sources sentinel'],
    }),
  );
  expect(JSON.parse(await executePresentResult({}, services)).success).toBe(
    true,
  );
  expect(session.presentationArtifact?.aiMetadata.description).toContain(
    'The committed body.',
  );
});

it.each(['Missing', 42])(
  'holds a preview with start %j and repairs only that field through the handler',
  async (start) => {
    const { session, services, origin, source, deliverPreview } = world(false);
    session.activeLmStage = { kind: 'visual_preview' };
    session.lastDiscoveryAnswer =
      'Price report.\n\nSource prices feed the report.';
    session.storeDiscoveryScope(
      {
        turnEpoch: session.turnEpoch,
        origin,
        direction: 'upstream',
        nodeIds: [origin, source],
        edges: [[source, origin, 'read']],
      },
      session.turnEpoch,
    );
    const raw = {
      name: 'Price lineage',
      sections: [{ label: 'Prices', node_ids: [origin, source], start }],
      highlight_groups: [
        { label: 'Output', color: 'target', node_ids: [origin] },
      ],
    };
    const rejected = JSON.parse(await executePresentResult(raw, services));
    expect(rejected).toMatchObject({
      code: 'invalid_input',
      issuePaths: ['sections.0.start'],
    });
    expect(rejected).not.toHaveProperty('missingParts');
    expect(session.presentResultRepairDraft.get()?.sections).toBeUndefined();
    expect(deliverPreview).not.toHaveBeenCalled();
    const held = structuredClone(session.presentResultRepairDraft.get());
    expect(
      JSON.parse(
        await executePresentResult(
          { sections: [{ ...raw.sections[0], start: 'B99' }] },
          services,
        ),
      ),
    ).toHaveProperty('code', 'invalid_input');
    expect(session.presentResultRepairDraft.get()).toEqual(held);
    const empty = JSON.parse(await executePresentResult({}, services));
    expect(empty.resend).toEqual(['sections']);
    expect(session.presentResultRepairDraft.get()).toEqual(held);
    const repaired = JSON.parse(
      await executePresentResult(
        { sections: [{ ...raw.sections[0], start: 'B1' }] },
        services,
      ),
    );
    expect(repaired).toMatchObject({ success: true });
    expect(deliverPreview).toHaveBeenCalledOnce();
    expect(session.presentationArtifact?.aiMetadata.description).toContain(
      'Source prices feed the report.',
    );
  },
);

it('states each out-of-order preview start at its own start path without echoing a label or start (D-102)', async () => {
  const { session, services, origin, source, deliverPreview } = world(false);
  session.activeLmStage = { kind: 'visual_preview' };
  session.lastDiscoveryAnswer =
    'Price report.\n\nSource prices feed the report.\n\nThe report sums them.\n\nTotals close it.';
  session.storeDiscoveryScope(
    {
      turnEpoch: session.turnEpoch,
      origin,
      direction: 'upstream',
      nodeIds: [origin, source],
      edges: [[source, origin, 'read']],
    },
    session.turnEpoch,
  );
  const rejected = JSON.parse(
    await executePresentResult(
      {
        name: 'Price lineage',
        highlight_groups: [
          { label: 'Output', color: 'target', node_ids: [origin] },
        ],
        sections: [
          { label: 'AlphaSentinel', node_ids: [origin], start: 'B1' },
          { label: 'BetaSentinel', node_ids: [source], start: 'B3' },
          { label: 'GammaSentinel', node_ids: [origin], start: 'B2' },
          { label: 'DeltaSentinel', node_ids: [source], start: 'B2' },
        ],
      },
      services,
    ),
  );
  expect(deliverPreview).not.toHaveBeenCalled();
  for (const stage of [1, 2, 3] as const) {
    const shown = renderProblem(
      rejected,
      stage,
      undefined,
      'presentation_commit',
    );
    expect(
      shownErrors(shown)
        .filter((error) => error.path !== '')
        .map((error) => error.path),
    ).toEqual(['sections.2.start', 'sections.3.start']);
    expect(shown, 'D-102: no echoed label').not.toContain('Sentinel');
    expect(shown, 'D-102: no echoed start').not.toMatch(/\bB[23]\b/);
  }
});

it('revalidates duplicate labels on a whole section replacement (D-101)', async () => {
  const { session, services, origin, source, sibling, deliverPreview } =
    world(false);
  const input = {
    ...firstCall(origin),
    sections: [
      { label: '', node_ids: [origin], text: 'The report body stays held.' },
      { label: 'Other', node_ids: [], text: 'The other body stays held.' },
    ],
  };
  const first = JSON.parse(await executePresentResult(input, services));
  expect(first.issuePaths).toContain('sections.0.label');
  const rejected = JSON.parse(
    await executePresentResult(
      {
        sections: input.sections.map((section, index) =>
          index === 0 ? { ...section, label: 'Other' } : section,
        ),
      },
      services,
    ),
  );
  expect(rejected).toMatchObject({ code: 'invalid_input' });
  expect(rejected.errors).toEqual([
    expect.objectContaining({ path: 'sections.1.label', code: 'duplicate' }),
    {
      path: 'sections.*.node_ids',
      code: 'node_unexplained',
      values: [source, sibling],
    },
  ]);
  expect(rejected.resend).toEqual(['sections', 'notes']);
  expect(session.presentResultRepairDraft.get()?.sections).toBeUndefined();
  expect(deliverPreview).not.toHaveBeenCalled();
  expect(
    JSON.parse(
      await executePresentResult(
        {
          sections: [
            {
              ...input.sections[0],
              label: 'Report',
              node_ids: [origin, source, sibling],
            },
            input.sections[1],
          ],
        },
        services,
      ),
    ),
  ).toHaveProperty('success', true);
  expect(deliverPreview).toHaveBeenCalledOnce();
});

it.each([null, []])(
  'requests one complete resend when no report draft can be held: %j',
  async (input) => {
    const { session, services, deliverPreview } = world(false);
    const rejected = JSON.parse(await executePresentResult(input, services));
    expect(rejected.code).toBe('invalid_input');
    // Nothing is held, so nothing is narrowed: no resend list and no held-draft instruction.
    expect(rejected.resend ?? []).toEqual([]);
    expect(rejected.hint ?? '').not.toContain('only these corrected fields');
    expect(session.presentResultRepairDraft.get()).toBeNull();
    expect(deliverPreview).not.toHaveBeenCalled();
  },
);

describe.each([false, true])('result origin closure (CS=%s)', (cs) => {
  it('rejects removing a connector while retaining the origin without delivering islands', async () => {
    const { session, services, deliverPreview, origin, source, sibling } =
      world(cs);
    session.resultGraph!.edges = [
      [source, origin, 'read'],
      [sibling, source, 'read'],
    ];
    const before = structuredClone(session.resultGraph);
    const result = JSON.parse(
      await executePresentResult(
        {
          name: 'Report lineage',
          summary: 'Report sources.',
          is_update: true,
          prune_node_ids: [source],
          sections: [
            {
              label: 'Sources',
              node_ids: [origin, sibling],
              text: 'Recorded report sources.',
            },
          ],
          highlight_groups: [
            { label: 'Origin', color: 'target', node_ids: [origin] },
          ],
        },
        services,
      ),
    );
    expect(result).toMatchObject({ code: 'invalid_input' });
    expect(result.errors).toContainEqual({
      path: '',
      code: 'disconnects_view',
    });
    expect(result.reason, 'D-102: no echoed id').not.toContain(sibling);
    expect(session.resultGraph).toEqual(before);
    expect(deliverPreview).not.toHaveBeenCalled();
  });

  it.each(['origin', 'all'] as const)(
    'rejects pruning %s atomically and permits a connected retry',
    async (selection) => {
      const { session, services, deliverPreview, origin, source, sibling } =
        world(cs);
      const before = structuredClone(session.resultGraph);
      const result = JSON.parse(
        await executePresentResult(
          {
            name: 'Report lineage',
            summary: 'Report sources.',
            is_update: true,
            prune_node_ids:
              selection === 'all' ? [origin, source, sibling] : [origin],
            sections: [
              {
                label: 'Sources',
                node_ids: selection === 'all' ? [] : [source, sibling],
                text: 'Recorded report sources.',
              },
            ],
            highlight_groups: [
              { label: 'Origin', color: 'target', node_ids: [origin] },
            ],
          },
          services,
        ),
      );
      expect(result).toMatchObject({ code: 'invalid_input' });
      expect(result.errors).toContainEqual({
        path: 'prune_node_ids',
        code: 'prunes_origin',
      });
      expect(result.reason, 'D-102: no echoed id').not.toContain(origin);
      expect(session.resultGraph).toEqual(before);
      expect(session.presentationArtifact).toBeNull();
      expect(deliverPreview).not.toHaveBeenCalled();
      const corrected = JSON.parse(
        await executePresentResult(
          {
            name: 'Report lineage',
            summary: 'Report sources.',
            is_update: true,
            prune_node_ids: [sibling],
            sections: [
              {
                label: 'Sources',
                node_ids: [origin, source],
                text: 'Source supplies the report.',
              },
            ],
            highlight_groups: [
              { label: 'Origin', color: 'target', node_ids: [origin] },
            ],
          },
          services,
        ),
      );
      expect(corrected.success).toBe(true);
      expect(session.resultGraph?.nodeIds).toEqual([origin, source]);
      expect(deliverPreview).toHaveBeenCalledTimes(1);
    },
  );

  it.each([undefined, false] as const)(
    'commits a completed-phase prune with is_update=%s so the next render keeps it pruned',
    async (isUpdate) => {
      const { session, services, deliverPreview, origin, source, sibling } =
        world(cs);
      const render = (extra: Record<string, unknown>) =>
        executePresentResult(
          {
            name: 'Report lineage',
            summary: 'Report sources.',
            sections: [
              {
                label: 'Sources',
                node_ids: [origin, source],
                text: 'Source supplies the report.',
              },
            ],
            highlight_groups: [
              { label: 'Origin', color: 'target', node_ids: [origin] },
            ],
            ...extra,
          },
          services,
        ).then((out) => JSON.parse(out));
      const first = await render({
        prune_node_ids: [sibling],
        ...(isUpdate === undefined ? {} : { is_update: isUpdate }),
      });
      expect(first.success).toBe(true);
      expect(first.node_count).toBe(2);
      expect(session.resultGraph?.nodeIds).toEqual([origin, source]);
      expect(session.resultGraph?.edges).toEqual([[source, origin, 'read']]);
      const second = await render({});
      expect(second.success).toBe(true);
      expect(second.node_count).toBe(2);
      expect(deliverPreview).toHaveBeenLastCalledWith(
        expect.objectContaining({ nodeIds: [origin, source] }),
      );
    },
  );

  it('commits a completed-phase add without is_update so the next render keeps the added node', async () => {
    const {
      session,
      services,
      deliverPreview,
      model,
      origin,
      source,
      sibling,
    } = world(cs);
    model.edges.push(
      { source, target: origin, type: 'body' },
      { source: sibling, target: origin, type: 'body' },
    );
    session.resultGraph!.nodeIds = [origin, source];
    session.resultGraph!.edges = [[source, origin, 'read']];
    const render = (extra: Record<string, unknown>) =>
      executePresentResult(
        {
          name: 'Report lineage',
          summary: 'Report sources.',
          sections: [
            {
              label: 'Sources',
              node_ids: [origin, source, sibling],
              text: 'Source and sibling supply the report.',
            },
          ],
          highlight_groups: [
            { label: 'Origin', color: 'target', node_ids: [origin] },
          ],
          ...extra,
        },
        services,
      ).then((out) => JSON.parse(out));
    const first = await render({ add_node_ids: [sibling] });
    expect(first).toMatchObject({ success: true });
    expect(session.resultGraph?.nodeIds).toEqual([origin, source, sibling]);
    const second = await render({});
    expect(second.success).toBe(true);
    expect(deliverPreview).toHaveBeenLastCalledWith(
      expect.objectContaining({
        nodeIds: expect.arrayContaining([origin, source, sibling]),
      }),
    );
  });
});

it('rejects a whitespace-only amendment section instead of restoring the committed body', async () => {
  const { session, services, origin, source, sibling } = world(false);
  session.explorationRunId = 'run-amend';
  const committedText = 'Source supplies the report.';
  const first = JSON.parse(
    await executePresentResult(
      {
        name: 'Report lineage',
        summary: 'Report sources.',
        sections: [
          {
            label: 'Sources',
            node_ids: [origin, source, sibling],
            text: committedText,
          },
        ],
        highlight_groups: [
          { label: 'Origin', color: 'target', node_ids: [origin] },
        ],
      },
      services,
    ),
  );
  expect(first, JSON.stringify(first)).toMatchObject({ success: true });
  const before = structuredClone(session.resultGraph);
  const amended = JSON.parse(
    await executePresentResult(
      {
        name: 'Report lineage',
        summary: 'Rewritten summary.',
        is_update: true,
        sections: [
          {
            label: 'Sources',
            node_ids: [origin, source, sibling],
            text: '   ',
          },
        ],
        highlight_groups: [
          { label: 'Origin', color: 'target', node_ids: [origin] },
        ],
      },
      services,
    ),
  );
  expect({
    success: amended.success,
    code: amended.code,
    summary: session.resultGraph?.summary,
    text: session.resultGraph?.sections?.map((section) => section.text),
  }).toEqual({
    success: undefined,
    code: expect.any(String),
    summary: 'Report sources.',
    text: [committedText],
  });
  expect(session.resultGraph).toEqual(before);
});

describe('CT chain-coverage rejection', () => {
  it('names sections and notes as the repair fields, never highlight_groups', async () => {
    const { services, origin, source } = ctWorld();
    const result = JSON.parse(
      await executePresentResult(firstCall(origin), services),
    );
    expect(result).toMatchObject({ code: 'invalid_input' });
    expect(result).not.toHaveProperty('missingParts');
    expect(result.errors).toContainEqual({
      path: 'sections.*.node_ids',
      code: 'node_unexplained',
      values: [source],
    });
    expect(result.resend).toEqual(['sections', 'notes']);
  });

  it('a new section without text keeps the held draft and repeats the first repair mode, not a full resend', async () => {
    const { services, origin, source } = ctWorld();
    const first = JSON.parse(
      await executePresentResult(firstCall(origin), services),
    );
    const session = services.getSession();
    expect(session.presentResultRepairDraft.get()?.sections).toHaveLength(1);

    const textless = {
      sections: [{ label: 'Upstream: Staging', node_ids: [source] }],
      notes: [{ node_id: origin, caption: 'Report view.' }],
    };
    const second = JSON.parse(await executePresentResult(textless, services));
    const third = JSON.parse(await executePresentResult(textless, services));

    for (const rejected of [second, third]) {
      expect(rejected).toMatchObject({
        code: 'invalid_input',
        issuePaths: ['sections.0.text'],
      });
      expect(rejected.errors).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ path: 'sections.0.text', code: 'missing' }),
        ]),
      );
      expect(
        JSON.stringify(rejected),
        'D-102: the sent label is not echoed',
      ).not.toContain('Upstream: Staging');
      expect(rejected).toMatchObject({ resend: ['sections'] });
    }
    expect(renderProblem(second, 2)).toBe(renderProblem(third, 2));
    expect(first.resend).toEqual(['sections', 'notes']);
    expect(session.presentResultRepairDraft.get()?.sections).toHaveLength(1);
  });

  it('the repair both hints permit is accepted: the missing id under one notes entry', async () => {
    const { services, origin, source } = ctWorld();
    await executePresentResult(firstCall(origin), services);
    const repaired = JSON.parse(
      await executePresentResult(
        {
          notes: [
            { node_id: source, caption: 'Holds the traced Amount column.' },
          ],
        },
        services,
      ),
    );
    expect(repaired).toMatchObject({ success: true });
  });
});

it('retains frozen asked columns from the completed engine through result storage and the preview artifact', async () => {
  const origin = normalizeName('dbo.Target', false);
  const model = buildModel(
    [
      {
        fullName: '[dbo].[Target]',
        type: 'table',
        columns: ['Value', 'Unmapped'].map((name) => ({
          name,
          type: 'int',
          nullable: 'NULL',
          extra: '',
        })),
      },
    ],
    [],
  );
  const engine = new NavigationEngine(
    model,
    buildGraphologyGraph(model),
    () => {},
    {},
  );
  expect(
    engine.init({
      origin,
      question: 'Trace Value and Unmapped.',
      direction: 'upstream',
      analysisMode: 'ct',
      targetColumns: ['Value', 'Unmapped'],
      depthIntent: {
        upstream: { levels: 'all', exactness: 'exact' },
        downstream: { levels: 0, exactness: 'exact' },
      },
    }),
  ).toEqual({ ok: true });
  engine.getHopContext();
  const fullResult = engine.getResult();
  const { session, services } = completedWorld(model, {
    nodeIds: [],
    edges: [],
    source: 'column_trace',
  });
  session.stateMachine = engine;
  session.storeSmResult(fullResult, session.turnEpoch);
  const expected = { node: origin, columns: ['Value', 'Unmapped'] };
  expect(session.resultGraph?.columnAspect).toEqual({
    edges: [],
    requested: expected,
  });
  const answer = JSON.parse(
    await executePresentResult(
      {
        name: 'Asked columns',
        summary: 'No accepted value mappings.',
        sections: [
          {
            label: 'Target',
            node_ids: [origin],
            text: 'No value source was mapped.',
          },
        ],
        highlight_groups: [
          { label: 'Target', color: 'target', node_ids: [origin] },
        ],
      },
      services,
    ),
  );
  expect(answer).toMatchObject({ success: true });
  expect(session.presentationArtifact?.aiMetadata.columnAspect).toEqual({
    edges: [],
    requested: expected,
  });
  expect(session.presentationArtifact?.aiMetadata.description).toContain(
    '## Column Chain',
  );
  expect(session.presentationArtifact?.aiMetadata.description).toContain(
    '`' + origin + '.Value`',
  );
  expect(session.presentationArtifact?.aiMetadata.description).toContain(
    '`' + origin + '.Unmapped`',
  );
  expect(fullResult.columnAspect?.target_columns).toEqual([
    'Value',
    'Unmapped',
  ]);
  expect(session.resultGraph?.columnAspect?.requested?.columns).not.toBe(
    fullResult.columnAspect?.target_columns,
  );
  expect(
    session.presentationArtifact?.aiMetadata.columnAspect?.requested?.columns,
  ).not.toBe(session.resultGraph?.columnAspect?.requested?.columns);
});

it('requires sections[].node_ids only for analyzed SQL hops and accepts notes[] for an unvisited passthrough table', async () => {
  const writer = normalizeName('dbo.Writer', false);
  const carrier = normalizeName('dbo.Carrier', false);
  const reader = normalizeName('dbo.Reader', false);
  const model = buildModel(
    [
      {
        fullName: '[dbo].[Writer]',
        type: 'procedure',
        bodyScript: 'INSERT dbo.Carrier(Value) SELECT 1;',
      },
      {
        fullName: '[dbo].[Carrier]',
        type: 'table',
        columns: [{ name: 'Value', type: 'int', nullable: 'NULL', extra: '' }],
      },
      {
        fullName: '[dbo].[Reader]',
        type: 'view',
        bodyScript: 'SELECT Value FROM dbo.Carrier;',
        columns: [{ name: 'Value', type: 'int', nullable: 'NULL', extra: '' }],
      },
    ],
    [],
  );
  model.edges = [
    { source: writer, target: carrier, type: 'body' },
    { source: carrier, target: reader, type: 'body' },
  ];
  const engine = new NavigationEngine(
    model,
    buildGraphologyGraph(model),
    () => {},
    {},
  );
  engine.classification = 'technical';
  expect(
    engine.init({
      origin: reader,
      question: 'How is Value loaded into Reader?',
      direction: 'upstream',
      analysisMode: 'bb',
      depthIntent: {
        upstream: { levels: 'all', exactness: 'exact' },
        downstream: { levels: 0, exactness: 'exact' },
      },
    }),
  ).toEqual({ ok: true });
  expect(engine.getHopContext()).toMatchObject({ focus_node: { id: reader } });
  expect(
    engine.submitFindings({
      focus_node_id: reader,
      summary: 'Reads Value from Carrier.',
      sections: [
        { angle: 'technical', text: 'Reader selects Value from Carrier.' },
      ],
      questions: [{ nodeId: carrier, question: 'What loads Carrier?' }],
    }),
  ).toHaveProperty('ok', true);
  expect(engine.getHopContext()).toMatchObject({ focus_node: { id: writer } });
  expect(
    engine.submitFindings({
      focus_node_id: writer,
      summary: 'Inserts Value into Carrier.',
      sections: [
        { angle: 'technical', text: 'Writer inserts Value into Carrier.' },
      ],
      questions: [],
    }),
  ).toHaveProperty('ok', true);
  expect(engine.getHopContext()).toMatchObject({ done: true });
  const fullResult = engine.getResult();
  expect(fullResult.detail_slots.map((s) => s.nodeId)).toEqual([
    reader,
    writer,
  ]);
  const { session, services, deliverPreview } = completedWorld(model, {
    nodeIds: [],
    edges: [],
    source: 'blackboard',
  });
  (session as { memory: AiSession['memory'] }).memory = (
    engine as unknown as { memory: AiSession['memory'] }
  ).memory;
  session.stateMachine = engine;
  session.storeSmResult(fullResult, session.turnEpoch);
  const answer = JSON.parse(
    await executePresentResult(
      {
        name: 'Reader lineage',
        summary: 'Writer loads Carrier which feeds Reader.',
        sections: [
          {
            label: 'Reader',
            node_ids: [reader],
            text: 'Reader selects Value from Carrier.',
          },
          {
            label: 'Writer',
            node_ids: [writer],
            text: 'Writer inserts Value into Carrier.',
          },
        ],
        notes: [
          {
            node_id: carrier,
            caption: 'Passthrough table between Writer and Reader.',
          },
        ],
        highlight_groups: [
          { label: 'Origin', color: 'target', node_ids: [reader] },
        ],
      },
      services,
    ),
  );
  expect(answer).toMatchObject({ success: true });
  expect(deliverPreview).toHaveBeenCalledOnce();
});
