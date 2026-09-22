import { describe, expect, it } from 'vitest';
import { compileInstructionPlan } from '../../../src/ai/agent/instructionPlan';
import { modelUserMessage } from '../../../src/ai/model/modelPort';
import { DISCOVERY_SUMMARY_COMPOSE_SYSTEM_PROMPT } from '../../../src/ai/prompting/prompts';
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

  // VS Code LanguageModelChatToolMode.Required: "some models only support a single tool when
  // using this mode." Copilot Chat participants must send Auto when the hop exposes more than
  // one tool (official chat-sample: Required only after narrowing to one tool). The graph still
  // names requiredTerminalTool and retries a tool-less generation.
  it('demotes provider required to auto on an active hop with submit_findings plus neighbor lookup', () => {
    const registry = registryFor([
      'lineage_submit_findings',
      'lineage_get_neighbor_columns',
    ]);
    const { sink } = collectingSink();

    const plan = compileInstructionPlan({
      kind: 'converse',
      stage: { kind: 'active', mode: 'sm_bb' },
      messages: [modelUserMessage('Analyze the focus node.')],
      registry,
      sink,
      toolChoice: 'required',
      requiredTerminalTool: 'lineage_submit_findings',
      facts: { analysisMode: 'bb', classification: 'technical' },
    });

    expect(plan.input.toolChoice).toBe('auto');
    expect(plan.input.requiredTerminalTool).toBe('lineage_submit_findings');
    expect(plan.input.registry.getTools().map(tool => tool.name).sort()).toEqual([
      'lineage_get_neighbor_columns',
      'lineage_submit_findings',
    ]);
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

  it('the compose instruction plan carries a non-empty @lineage system prompt', () => {
    const plan = compileInstructionPlan({
      kind: 'text',
      phase: 'compose',
      system: DISCOVERY_SUMMARY_COMPOSE_SYSTEM_PROMPT,
      messages: [modelUserMessage('Compose the discovery summary.')],
    });

    expect(plan.input.system).toBeTruthy();
    expect(plan.input.system).toContain('@lineage');
  });
});
