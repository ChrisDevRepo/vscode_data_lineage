import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import * as vscode from 'vscode';
import { HumanMessage } from '@langchain/core/messages';
import { VscodeModelPort } from '../../../src/ai/model/vscodeModelPort';
import { StructuredOutputError } from '../../../src/ai/providers/structuredOutput';
import { toolCallNotationFault } from '../../../src/ai/support/toolCallNotation';

/** Pins the tool-call notation check: which values fault, the paths named and the repair stated. */
describe('toolCallNotationFault', () => {
  it.each([
    [{ summary: 'One sentence.</parameter>\n<parameter name="sections">{"business":"x"}' }, ['summary'],
      'End `summary` before the notation and send `sections` as its own argument.'],
    [{ summary: 'One sentence.</summary>\n<parameter name="sections">{"business":"x"}' }, ['summary'],
      'End `summary` before the notation and send `sections` as its own argument.'],
    [{ summary: 'One sentence.</parameter>\n<parameter name="sections">{"business":"x"}</parameter>\n<parameter name="prune_neighbors">[]' }, ['summary'],
      'End `summary` before the notation and send `sections` as its own argument.'],
    [{ sections: '{"business":"x"}</parameter>\n</invoke>\n' }, ['sections'],
      'Send `sections` as its own value only, without the notation.'],
    [{ sections: '\n<parameter name="text">Report body.' }, ['sections'],
      'Send `sections` as its own value only, without the notation.'],
    [{ sections: [{ label: 'A', text: 'Body.</parameter>\n<invoke name="other">' }] }, ['sections.0.text'],
      'Send `sections.0.text` as its own value only, without the notation.'],
  ])('faults %j at %j', (input, issuePaths, hint) => {
    const fault = toolCallNotationFault(input);
    expect(fault).toMatchObject({ issuePaths, hint });
    expect(fault!.reason).toBe(`${issuePaths[0]}: contains tool-call notation (\`<parameter name=…>\`, \`</parameter>\`, \`<invoke name=…>\`, \`</invoke>\`); a field holds its own value only.`);
  });

  it('names every offending value of one call', () => {
    const fault = toolCallNotationFault({ summary: 'A.</parameter> ', intro: 'B.</invoke> and more', title: 'Clean' });
    expect(fault!.issuePaths).toEqual(['summary', 'intro']);
    expect(fault!.reason.split('\n')).toHaveLength(2);
  });

  it.each([
    { summary: 'Keeps rows where Amount < Limit and Rate > 0.' },
    { summary: 'Renders <summary>Total</summary> in the HTML export.' },
    { sections: { technical: 'SELECT x.value(\'(/row/parameter)[1]\', \'int\') FROM @doc.nodes(\'/row\') AS t(x);' } },
    { ids: ['[dbo].[parameter]'], depth: 2, include_ddl: true, note: null },
    { sections: { technical: 'Builds <parameter>1</parameter><parameter>2</parameter> rows for the XML export.' } },
    { pattern: '</parameter> tag' },
  ])('accepts %j', input => {
    expect(toolCallNotationFault(input)).toBeNull();
  });
});

describe('structured output carrying tool-call notation', () => {
  it('is rejected with the field and the repair, never parsed', async () => {
    const sendRequest = vi.fn(async (_messages: unknown, options: { tools?: Array<{ name: string }> }) => ({
      stream: { async *[Symbol.asyncIterator]() {
        yield new vscode.LanguageModelToolCallPart('structured', options.tools![0].name, { route: 'trace</parameter>\n<parameter name="reason">Because.' });
      } },
    }));
    const port = new VscodeModelPort({ id: 'synthetic', name: 'synthetic', vendor: 'test', family: 'test', version: '1', maxInputTokens: 128000, countTokens: async () => 1, sendRequest } as never);
    const outcome = port.generateStructured({ messages: [new HumanMessage('classify')], schema: z.object({ route: z.string() }) });
    await expect(outcome).rejects.toBeInstanceOf(StructuredOutputError);
    await expect(outcome).rejects.toMatchObject({ hint: 'End `route` before the notation and send `reason` as its own argument.' });
  });
});
