/**
 * Facts toolbelt: ask the product itself for facts about the loaded project over MCP.
 *
 * @remarks
 * Replaces ad-hoc extractor bundles and regex scripts when you need ground truth about the
 * AdventureWorks AI fixture (objects, edges, DDL, hubs, scope sizes). Every answer comes from the
 * same tools an MCP client uses, against a real Extension Development Host. These facts show what
 * the PRODUCT reports; they cannot prove the product matches the SQL — read the SQL for that.
 *
 * A host is started for the call unless a detached one is running:
 *
 *   node tests/tools/mcp/facts.mjs host up       start a host that stays up (port 39372)
 *   node tests/tools/mcp/facts.mjs host status   show the running host
 *   node tests/tools/mcp/facts.mjs host down     stop it
 *   node tests/tools/mcp/facts.mjs tools                      list the tools
 *   node tests/tools/mcp/facts.mjs counts                     nodes, edges and objects per schema
 *   node tests/tools/mcp/facts.mjs find <text>                search objects by name
 *   node tests/tools/mcp/facts.mjs object <id>                one object: what it reads and what reads it
 *   node tests/tools/mcp/facts.mjs ddl <text>                 objects whose definition contains the text
 *   node tests/tools/mcp/facts.mjs hubs                       most connected objects
 *   node tests/tools/mcp/facts.mjs bundle <id> [up] [down]    size of the scope around an object (default 1 1)
 *   node tests/tools/mcp/facts.mjs verify-baseline            compare counts and patterns with tests/fixtures/graph-baseline-aw.json
 *   node tests/tools/mcp/facts.mjs call <tool> '<json>'       any tool, raw JSON result
 *
 * Needs `npm run pretest:integration` once (it compiles the host test). Add `--json` for raw output.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { call, connect, readDiscovery } from './client.mjs';
import { DEFAULT_PORT, fail4, readSession, root, startDetached, stopDetached, withHost } from './host.mjs';

const argv = process.argv.slice(2).filter((a) => a !== '--json');
const asJson = process.argv.includes('--json');
const [command, ...rest] = argv;

const print = (value) => console.log(asJson ? JSON.stringify(value, null, 2) : value);

async function withClient(fn) {
  return withHost(async (ready) => {
    const client = await connect(readDiscovery(ready));
    try { return await fn(client); } finally { await client.close(); }
  });
}

const need = (value, usage) => { if (value === undefined) fail4(`usage: ${usage}`); return value; };

async function run() {
  if (command === 'host') {
    const sub = rest[0];
    if (sub === 'up') {
      if (readSession()) return print('a host is already running');
      const { ready } = await startDetached(DEFAULT_PORT);
      return print(`host up: ${ready.nodes} nodes on port ${ready.port}. Stop it with: node tests/tools/mcp/facts.mjs host down`);
    }
    if (sub === 'status') {
      const session = readSession();
      return print(session ? { running: true, pid: session.pid, port: session.port, since: session.startedAt } : { running: false });
    }
    if (sub === 'down') return print((await stopDetached()) ? 'host stopped' : 'no host was running');
    return fail4('usage: host up|status|down');
  }

  switch (command) {
    case 'tools': return withClient(async (c) => print((await c.listTools()).tools.map((t) => asJson ? { name: t.name, required: t.inputSchema.required ?? [], readOnly: !!t.annotations?.readOnlyHint } : `${t.name}${t.annotations?.readOnlyHint ? '' : ' (writes a view)'}  required: ${(t.inputSchema.required ?? []).join(', ') || '-'}`).join(asJson ? undefined : '\n')));
    case 'counts': return withClient(async (c) => {
      const ctx = (await call(c, 'lineage_get_context', {})).json;
      print(asJson ? ctx : `${ctx.project_name}: ${ctx.model_stats.nodes} nodes, ${ctx.model_stats.edges} edges\n${ctx.schemas.map((s) => `  ${s.name}: ${s.n} objects (tables ${s.t ?? 0}, views ${s.v ?? 0}, procedures ${s.p ?? 0}, functions ${s.f ?? 0})`).join('\n')}`);
    });
    case 'find': {
      const text = need(rest[0], 'find <text>');
      return withClient(async (c) => {
        const r = (await call(c, 'lineage_search_objects', { query: text })).json;
        print(asJson ? r : `${r.total} match(es)\n${r.results.map((x) => `  ${x.id}  ${x.t}  degree ${x.deg}`).join('\n')}`);
      });
    }
    case 'object': {
      const id = need(rest[0], 'object <id>').toLowerCase();
      return withClient(async (c) => {
        const r = await call(c, 'lineage_get_object_detail', { id });
        if (r.isError) return fail4(`${r.code}: ${r.text}`);
        const list = (items) => (items ?? []).map((n) => `  ${n.e ?? ''} ${n.id}`).join('\n') || '  -';
        print(asJson ? r.json : `${r.json.id}  (${r.json.type})\nreads / depends on:\n${list(r.json.up)}\nread / written by:\n${list(r.json.dn)}`);
      });
    }
    case 'ddl': {
      const text = need(rest[0], 'ddl <text>');
      return withClient(async (c) => {
        const r = (await call(c, 'lineage_search_ddl', { query: text })).json;
        const byObject = new Map();
        for (const hit of r.results) byObject.set(hit.id, [...(byObject.get(hit.id) ?? []), hit.line]);
        print(asJson ? r : [...byObject].map(([id, lines]) => `  ${id}  lines ${lines.join(', ')}`).join('\n') || '  no match');
      });
    }
    case 'hubs': return withClient(async (c) => {
      const r = (await call(c, 'lineage_detect_graph_patterns', { type: 'hubs' })).json;
      print(asJson ? r : `${r.summary}\n${r.groups.map((g) => `  ${g.nodeIds[0]}  degree ${g.meta.degree} (in ${g.meta.inDegree}, out ${g.meta.outDegree})`).join('\n')}`);
    });
    case 'bundle': {
      const id = need(rest[0], 'bundle <id> [up] [down]').toLowerCase();
      return withClient(async (c) => {
        const r = await call(c, 'lineage_get_scope_bundle', { origin: id, upstream_depth: Number(rest[1] ?? 1), downstream_depth: Number(rest[2] ?? 1), include_ddl: false });
        if (r.isError) return print(asJson ? { code: r.code, text: r.text } : `${r.code}: ${r.text}`);
        print(asJson ? r.json : `${r.json.scope.nodes} nodes, ${r.json.scope.edges} edges around ${id}\n${r.json.nodes.map((n) => `  ${n.id}`).join('\n')}`);
      });
    }
    case 'verify-baseline': return withClient(async (c) => {
      const baseline = JSON.parse(readFileSync(join(root, 'tests/fixtures/graph-baseline-aw.json'), 'utf8'));
      const ctx = (await call(c, 'lineage_get_context', {})).json;
      const hubs = (await call(c, 'lineage_detect_graph_patterns', { type: 'hubs' })).json;
      const cycles = (await call(c, 'lineage_detect_graph_patterns', { type: 'cycles' })).json;
      const checks = [
        ['nodes', ctx.model_stats.nodes, baseline.stats.nodes],
        ['edges', ctx.model_stats.edges, baseline.stats.edges],
        ['top hub', hubs.groups[0].id, baseline.analysis.hubs.topId],
        ['top hub degree', hubs.groups[0].meta.degree, baseline.analysis.hubs.topDegree],
        ['cycle groups', cycles.groups.length, baseline.analysis.cycles.groupCount],
      ];
      for (const [label, got, want] of checks) console.log(`${got === want ? 'ok  ' : 'DIFF'} ${label}: product=${got} baseline=${want}`);
      process.exitCode = checks.every(([, got, want]) => got === want) ? 0 : 1;
    });
    case 'call': {
      const tool = need(rest[0], "call <tool> '<json>'");
      const r = await withClient((c) => call(c, tool, JSON.parse(rest[1] ?? '{}')));
      return print(asJson || r.json === undefined ? r : r.json);
    }
    default:
      return fail4('usage: facts.mjs host up|status|down | tools | counts | find <text> | object <id> | ddl <text> | hubs | bundle <id> [up] [down] | verify-baseline | call <tool> <json>');
  }
}

run().then(() => process.exit(process.exitCode ?? 0), (error) => fail4(error instanceof Error ? error.message : String(error)));
