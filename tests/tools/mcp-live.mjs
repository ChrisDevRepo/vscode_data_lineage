/**
 * Deep MCP server test against a LIVE Extension Development Host.
 *
 * Launches the `mcp-live` lane (tests/integration/mcp-live.test.ts) with the MCP server enabled in an
 * isolated user-data directory, then drives the server from this separate process with the official
 * MCP client SDK, exactly as an external MCP client would. It asserts the transport, authentication,
 * tool contracts, hand-off between tools, concurrency, cancellation, the stdio proxy, the VS Code
 * debug log and the server's lifecycle when the user toggles the setting, changes the port or
 * reloads the project.
 *
 * No model is involved and no network egress beyond `127.0.0.1`. The dataset is the public
 * AdventureWorks AI fixture; its expected facts come from `tests/fixtures/graph-baseline-aw.json`
 * and the expected tool list from the generated manifest in `package.json`, not from copies here.
 * Prerequisites and failure meanings: docs/EDH_TESTING.md and docs/testing/ENVIRONMENTS.md.
 * Host lifecycle and client helpers are shared with the facts toolbelt (tests/tools/mcp/).
 *
 * Usage: node tests/tools/mcp-live.mjs [--port N] [--only SUBSTRING]
 * Exit codes: 0 all cases passed, 1 a case failed, 4 prerequisite or host failure.
 */
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { JSON_RPC_HEADERS, call, connect, raw, readDiscovery, seenTokens } from './mcp/client.mjs';
import {
  DEFAULT_PORT, USER_DATA, WORK, fail4, finishHost, hostCommand, launchHost, prepare, root, waitFor, waitForReady,
} from './mcp/host.mjs';

const args = process.argv.slice(2);
const option = (name, fallback) => (args.includes(name) ? args[args.indexOf(name) + 1] : fallback);
const PORT = Number(option('--port', String(DEFAULT_PORT)));
const ONLY = option('--only', '');

// Single sources of truth: the generated tool manifest and the verified graph baseline.
const EXPECTED_TOOLS = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).contributes.languageModelTools.map((t) => t.name).sort();
const BASELINE = JSON.parse(readFileSync(join(root, 'tests/fixtures/graph-baseline-aw.json'), 'utf8'));
const KNOWN_ERROR_CODES = new Set(['not_found', 'invalid_input', 'over_discovery_budget']);

const assert = (condition, message) => { if (!condition) throw new Error(message); };
const equal = (actual, expected, label) => assert(actual === expected, `${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);

/** The extension's output-channel log in the isolated profile (newest session), or '' before it exists. */
function readExtensionLog() {
  const logsRoot = join(USER_DATA, 'logs');
  if (!existsSync(logsRoot)) return '';
  const find = (dir, depth) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isFile() && entry.name === 'Data Lineage Viz.log') return path;
      if (entry.isDirectory() && depth > 0) { const hit = find(path, depth - 1); if (hit) return hit; }
    }
    return undefined;
  };
  for (const session of readdirSync(logsRoot).sort().reverse()) {
    const hit = find(join(logsRoot, session), 5);
    if (hit) return readFileSync(hit, 'utf8');
  }
  return '';
}

// ───────────────────────────── the matrix ─────────────────────────────

const cases = [];
const test = (name, fn) => cases.push({ name, fn });

function defineCases(ctx) {
  const ids = { orders: '[ai].[spimportorders]' };
  const open = () => connect(readDiscovery(ctx.ready));

  test('discovery file is private, local and well formed', () => {
    const discovery = readDiscovery(ctx.ready);
    const url = new URL(discovery.url);
    equal(url.hostname, '127.0.0.1', 'discovery host');
    equal(url.pathname, '/mcp', 'discovery path');
    equal(Number(url.port), ctx.port, 'discovery port');
    assert(typeof discovery.token === 'string' && discovery.token.length >= 32, 'token must be at least 32 characters');
    if (process.platform !== 'win32') equal((statSync(ctx.ready.discoveryPath).mode & 0o777).toString(8), '600', 'discovery file mode');
  });

  test('server identifies itself and lists exactly the external tools with correct hints', async () => {
    const client = await open();
    try {
      equal(client.getServerVersion()?.name, 'data-lineage', 'server name');
      const { tools } = await client.listTools();
      equal(JSON.stringify(tools.map((t) => t.name).sort()), JSON.stringify(EXPECTED_TOOLS), 'tool names (manifest in package.json)');
      for (const tool of tools) {
        equal(tool.inputSchema.type, 'object', `${tool.name} schema type`);
        equal(tool.annotations?.readOnlyHint, tool.name !== 'lineage_present_result', `${tool.name} readOnlyHint`);
      }
      assert(!tools.some((t) => /submit_findings|start_exploration/.test(t.name)), 'hop tools must not be exposed');
    } finally { await client.close(); }
  });

  test('requests without valid credentials are refused with a bearer challenge', async () => {
    const discovery = readDiscovery(ctx.ready);
    const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' });
    const wrongSameLength = discovery.token.replace(/./g, (c, i) => (i === 0 ? (c === 'A' ? 'B' : 'A') : c));
    for (const [label, headers] of [
      ['no token', JSON_RPC_HEADERS()],
      ['wrong token', JSON_RPC_HEADERS('definitely-not-the-token')],
      ['wrong token of equal length', JSON_RPC_HEADERS(wrongSameLength)],
      ['basic scheme', { ...JSON_RPC_HEADERS(), authorization: `Basic ${Buffer.from(`u:${discovery.token}`).toString('base64')}` }],
    ]) {
      const r = await raw(ctx.port, { headers, body });
      equal(r.status, 401, `${label} status`);
      assert(/bearer/i.test(String(r.headers['www-authenticate'] ?? '')), `${label}: missing WWW-Authenticate challenge`);
    }
  });

  test('foreign Host and Origin headers are rejected before authentication is considered', async () => {
    const discovery = readDiscovery(ctx.ready);
    const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' });
    equal((await raw(ctx.port, { headers: { ...JSON_RPC_HEADERS(discovery.token), host: 'evil.example' }, body })).status, 403, 'foreign Host');
    equal((await raw(ctx.port, { headers: { ...JSON_RPC_HEADERS(discovery.token), origin: 'https://evil.example' }, body })).status, 403, 'foreign Origin');
  });

  test('unknown paths are 404 and an oversized body is refused', async () => {
    const discovery = readDiscovery(ctx.ready);
    equal((await raw(ctx.port, { path: '/other', headers: JSON_RPC_HEADERS(discovery.token), body: '{}' })).status, 404, 'unknown path');
    const huge = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'lineage_search_objects', arguments: { query: 'x'.repeat(2 * 1024 * 1024) } } });
    // fetch consumes the early 413 reply; a raw socket write would instead fail with EPIPE once the server hangs up.
    const oversized = await fetch(discovery.url, { method: 'POST', headers: JSON_RPC_HEADERS(discovery.token), body: huge });
    equal(oversized.status, 413, 'oversized body');
  });

  test('malformed JSON-RPC and unknown methods or tools get errors and the server keeps serving', async () => {
    const discovery = readDiscovery(ctx.ready);
    const bad = await raw(ctx.port, { headers: JSON_RPC_HEADERS(discovery.token), body: '{' });
    assert(bad.status >= 400 || /"error"/.test(bad.body), `malformed JSON must be an error, got ${bad.status}`);
    const unknown = await raw(ctx.port, { headers: JSON_RPC_HEADERS(discovery.token), body: JSON.stringify({ jsonrpc: '2.0', id: 7, method: 'nope/nothing' }) });
    assert(/"error"/.test(unknown.body) || unknown.status >= 400, 'unknown method must be an error');
    const client = await open();
    try {
      let rejected = false;
      try { rejected = (await call(client, 'lineage_does_not_exist', {})).isError; } catch { rejected = true; }
      assert(rejected, 'unknown tool must be refused');
      assert(!(await call(client, 'lineage_get_context', {})).isError, 'server must still answer afterwards');
    } finally { await client.close(); }
  });

  test('project facts match the verified AdventureWorks AI baseline', async () => {
    const client = await open();
    try {
      const context = await call(client, 'lineage_get_context', {});
      equal(context.json.project_name, BASELINE.model.replace(/\.dacpac$/, ''), 'project name');
      equal(context.json.model_stats.nodes, BASELINE.stats.nodes, 'node count');
      equal(context.json.model_stats.edges, BASELINE.stats.edges, 'edge count');
      equal(context.json.schemas.find((s) => s.name === 'ai')?.n, 32, 'objects in schema ai');
      equal((await call(client, 'lineage_get_screen_state', {})).json.screen.view.total_nodes, BASELINE.stats.nodes, 'screen total nodes');
    } finally { await client.close(); }
  });

  test('search, detail and DDL search return the known lineage', async () => {
    const client = await open();
    try {
      const found = await call(client, 'lineage_search_objects', { query: 'spImportOrders' });
      equal(found.json.total, 1, 'search total');
      equal(found.json.results[0].id, ids.orders, 'search result id');
      const detail = await call(client, 'lineage_get_object_detail', { id: ids.orders });
      equal(JSON.stringify(detail.json.up.map((n) => n.id).sort()), JSON.stringify(['[ai].[activeregions]', '[ai].[raworderimport]', '[ai].[vwexternalorders]']), 'upstream of spImportOrders');
      assert(detail.json.dn.some((n) => n.id === '[ai].[errorlog]'), 'ErrorLog must be downstream of spImportOrders');
      const ddl = await call(client, 'lineage_search_ddl', { query: 'ListPrice' });
      assert(ddl.json.results.some((r) => r.id === '[ai].[sprefreshprices]'), 'spRefreshPrices defines ListPrice');
      assert(ddl.json.results.some((r) => r.id === '[ai].[spbuildsalesreport]'), 'spBuildSalesReport mentions ListPrice');
    } finally { await client.close(); }
  });

  test('graph patterns agree with the verified baseline (top hub, cycles)', async () => {
    const client = await open();
    try {
      const hubs = await call(client, 'lineage_detect_graph_patterns', { type: 'hubs' });
      equal(hubs.json.groups[0].id, BASELINE.analysis.hubs.topId, 'top hub');
      equal(hubs.json.groups[0].meta.degree, BASELINE.analysis.hubs.topDegree, 'top hub degree');
      const cycles = await call(client, 'lineage_detect_graph_patterns', { type: 'cycles' });
      equal(cycles.json.groups.length, BASELINE.analysis.cycles.groupCount, 'cycle groups');
    } finally { await client.close(); }
  });

  test('error contracts: not found, invalid input and budget refusals use a known code and name the fault and the action', async () => {
    const client = await open();
    try {
      const missing = await call(client, 'lineage_get_object_detail', { id: '[ai].[doesnotexist]' });
      assert(missing.isError && KNOWN_ERROR_CODES.has(missing.code), 'unknown object must be a known error');
      equal(missing.code, 'not_found', 'not_found code');
      assert(EXPECTED_TOOLS.some((tool) => missing.text.includes(tool)), 'not_found hint must name a tool from the manifest');
      const invalid = await call(client, 'lineage_search_ddl', { pattern: 'ListPrice' });
      equal(invalid.code, 'invalid_input', 'invalid_input code');
      assert(/pattern/.test(invalid.text) && /query/.test(invalid.text), 'invalid_input hint must name the wrong and the expected field');
      const big = await call(client, 'lineage_get_scope_bundle', { origin: '[person].[person]', upstream_depth: 3, downstream_depth: 3, include_ddl: true });
      equal(big.code, 'over_discovery_budget', 'budget code');
      assert(/discoveryNodeCap/.test(big.text), 'budget hint must name the setting');
    } finally { await client.close(); }
  });

  test('scope hand-off: a scope bundle renders as a view and a view can be edited by id', async () => {
    const client = await open();
    try {
      const bundle = await call(client, 'lineage_get_scope_bundle', { origin: ids.orders, upstream_depth: 1, downstream_depth: 1, include_ddl: false });
      assert(!bundle.isError && /^scope-/.test(bundle.json.scope_id), 'bundle must return a scope_id');
      const nodeIds = bundle.json.nodes.map((n) => n.id);
      equal(nodeIds.length, 6, 'bundle node count');
      const render = (extra) => call(client, 'lineage_present_result', {
        name: 'import scope', summary: 'spImportOrders and its neighbours',
        highlight_groups: [{ label: 'origin', color: 'source', node_ids: [ids.orders] }],
        sections: [{ label: 'Import', node_ids: nodeIds, text: 'spImportOrders reads the external orders.' }],
        ...extra,
      });
      const first = await render({ scope_id: bundle.json.scope_id });
      assert(!first.isError, `render failed: ${first.text.slice(0, 200)}`);
      assert(/^view-/.test(first.json.view_id), 'render must return a view_id');
      equal(first.json.node_count, 6, 'rendered node count');
      equal(first.json.delivery, 'delivered', 'the view must reach the open panel');
      const pruned = await call(client, 'lineage_present_result', {
        view_id: first.json.view_id, prune_node_ids: ['[ai].[errorlog]'], name: 'import scope', summary: 'pruned',
        highlight_groups: [{ label: 'origin', color: 'source', node_ids: [ids.orders] }],
        sections: [{ label: 'Import', node_ids: nodeIds.filter((n) => n !== '[ai].[errorlog]'), text: 'ErrorLog removed.' }],
      });
      assert(!pruned.isError, `edit failed: ${pruned.text.slice(0, 200)}`);
      equal(pruned.json.node_count, 5, 'node count after prune');
      assert((await render({})).isError, 'a render with neither handle must be refused');
      assert((await render({ scope_id: 'scope-doesnotexist' })).isError, 'an unknown scope_id must be refused');
      assert((await render({ scope_id: bundle.json.scope_id, view_id: first.json.view_id })).isError, 'both handles must be refused');
    } finally { await client.close(); }
  });

  test('concurrent callers each get their own answer', async () => {
    const discovery = readDiscovery(ctx.ready);
    const clients = await Promise.all([connect(discovery), connect(discovery)]);
    try {
      const queries = ['spImportOrders', 'FactSalesReport', 'vwDiscountCalc', 'RawOrderImport', 'PriceMaster', 'DimCalendar', 'CustomerMaster', 'SalesStaging', 'vwPriceList', 'spCleanOrders'];
      const work = Array.from({ length: 20 }, (_, i) => ({ client: clients[i % 2], query: queries[i % queries.length] }));
      const results = await Promise.all(work.map((w) => call(w.client, 'lineage_search_objects', { query: w.query })));
      results.forEach((r, i) => {
        assert(!r.isError, `call ${i} failed`);
        assert(r.json.results.some((x) => x.n.toLowerCase() === work[i].query.toLowerCase()), `call ${i} returned another caller's answer for ${work[i].query}`);
      });
    } finally { await Promise.all(clients.map((c) => c.close())); }
  });

  test('an aborted call is cancelled on the client and the server stays responsive', async () => {
    const client = await open();
    try {
      const controller = new AbortController();
      const pending = call(client, 'lineage_search_ddl', { query: '(.*)*x' }, { signal: controller.signal }).then(() => 'completed', () => 'cancelled');
      controller.abort();
      equal(await pending, 'cancelled', 'an aborted call must reject on the client');
      const started = Date.now();
      assert(!(await call(client, 'lineage_get_context', {})).isError, 'follow-up call must succeed');
      assert(Date.now() - started < 5000, 'follow-up call must not be blocked by the aborted one');
    } finally { await client.close(); }
  });

  test('the stdio proxy relays the same tools over standard input and output', async () => {
    assert(existsSync(ctx.ready.proxyPath), `stdio proxy not published at ${ctx.ready.proxyPath}`);
    const transport = new StdioClientTransport({
      command: ctx.ready.execPath,
      args: [ctx.ready.proxyPath, ctx.ready.discoveryPath],
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    });
    const client = new Client({ name: 'mcp-live-stdio', version: '1' });
    await client.connect(transport);
    try {
      const { tools } = await client.listTools();
      equal(JSON.stringify(tools.map((t) => t.name).sort()), JSON.stringify(EXPECTED_TOOLS), 'proxied tool names');
      equal((await call(client, 'lineage_search_objects', { query: 'spImportOrders' })).json.results[0].id, ids.orders, 'proxied search result');
    } finally { await client.close(); }
  });

  // ── lifecycle: these change the host's state, so they run last, in dependency order ──

  test('reloading the project while connected invalidates old handles and serves the new project', async () => {
    const client = await open();
    try {
      const bundle = await call(client, 'lineage_get_scope_bundle', { origin: ids.orders, upstream_depth: 1, downstream_depth: 1, include_ddl: false });
      await hostCommand('loadDemo');
      equal((await call(client, 'lineage_search_objects', { query: 'spImportOrders' })).json.total, 0, 'fixture objects must be gone after loading the demo');
      const stale = await call(client, 'lineage_present_result', {
        scope_id: bundle.json.scope_id, name: 'stale', summary: 'stale', highlight_groups: [{ label: 'x', color: 'source', node_ids: [ids.orders] }], sections: [{ label: 'x', node_ids: [ids.orders], text: 'x' }],
      });
      assert(stale.isError, 'a scope_id from the previous project must be refused');
      await hostCommand('loadAI');
      equal((await call(client, 'lineage_search_objects', { query: 'spImportOrders' })).json.total, 1, 'fixture objects must be back');
    } finally { await client.close(); }
  });

  test('turning the setting off stops the server, removes the discovery file and revokes the token; turning it on issues a new token', async () => {
    const before = readDiscovery(ctx.ready);
    const client = await connect(before);
    await hostCommand('toggle', { enabled: false });
    await waitFor(() => !existsSync(ctx.ready.discoveryPath), 30_000, 'discovery file removal');
    let refused = false;
    try { await call(client, 'lineage_get_context', {}); } catch { refused = true; }
    assert(refused, 'a connected client must lose the server when the switch is turned off');
    await client.close().catch(() => undefined);
    refused = false;
    try { await raw(ctx.port, { headers: JSON_RPC_HEADERS(before.token), body: '{}' }); } catch { refused = true; }
    assert(refused, 'the port must stop accepting connections');
    await hostCommand('toggle', { enabled: true });
    await waitFor(() => existsSync(ctx.ready.discoveryPath), 30_000, 'discovery file after re-enabling');
    await waitFor(async () => (await raw(ctx.port, { headers: JSON_RPC_HEADERS(), body: '{}' }).catch(() => ({ status: 0 }))).status === 401, 30_000, 'listener after re-enabling');
    const after = readDiscovery(ctx.ready);
    assert(after.token !== before.token, 'a new token must be issued');
    equal((await raw(ctx.port, { headers: JSON_RPC_HEADERS(before.token), body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }) })).status, 401, 'the old token');
    const fresh = await connect(after);
    try { assert(!(await call(fresh, 'lineage_get_context', {})).isError, 'new token must work'); } finally { await fresh.close(); }
  });

  test('the VS Code debug log records the MCP actions in the shared tool-call format, without credentials', async () => {
    const log = await waitFor(() => { const text = readExtensionLog(); return text.includes(`:${ctx.port}/mcp with ${EXPECTED_TOOLS.length} tools`) ? text : null; }, 20_000, 'the extension log to contain the latest lifecycle line');
    const expectLine = (pattern, label) => assert(pattern.test(log), `log is missing: ${label}`);
    expectLine(new RegExp(`\\[info\\] \\[MCP\\] Server listening on http://127\\.0\\.0\\.1:\\d+/mcp with ${EXPECTED_TOOLS.length} tools`), 'server listening line');
    expectLine(/\[info\] \[MCP\] Server stopped/, 'server stopped line');
    expectLine(/\[AI\] Invoking lineage_search_objects \[external\] — input: \{"query":"spImportOrders"\}/, 'search call marked as an external caller');
    expectLine(/\[AI\] lineage_get_context → \d+ chars/, 'result size of a successful call');
    expectLine(/\[AI\] \[Reject\] tool=lineage_get_object_detail group=\w+ code=not_found/, 'not_found rejection');
    expectLine(/\[AI\] \[Reject\] tool=lineage_search_ddl group=\w+ code=invalid_input/, 'invalid_input rejection');
    expectLine(/\[AI\] \[Reject\] tool=lineage_get_scope_bundle group=\w+ code=over_discovery_budget/, 'budget rejection');
    expectLine(/Refused request \(401\): missing or invalid bearer token/, 'refused credentials');
    expectLine(/Refused request \(403\): Host or Origin is not local/, 'refused foreign Host/Origin');
    expectLine(/Refused request \(404\): unknown path/, 'refused unknown path');
    assert(seenTokens.size >= 2, 'the run must have seen the original and a re-issued token');
    for (const token of seenTokens) assert(!log.includes(token), 'a bearer token was written to the log');
  });

  test('changing the port moves the server and publishes the new address', async () => {
    const before = readDiscovery(ctx.ready);
    const newPort = ctx.port + 1;
    await hostCommand('setPort', { port: newPort });
    const after = await waitFor(() => { try { const d = readDiscovery(ctx.ready); return Number(new URL(d.url).port) === newPort ? d : null; } catch { return null; } }, 45_000, 'discovery file with the new port');
    let oldRefused = false;
    try { await raw(ctx.port, { headers: JSON_RPC_HEADERS(before.token), body: '{}' }); } catch { oldRefused = true; }
    assert(oldRefused, 'the old port must stop accepting connections');
    const client = await connect(after);
    try { assert(!(await call(client, 'lineage_get_context', {})).isError, 'server must answer on the new port'); } finally { await client.close(); }
    ctx.port = newPort;
  });
}

// ───────────────────────────── runner ─────────────────────────────

async function main() {
  const ctx = { ready: undefined, port: PORT };
  defineCases(ctx);
  const selected = cases.filter(x => !ONLY || x.name.includes(ONLY));
  if (!selected.length) fail4(`no cases match --only ${JSON.stringify(ONLY)}`);
  prepare(PORT);
  const host = launchHost({ port: PORT });
  const ready = await waitForReady(host);
  Object.assign(ctx, { ready, port: ready.port });
  const report = [];
  for (const c of selected) {
    const started = Date.now();
    try {
      await c.fn();
      report.push({ name: c.name, ok: true, ms: Date.now() - started });
      console.log(`  ✔ ${c.name} (${Date.now() - started} ms)`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      report.push({ name: c.name, ok: false, ms: Date.now() - started, error: message });
      console.log(`  ✘ ${c.name}\n      ${message}`);
    }
  }
  const code = await finishHost(host);
  const failed = report.filter((r) => !r.ok);
  writeFileSync(join(WORK, 'report.json'), JSON.stringify({ at: new Date().toISOString(), port: ready.port, nodes: ready.nodes, passed: report.length - failed.length, failed: failed.length, cases: report }, null, 2));
  console.log(`\nMCP-LIVE: ${report.length - failed.length} passed, ${failed.length} failed (host exit ${code}). Report: ${join(WORK, 'report.json')}`);
  console.log('MODEL: none. This establishes MCP transport, tool contracts and lifecycle against a live host; it says nothing about model behavior or answer quality.');
  process.exit(code !== 0 ? 4 : failed.length ? 1 : 0);
}

main().catch((error) => fail4(error instanceof Error ? error.message : String(error)));
