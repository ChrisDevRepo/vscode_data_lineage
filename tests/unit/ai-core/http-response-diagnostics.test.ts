/** HTTP diagnostics retain full malformed success bodies safely and preserve model-port outcomes. */
import { describe, expect, it } from 'vitest';
import { OpenAiCompatiblePort } from '../../harness/openAiCompatiblePort';
import type { WireRecord } from '../../../src/ai/observability/wireLog';

async function capture(body: string, contentType: string, verbose = true) {
  const records: WireRecord[] = [];
  let requests = 0;
  const port = new OpenAiCompatiblePort(
    { baseUrl: 'https://provider.invalid/v1', model: 'test-model', apiKey: 'canned-secret', laneId: 'test' },
    { traceVerbose: verbose, requestId: 'test-request', wireLog: (record) => records.push(record),
      fetchImpl: async () => {
        requests += 1;
        return { ok: true, status: 200, statusText: 'OK', text: async () => body,
          headers: { get: (name) => name === 'content-type' ? contentType : null } };
      } },
  );
  const result = await port.generateToolTurn({ messages: [], tools: [], phase: 'active' });
  return { result, records, requests };
}

describe('malformed successful HTTP diagnostics', () => {
  it('retains the complete malformed body and content type with credential redaction', async () => {
    const raw = `<html>canned-secret Bearer echoed-token ${'x'.repeat(6000)} END</html>`;
    const { result, records, requests } = await capture(raw, 'text/html; charset=utf-8');
    expect(result.status).toBe('error');
    if (result.status !== 'error') throw new Error('Expected provider error');
    expect(result.providerError.code).toBe('unsupported_response');
    expect(requests).toBe(1);
    const response = records.find((record) => record.type === 'provider-raw' && record.direction === 'response');
    expect(response).toMatchObject({ status: 200, contentType: 'text/html; charset=utf-8',
      body: raw.replace('canned-secret', '[redacted]').replace('Bearer echoed-token', 'Bearer [redacted]') });
    expect(JSON.stringify(response)).not.toContain('canned-secret');
    expect(JSON.stringify(response)).not.toContain('echoed-token');
  });
  it('keeps successful parsed JSON unchanged', async () => {
    const body = { choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: 'complete answer' } }] };
    const { result, records } = await capture(JSON.stringify(body), 'application/json');
    expect(result.status).toBe('completed');
    expect(records.find((record) => record.type === 'provider-raw' && record.direction === 'response'))
      .toMatchObject({ contentType: 'application/json', body });
  });
  it('retains a decoded JSON null as null rather than treating it as an absent body', async () => {
    const { records } = await capture('null', 'application/json');
    expect(records.find((record) => record.type === 'provider-raw' && record.direction === 'response'))
      .toMatchObject({ body: null });
  });
  it('does not emit raw bodies when verbose tracing is off', async () => {
    const { result, records } = await capture('not JSON', 'text/plain', false);
    expect(result.status).toBe('error');
    expect(records.some((record) => record.type === 'provider-raw')).toBe(false);
  });
});
