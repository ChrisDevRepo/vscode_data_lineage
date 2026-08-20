import { describe, expect, it } from 'vitest';
import { compileInstructionPlan } from '../../../src/ai/agent/instructionPlan';
import { modelUserMessage } from '../../../src/ai/model/modelPort';
import { collectingSink, scriptedRegistry } from './helpers/scriptedModelPort';

function registryFor(names: readonly string[]) {
  return scriptedRegistry(names.map(name => ({ name, result: '{}' }))).registry;
}

describe('compileInstructionPlan — provider tool choice', () => {
  it('uses the single required presentation tool for visual preview', () => {
    const registry = registryFor([
      'lineage_get_context',
      'lineage_search_objects',
      'lineage_get_scope_bundle',
      'lineage_present_result',
    ]);
    const { sink } = collectingSink();

    const plan = compileInstructionPlan({
      kind: 'converse',
      stage: { kind: 'visual_preview' },
      messages: [modelUserMessage('Show the lineage.')],
      registry,
      sink,
      toolChoice: 'required',
      requiredTerminalTool: 'lineage_present_result',
    });

    expect(plan.input.toolChoice).toBe('required');
    expect(plan.input.requiredTerminalTool).toBe('lineage_present_result');
    expect(plan.input.registry.getTools().map(tool => tool.name)).toEqual(['lineage_present_result']);
  });

  it('keeps provider required when the phase exposes only its terminal tool', () => {
    const registry = registryFor(['lineage_present_result']);
    const { sink } = collectingSink();

    const plan = compileInstructionPlan({
      kind: 'converse',
      stage: { kind: 'synthesis' },
      messages: [modelUserMessage('Present the result.')],
      registry,
      sink,
      toolChoice: 'required',
      requiredTerminalTool: 'lineage_present_result',
      facts: { analysisMode: 'bb', classification: 'technical' },
    });

    expect(plan.input.toolChoice).toBe('required');
  });

  it('projects the existing narrow repair schema during visual preview retries', () => {
    const registry = registryFor(['lineage_present_result']);
    const { sink } = collectingSink();

    const plan = compileInstructionPlan({
      kind: 'converse',
      stage: { kind: 'visual_preview' },
      messages: [modelUserMessage('Show the lineage.')],
      registry,
      sink,
      toolChoice: 'required',
      requiredTerminalTool: 'lineage_present_result',
      presentResultRepairFields: () => ['sections'] as const,
    });
    const schema = plan.input.registry.get('lineage_present_result')!.inputSchema;
    expect(schema.safeParse({ sections: [{ label: 'Flow', text: 'Exact source.' }] }).success).toBe(true);
    expect(schema.safeParse({ notes: [] }).success).toBe(false);
  });
});
