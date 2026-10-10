/**
 * Pins the stage-replay test tool with a fake fetch and synthetic traces: substitution hit counts,
 * refusal before sending, key secrecy and redaction, legacy URL repair, transient retry, malformed
 * trace lines, and the provider-free screening export and reply check.
 */
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  SCREENING_REPLY_INSTRUCTION, applySubstitutions, checkReply, listGenerations, main, readRecordedRequests,
  replayUrl, renderScreeningPrompt, servedSystemText, type ChatBody, type ReplayDeps, type ReplayFetch, type ReplayResponse,
} from '../../tools/stageReplay';

const KEY = 'sk-test-SECRET-123456';

const TOOL = {
  type: 'function',
  function: {
    name: 'submit_findings',
    description: 'Commits this hop.',
    parameters: {
      type: 'object',
      properties: {
        focus_node_id: { type: 'string' },
        verdict: { type: 'string', enum: ['analyze', 'passthrough'] },
        columns: { type: 'array', items: { type: 'string' } },
      },
      required: ['focus_node_id', 'verdict'],
      additionalProperties: false,
    },
  },
};

function body(system: string, user: string): ChatBody {
  return {
    model: 'synthetic-model',
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: user },
      { role: 'assistant', content: '', tool_calls: [{ id: 'c1', type: 'function', function: { name: 'submit_findings', arguments: '{}' } }] },
      { role: 'tool', tool_call_id: 'c1', content: [{ type: 'text', text: 'Rejected: verdict missing.' }] },
    ],
    stream: false,
    tools: [TOOL],
    tool_choice: { type: 'function', function: { name: 'submit_findings' } },
  };
}

function request(generation: number, requestId: string, url: string, chat: ChatBody) {
  return JSON.stringify({ type: 'provider-raw', direction: 'request', requestId, generation, phase: 'active', url, method: 'POST', body: chat });
}

const HOP_USER = 'Task.\n{"focus_node": {"id": "[dbo].[Orders]", "s": 1}}\nAlways name the verdict.';

function traceText(url = 'https://provider.example/v1/chat/completions'): string {
  return [
    JSON.stringify({ type: 'trace-open', origin: 'headless-harness', verbose: true }),
    '{not json',
    '[1,2]',
    request(1, 'aaaa1111-req', url, body('Rule: always name the verdict.', 'Plain question.')),
    request(2, 'aaaa1111-req', url, body('Rule: always name the verdict.', HOP_USER)),
    JSON.stringify({ type: 'provider-raw', direction: 'request', requestId: 'broken', generation: 'x', url, body: {} }),
    '',
  ].join('\n');
}

function response(status: number, payload: unknown, retryAfter?: string): ReplayResponse {
  return {
    status,
    headers: { get: (name: string) => (name.toLowerCase() === 'retry-after' ? retryAfter ?? null : null) },
    text: async () => (typeof payload === 'string' ? payload : JSON.stringify(payload)),
  };
}

const OK_BODY = {
  choices: [{ finish_reason: 'tool_calls', message: { content: null, tool_calls: [{ id: 'x' }] } }],
  usage: { prompt_tokens: 10, completion_tokens: 2 },
};

let root: string;
let logs: string[];
let calls: Array<{ url: string; headers: Record<string, string>; body: string }>;
let sleeps: number[];

function deps(responses: Array<ReplayResponse | Error>, env: NodeJS.ProcessEnv = { AI_TEST_API_KEY: KEY }): ReplayDeps {
  const fetchImpl: ReplayFetch = async (url, init) => {
    calls.push({ url, headers: init.headers, body: init.body });
    const next = responses.shift();
    if (!next) throw new Error('unexpected request');
    if (next instanceof Error) throw next;
    return next;
  };
  let clock = 1_000;
  return {
    repoRoot: root, env, fetchImpl,
    sleep: async (ms) => { sleeps.push(ms); },
    now: () => (clock += 5),
    log: (line) => logs.push(line),
  };
}

function writeInputs(subs: unknown, trace = traceText()): void {
  writeFileSync(join(root, 'trace.ndjson'), trace);
  writeFileSync(join(root, 'subs.json'), JSON.stringify(subs));
}

function outputs(dir = join(root, 'test-results', 'replay')): Array<Record<string, any>> {
  return readdirSync(dir).sort().map((name) => JSON.parse(readFileSync(join(dir, name), 'utf8')));
}

const REPLAY = ['replay', '--trace', 'trace.ndjson', '--generation', '2', '--out', 'test-results/replay'];

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'stage-replay-'));
  logs = [];
  calls = [];
  sleeps = [];
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

describe('stage replay: trace reading and generation listing', () => {
  it('skips malformed lines and lists generations with phase, focus node and size', () => {
    const { requests, skipped } = readRecordedRequests(traceText());
    expect(skipped).toBe(3);
    const rows = listGenerations(requests);
    expect(rows.map((row) => [row.generation, row.phase, row.focusNode])).toEqual([[1, 'active', null], [2, 'active', '[dbo].[Orders]']]);
    expect(rows[1].requestChars).toBe(JSON.stringify(requests[1].body).length);
    expect(listGenerations(requests, 'focus_node').map((row) => row.generation)).toEqual([2]);
  });

  it('find reports rows and the skipped-line count', async () => {
    writeInputs([]);
    expect(await main(['find', '--trace', 'trace.ndjson', '--json'], deps([]))).toBe(0);
    const parsed = JSON.parse(logs[0]);
    expect(parsed.skippedLines).toBe(3);
    expect(parsed.rows).toHaveLength(2);
  });
});

describe('stage replay: substitutions', () => {
  it('counts every hit across string and content-part messages', () => {
    const { body: changed, applied } = applySubstitutions(body('verdict and verdict', 'verdict'), [
      { old: 'verdict', new: 'decision' },
      { old: 'Rejected', new: 'Refused' },
    ]);
    expect(applied).toEqual([{ old: 'verdict', hits: 4 }, { old: 'Rejected', hits: 1 }]);
    expect(changed.messages[0].content).toBe('decision and decision');
    expect(changed.messages[3].content).toEqual([{ type: 'text', text: 'Refused: decision missing.' }]);
  });

  it('refuses and sends nothing when one substitution text is absent', async () => {
    writeInputs([{ old: 'always name', new: 'name' }, { old: 'not in the prompt', new: 'x' }]);
    expect(await main([...REPLAY, '--subs', 'subs.json'], deps([response(200, OK_BODY)]))).toBe(4);
    expect(calls).toHaveLength(0);
    expect(logs.join('\n')).toContain('not in the prompt');
  });

  it('sends the substituted body and records hit counts per sample', async () => {
    writeInputs([{ old: 'always name', new: 'state' }]);
    const code = await main([...REPLAY, '--subs', 'subs.json', '--samples', '2', '--arm', 'edit-1'],
      deps([response(200, OK_BODY), response(200, OK_BODY)]));
    expect(code).toBe(0);
    expect(calls).toHaveLength(2);
    expect(calls[0].body).toContain('Rule: state the verdict.');
    const files = outputs();
    expect(files.map((file) => [file.arm, file.sample, file.status, file.toolCalls])).toEqual([['edit-1', 1, 200, 1], ['edit-1', 2, 200, 1]]);
    expect(files[0].substitutions).toEqual([{ old: 'always name', hits: 1 }]);
    expect(files[0].usage).toEqual(OK_BODY.usage);
    expect(files[0].request.focusNode).toBe('[dbo].[Orders]');
  });
});

describe('stage replay: secrets and URLs', () => {
  it('never writes or logs the key and redacts Bearer tokens in error bodies', async () => {
    writeInputs([]);
    const error = { error: { message: `bad auth: Bearer ${KEY} and Bearer other.token-value` } };
    expect(await main([...REPLAY, '--max-attempts', '1'], deps([response(401, error)]))).toBe(2);
    expect(calls[0].headers.authorization).toBe(`Bearer ${KEY}`);
    const written = readFileSync(join(root, 'test-results', 'replay', readdirSync(join(root, 'test-results', 'replay'))[0]), 'utf8');
    expect(written).not.toContain(KEY);
    expect(written).not.toContain('other.token-value');
    expect(written).toContain('Bearer [redacted]');
    expect(written.toLowerCase()).not.toContain('authorization');
    expect(logs.join('\n')).not.toContain(KEY);
  });

  it('uses the api-key header for the azure profile', async () => {
    writeInputs([]);
    await main(REPLAY, deps([response(200, OK_BODY)], { AI_TEST_API_KEY: KEY, AI_TEST_PROVIDER: 'azure' }));
    expect(calls[0].headers).toEqual({ 'content-type': 'application/json', 'api-key': KEY });
  });

  it('refuses to send without a key', async () => {
    writeInputs([]);
    expect(await main(REPLAY, deps([response(200, OK_BODY)], {}))).toBe(4);
    expect(calls).toHaveLength(0);
  });

  it('collapses a legacy doubled chat-completions suffix', async () => {
    expect(replayUrl('https://h.example/v1/chat/completions/chat/completions')).toEqual({
      url: 'https://h.example/v1/chat/completions', legacySuffixFixed: true,
    });
    writeInputs([], traceText('https://h.example/v1/chat/completions/chat/completions'));
    await main(REPLAY, deps([response(200, OK_BODY)]));
    expect(calls[0].url).toBe('https://h.example/v1/chat/completions');
    expect(outputs()[0].request.legacySuffixFixed).toBe(true);
  });

  it('refuses a non-HTTPS URL and an output directory outside test-results', async () => {
    expect(() => replayUrl('http://h.example/v1/chat/completions')).toThrow(/HTTPS/u);
    writeInputs([], traceText('http://h.example/v1/chat/completions'));
    expect(await main(REPLAY, deps([response(200, OK_BODY)]))).toBe(4);
    writeInputs([]);
    expect(await main([...REPLAY.slice(0, -1), 'docs/replay'], deps([response(200, OK_BODY)]))).toBe(4);
    expect(calls).toHaveLength(0);
  });
});

describe('stage replay: retry', () => {
  it('retries a 429 honoring Retry-After, then records the success', async () => {
    writeInputs([]);
    const code = await main(REPLAY, deps([response(429, 'slow down', '2'), response(200, OK_BODY)]));
    expect(code).toBe(0);
    expect(calls).toHaveLength(2);
    expect(sleeps).toEqual([2000]);
    expect(outputs()[0]).toMatchObject({ status: 200, attempts: 2 });
  });

  it('stops after max attempts on persistent 503 and reports failure', async () => {
    writeInputs([]);
    const code = await main([...REPLAY, '--max-attempts', '2'], deps([response(503, 'down'), response(503, 'down')]));
    expect(code).toBe(2);
    expect(outputs()[0]).toMatchObject({ status: 503, attempts: 2, response: 'down' });
  });
});

describe('screening bundle', () => {
  it('exports prompt.md and request.json without calling the provider', async () => {
    writeInputs([{ old: 'always name', new: 'state' }]);
    const code = await main([...REPLAY.slice(0, 5), '--subs', 'subs.json', '--export', 'test-results/bundle'], deps([], {}));
    expect(code).toBe(0);
    expect(calls).toHaveLength(0);
    const dir = join(root, 'test-results', 'bundle');
    const prompt = readFileSync(join(dir, 'prompt.md'), 'utf8');
    expect(prompt).toContain('## Message 1: system');
    expect(prompt).toContain('Rule: state the verdict.');
    expect(prompt).toContain('## Message 4: tool (result of call c1)');
    expect(prompt).toContain('Rejected: verdict missing.');
    expect(prompt).toContain('### submit_findings');
    expect(prompt).toContain('"enum"');
    expect(prompt.trimEnd().endsWith(SCREENING_REPLY_INSTRUCTION)).toBe(true);
    const saved = JSON.parse(readFileSync(join(dir, 'request.json'), 'utf8'));
    expect(saved.messages[0].content).toBe('Rule: state the verdict.');
    expect(JSON.stringify(saved)).not.toMatch(/authorization|api-key/iu);
    expect(readFileSync(join(dir, 'system.md'), 'utf8')).toBe('Rule: state the verdict.');
    const user = readFileSync(join(dir, 'user.md'), 'utf8');
    expect(user).not.toContain('## Message 1: system');
    expect(user).not.toContain('Rule: state the verdict.');
    expect(user).toContain('after your system prompt');
    expect(user).toContain('## Message 2: user');
    expect(user).toContain('## Message 4: tool (result of call c1)');
    expect(user.trimEnd().endsWith(SCREENING_REPLY_INSTRUCTION)).toBe(true);
    expect(JSON.parse(readFileSync(join(dir, 'bundle.json'), 'utf8'))).toMatchObject({ model: 'synthetic-model', reasoningEffort: null });
  });

  it('records the reasoning effort the replay would send', async () => {
    writeInputs([]);
    expect(await main([...REPLAY.slice(0, 5), '--export', 'test-results/bundle'], deps([], { AI_TEST_REASONING_EFFORT: 'low' }))).toBe(0);
    const manifest = JSON.parse(readFileSync(join(root, 'test-results', 'bundle', 'bundle.json'), 'utf8'));
    expect(manifest.reasoningEffort).toBe('low');
  });

  it('keeps the whole conversation in user.md when the body has no leading system message', () => {
    const chat = body('s', 'u');
    const noSystem: ChatBody = { ...chat, messages: chat.messages.slice(1) };
    expect(servedSystemText(noSystem)).toBe('');
    expect(renderScreeningPrompt(noSystem, { afterSystem: true })).toBe(renderScreeningPrompt(noSystem));
  });

  it('refuses an export whose substitution is absent', async () => {
    writeInputs([{ old: 'absent text', new: 'x' }]);
    expect(await main([...REPLAY.slice(0, 5), '--subs', 'subs.json', '--export', 'test-results/bundle'], deps([], {}))).toBe(4);
  });

  it('fences message text that itself contains a fence', () => {
    const prompt = renderScreeningPrompt(body('```sql\nSELECT 1\n```', 'q'));
    expect(prompt).toContain('````\n```sql');
  });

  const chat = body('s', 'u');

  it('accepts a valid reply, bare or inside a json fence', () => {
    const reply = '{"tool":"submit_findings","arguments":{"focus_node_id":"[dbo].[Orders]","verdict":"analyze"}}';
    expect(checkReply(reply, chat)).toMatchObject({ valid: true, errors: [], tool: 'submit_findings' });
    expect(checkReply(`Here it is:\n\`\`\`json\n${reply}\n\`\`\`\n`, chat).valid).toBe(true);
  });

  it('reads a json fence whose string values contain an escaped sql fence', () => {
    const reply = '{"tool":"submit_findings","arguments":{"focus_node_id":"[dbo].[Orders]","verdict":"analyze","columns":["```sql\\nSELECT 1\\n```"]}}';
    expect(checkReply(`\`\`\`json\n${reply}\n\`\`\``, chat)).toMatchObject({ valid: true, tool: 'submit_findings' });
  });

  it('rejects a malformed reply, an unknown tool and a schema violation', () => {
    expect(checkReply('I would call submit_findings.', chat)).toMatchObject({ valid: false, tool: null });
    expect(checkReply('{"tool":"drop_table","arguments":{}}', chat)).toMatchObject({ valid: false, errors: ['unknown tool drop_table'] });
    const violation = checkReply('{"tool":"submit_findings","arguments":{"focus_node_id":"x","verdict":"maybe","columns":[1]}}', chat);
    expect(violation.valid).toBe(false);
    expect(violation.errors.join('\n')).toMatch(/verdict/u);
    expect(violation.errors.join('\n')).toMatch(/columns\.0/u);
  });

  it('enforces a named tool choice even when another bundled tool has valid arguments', () => {
    const otherTool = { ...TOOL, function: { ...TOOL.function, name: 'other_tool' } };
    const multipleTools: ChatBody = { ...chat, tools: [TOOL, otherTool] };
    const reply = '{"tool":"other_tool","arguments":{"focus_node_id":"[dbo].[Orders]","verdict":"analyze"}}';
    expect(checkReply(reply, multipleTools)).toMatchObject({ valid: false, errors: ['tool_choice requires submit_findings'] });
    expect(checkReply(reply, { ...multipleTools, tool_choice: 'auto' }).valid).toBe(true);
  });

  it('rejects a tool call when tool_choice disables tools', () => {
    const reply = '{"tool":"submit_findings","arguments":{"focus_node_id":"[dbo].[Orders]","verdict":"analyze"}}';
    expect(checkReply(reply, { ...chat, tool_choice: 'none' })).toMatchObject({ valid: false, errors: ['tool_choice does not allow a tool call'] });
  });

  it('check writes check.json and exits 2 for an invalid reply', async () => {
    writeInputs([]);
    await main([...REPLAY.slice(0, 5), '--export', 'test-results/bundle'], deps([], {}));
    writeFileSync(join(root, 'reply.txt'), '{"tool":"submit_findings","arguments":{"verdict":"analyze"}}');
    expect(await main(['check', 'test-results/bundle', 'reply.txt'], deps([], {}))).toBe(2);
    const result = JSON.parse(readFileSync(join(root, 'test-results', 'bundle', 'check.json'), 'utf8'));
    expect(result).toMatchObject({ valid: false, tool: 'submit_findings', arguments: { verdict: 'analyze' } });
    expect(result.errors.join('\n')).toMatch(/focus_node_id/u);
  });
});
