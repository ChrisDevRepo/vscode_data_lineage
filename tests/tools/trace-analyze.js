#!/usr/bin/env node
// tests/tools/trace-analyze.js — analyze LM traffic captured by LmTracer
//
// Usage:
//   node tests/tools/trace-analyze.js <trace-file.ndjson> [options] [--sid <id>]
//
// Flags (combine freely):
//   --summary        per-session totals: rounds, tokens, tools, rejections  [default]
//   --report         full per-round narrative: prompt excerpts, tools, results, wipes
//   --phase          token breakdown per phase (discover/active/synthesis/compose)
//   --sizes          per-round message composition: system/history/tools/prompt sizes
//   --patterns       which prompt structural blocks appear in which phase
//   --redundancy     find duplicate text across parts of the same request
//   --rejected       all TOOL_RESULT events with errCode + hint
//   --loops          detect same tool called consecutively (>=2x same input)
//   --wipes          all WIPE events
//   --waste          tokens present at wipe time vs total sent
//   --tools          tool call frequency, avg duration, rejection rate
//   --timeline       chronological event dump
//   --growth         per-round total context size (chars) + growth % vs previous round
//   --tool-bloat     per-tool result payload size: avg/max chars, % of total results
//   --detail-metrics per-round content depth: STM, sections, labels, chat output, present_result + math formula violations
//   --ct             column tracing analysis: per-hop flow coverage, CT rejections, propagation edges
//   --journal-metrics emit ONE compact JSON metrics line to stdout (for appending to journal.jsonl)
//   --sid <id>       filter all output to one session id

'use strict';
const fs   = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const args = process.argv.slice(2);
const file = args.find(a => !a.startsWith('--'));
const flags = new Set(args.filter(a => a.startsWith('--') && a !== '--sid'));
const sidIdx = args.indexOf('--sid');
const filterSid = sidIdx >= 0 ? args[sidIdx + 1] : null;

if (!file) {
  console.error([
    'Usage: node tests/tools/trace-analyze.js <file.ndjson> [flags] [--sid <id>]',
    '',
    'Flags: --summary --report --phase --sizes --patterns --redundancy',
    '       --rejected --loops --wipes --waste --tools --timeline',
    '       --growth --tool-bloat --detail-metrics --ct',
    '       --journal-metrics  (emits one JSON line to stdout, no other output)',
  ].join('\n'));
  process.exit(1);
}

// ── load & parse ──────────────────────────────────────────────────────────────

const raw = fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean);
let events = [];
for (const line of raw) {
  try {
    const ev = JSON.parse(line);
    if (ev._ === 'TX') events.push(ev);
  } catch { /* skip malformed lines */ }
}
if (filterSid) events = events.filter(e => e.sid === filterSid);

const bySid = {};
for (const ev of events) {
  if (!bySid[ev.sid]) bySid[ev.sid] = [];
  bySid[ev.sid].push(ev);
}
const sessions = Object.entries(bySid);

if (sessions.length === 0) {
  console.log('No TX events found' + (filterSid ? ` for sid=${filterSid}` : '') + '.');
  process.exit(0);
}

// ── formatting helpers ─────────────────────────────────────────────────────────

const ts    = (t) => new Date(t).toISOString().slice(11, 23);
const pad   = (s, n) => String(s).padEnd(n);
const lpad  = (s, n) => String(s).padStart(n);
const short = (name) => (name || '').replace('lineage_', '');
const pct   = (a, b) => b > 0 ? ((a / b) * 100).toFixed(0) + '%' : '0%';
const bar   = (ratio, width=20) => {
  const n = Math.round(ratio * width);
  return '[' + '█'.repeat(n) + '░'.repeat(width - n) + ']';
};

function parseToolResultPayload(ev) {
  if (!ev || !Array.isArray(ev.result) || !ev.result[0]) return null;
  try { return JSON.parse(ev.result[0]); } catch { return null; }
}

function isExpectedGateReject(ev) {
  if (!ev || ev.ev !== 'TOOL_RESULT' || !ev.errCode) return false;
  if (!String(ev.tool || '').includes('start_exploration')) return false;
  if (String(ev.errCode) !== 'action_required') return false;
  const payload = parseToolResultPayload(ev);
  return !!(payload && payload.gate === 'confirm_sm_start');
}

function countRegexMatches(text, regex) {
  if (!text) return 0;
  const m = text.match(regex);
  return m ? m.length : 0;
}

function isGenericRouteQuestion(q) {
  if (!q) return true;
  const t = String(q).trim().toLowerCase();
  if (t.length < 35) return true;
  if (/^(analy[sz]e|review|check|inspect|look at|investigate)\s+(this|the)?\s*(node|object|procedure|table)\b/.test(t)) return true;
  const specificSignal = /(predicate|where|join|formula|case|threshold|column|field|rule|allocation|status|filter|derive|computed|verify|decision|because)/;
  return !specificSignal.test(t);
}

// Extract all text strings from serialized messages for analysis
function extractTexts(messages) {
  const results = []; // { msgIdx, partIdx, role, type, text }
  if (!Array.isArray(messages)) return results;
  messages.forEach((msg, mi) => {
    if (!Array.isArray(msg.parts)) return;
    msg.parts.forEach((part, pi) => {
      if (part.type === 'text' && part.value) {
        results.push({ msgIdx: mi, partIdx: pi, role: msg.role, type: 'text', text: part.value });
      } else if (part.type === 'tool_result' && Array.isArray(part.content)) {
        for (const c of part.content) {
          results.push({ msgIdx: mi, partIdx: pi, role: msg.role, type: 'tool_result', text: c });
        }
      } else if (part.type === 'tool_call' && part.input) {
        // Replay-compacted tool calls are historical context, not fresh model intent.
        // Exclude them from redundancy/pattern text analysis to avoid false positives.
        if (part.input.replay_compacted === true || part.input.trace_replay === true) return;
        results.push({ msgIdx: mi, partIdx: pi, role: msg.role, type: 'tool_call', text: JSON.stringify(part.input) });
      }
    });
  });
  return results;
}

// ── stable-prefix segment parser ─────────────────────────────────────────────
// Splits messages[0] text into named XML blocks + remaining template text.
// Used by --patterns to show WHERE in the stable prefix a marker is found.
function segmentStablePrefix(text) {
  const segments = [];
  let lastIndex = 0;
  const blockRe = /<([a-zA-Z][\w_]*)>([\s\S]*?)<\/\1>/g;
  let m;
  while ((m = blockRe.exec(text)) !== null) {
    if (m.index > lastIndex) segments.push({ block: 'template', text: text.slice(lastIndex, m.index) });
    segments.push({ block: m[1], text: m[2] });
    lastIndex = blockRe.lastIndex;
  }
  if (lastIndex < text.length) segments.push({ block: 'template', text: text.slice(lastIndex) });
  return segments;
}

function parseToolResultJsonParts(messages) {
  const payloads = [];
  if (!Array.isArray(messages)) return payloads;
  for (const msg of messages) {
    for (const part of (msg.parts || [])) {
      if (part.type !== 'tool_result' || !Array.isArray(part.content)) continue;
      for (const c of part.content) {
        if (typeof c !== 'string') continue;
        try { payloads.push(JSON.parse(c)); } catch { /* ignore non-json */ }
      }
    }
  }
  return payloads;
}

function getOwnershipCheck(req) {
  const sysText = (req.messages?.[0]?.parts || [])
    .filter(p => p.type === 'text')
    .map(p => p.value || '')
    .join('');
  const directiveText = (req.messages?.[1]?.parts || [])
    .filter(p => p.type === 'text')
    .map(p => p.value || '')
    .join('');
  const toolPayloads = parseToolResultJsonParts(req.messages || []);
  const replay = toolPayloads.length > 0 ? toolPayloads[toolPayloads.length - 1] : null;

  const missionStateFocus = /focus_node_id:\s*([^\n\r]+)/.exec(sysText)?.[1]?.trim() || '';
  const missionStateHop = /hop:\s*(\d+)\s*\/\s*(\d+)/.exec(sysText);
  const missionStateAgenda = /agenda_remaining:\s*(\d+)/.exec(sysText);
  const missionBriefExists = sysText.includes('<mission_brief>');

  const directiveFocus = /focus for hop\s+\d+\s+is\s+([^\.\n\r]+)/i.exec(directiveText)?.[1]?.trim() || '';
  const directiveHop = /focus for hop\s+(\d+)/i.exec(directiveText)?.[1] || '';

  const replayFocus = replay?.focus_node?.id ? String(replay.focus_node.id) : '';
  const replayHop = typeof replay?.hop === 'number' ? String(replay.hop) : '';
  const replayAgenda = typeof replay?.agenda_remaining === 'number' ? String(replay.agenda_remaining) : '';
  const replayMission = typeof replay?.working_memory?.user_question === 'string' ? replay.working_memory.user_question : '';
  const replayBddl = typeof replay?.focus_node?.bb_ddl === 'string' ? replay.focus_node.bb_ddl : '';
  const replayNeighbors = Array.isArray(replay?.neighbors) ? replay.neighbors : null;

  const focusCarriers = [missionStateFocus, directiveFocus, replayFocus].filter(Boolean).length;
  const hopCarriers = [missionStateHop?.[1] || '', directiveHop, replayHop].filter(Boolean).length;
  const agendaCarriers = [missionStateAgenda?.[1] || '', replayAgenda].filter(Boolean).length;
  const missionCarriers = [missionBriefExists ? 'mission_brief' : '', replayMission].filter(Boolean).length;

  const duplicates = {
    focus_node_id: focusCarriers > 1,
    hop: hopCarriers > 1,
    agenda_remaining: agendaCarriers > 1,
    mission_intent: missionCarriers > 1,
  };

  const requiredMissing = {
    mission_state_focus: !missionStateFocus,
    mission_state_hop: !missionStateHop,
    mission_state_agenda: !missionStateAgenda,
    replay_focus_node: !replayFocus,
    replay_focus_bb_ddl: !replayBddl,
    replay_neighbors: !replayNeighbors,
  };

  return { duplicates, requiredMissing, replayFound: !!replay };
}

// ── known prompt structural markers ───────────────────────────────────────────
// These appear inside the system prompt and signal specific blocks.
// Used by --patterns to detect where blocks appear and if they're in wrong phases.

const PROMPT_MARKERS = [
  // SM-only blocks (should NEVER appear in discover phase)
  { key: '<short_term_memory>',  smOnly: true,  label: '<short_term_memory>' },
  { key: '<current_task>',       smOnly: true,  label: '<current_task>' },
  { key: '<mission_state>',      smOnly: true,  label: '<mission_state>' },
  { key: '<mission_brief>',      smOnly: true,  label: '<mission_brief>' },
  { key: '<discovery_summary>',  smOnly: true,  label: '<discovery_summary>' },
  // Tool-name presence (which tools are mentioned in what phase)
  { key: 'submit_findings',      smOnly: true,  label: 'submit_findings ref' },
  { key: 'present_result',       smOnly: false, label: 'present_result ref' },
  { key: 'start_exploration',    smOnly: false, label: 'start_exploration ref' },
  // Structural rule blocks
  { key: 'GROUNDING RULE',       smOnly: false, label: 'GROUNDING RULE block' },
  { key: 'MATHEMATICS',          smOnly: false, label: 'MATHEMATICS block' },
  { key: 'column_flow',          smOnly: true,  label: 'column_flow block' },
  // Discovery-only blocks (should NOT appear in active phase)
  { key: 'catalog',              smOnly: false, label: 'catalog ref' },
  { key: 'search_objects',       smOnly: false, label: 'search_objects ref' },
];

// ── --journal-metrics ─────────────────────────────────────────────────────────
// MUST run first: emits ONE minified JSON line then exits.
// No other output — designed for: node ... --journal-metrics >> tmp/lm-journal/journal.jsonl

if (flags.has('--journal-metrics')) {
  // Detect bare single-$ inline math only. $$ block math is correct (webview converts it).
  const MATH_RE_JM = /(?<!\$)\$(?!\$)[A-Za-z@_\\][^$\n]{0,100}\$(?!\$)/g;
  // Pick the session with SESSION_END; if none, the one with the most ROUND events
  const mainSession = sessions.find(([, e]) => e.some(x => x.ev === 'SESSION_END'))
    ?? sessions.sort((a, b) => b[1].filter(x => x.ev === 'ROUND').length - a[1].filter(x => x.ev === 'ROUND').length)[0];
  for (const [sid, evs] of [mainSession]) {
    const end     = evs.find(e => e.ev === 'SESSION_END');
    const rounds  = evs.filter(e => e.ev === 'ROUND');
    const rejects = evs.filter(e => e.ev === 'TOOL_RESULT' && e.errCode);
    const expectedGateRejects = rejects.filter(isExpectedGateReject);
    const unexpectedRejects = rejects.filter(r => !isExpectedGateReject(r));
    const wipes   = evs.filter(e => e.ev === 'WIPE');
    const cached  = evs.filter(e => e.ev === 'TOOL_INVOKE' && e.cached);
    const toolInv = evs.filter(e => e.ev === 'TOOL_INVOKE' && !e.cached);

    const phases = {};
    for (const r of rounds) {
      const ph = r.phase || 'unknown';
      if (!phases[ph]) phases[ph] = { in: 0, out: 0, rounds: 0 };
      phases[ph].in    += r.inTok  || 0;
      phases[ph].out   += r.outTok || 0;
      phases[ph].rounds++;
    }

    const bloat = {};
    for (const ev of evs.filter(e => e.ev === 'TOOL_RESULT' && !e.errCode)) {
      const chars = (ev.result || []).join('').length;
      if (!bloat[ev.tool]) bloat[ev.tool] = { calls: 0, totalChars: 0 };
      bloat[ev.tool].calls++;
      bloat[ev.tool].totalChars += chars;
    }
    const topBloat = Object.entries(bloat)
      .map(([t, s]) => ({ tool: short(t), avg_chars: s.calls > 0 ? Math.round(s.totalChars / s.calls) : 0 }))
      .sort((a, b) => b.avg_chars - a.avg_chars).slice(0, 3);

    let mathViolations = 0, badgeLabelViolations = 0, noteCaptionViolations = 0;
    let pruneVerdictCount = 0, pruneNeighborsCount = 0, ctAutoPruneCount = 0;
    let maxStm = 0, maxSections = 0, presentResultChars = 0, minChatOut = Infinity;
    const jmReqs = evs.filter(e => e.ev === 'REQ');
    for (let i = 0; i < jmReqs.length; i++) {
      const req  = jmReqs[i];
      const msgs = req.messages || [];
      const prevLen = i > 0 ? (jmReqs[i-1].messages || []).length : 0;
      const newMsgs = msgs.slice(prevLen, msgs.length - 1);
      const lastMsg = msgs[msgs.length - 1];
      if (lastMsg?.role === 'user') {
        for (const p of (lastMsg.parts || [])) {
          if (p.type !== 'text') continue;
          const m = /<short_term_memory>[\s\S]*?<\/short_term_memory>/.exec(p.value || '');
          if (m && m[0].length > maxStm) maxStm = m[0].length;
        }
      }
      let chatChars = 0;
      for (const msg of newMsgs) {
        if (msg.role !== 'assistant') continue;
        for (const p of (msg.parts || [])) {
          if (p.type === 'text') { chatChars += (p.value || '').length; }
          if (p.type === 'text') {
            const cleaned = (p.value || '').replace(/```math[\s\S]*?```/g, '');
            MATH_RE_JM.lastIndex = 0;
            let m2; while ((m2 = MATH_RE_JM.exec(cleaned)) !== null) mathViolations++;
          }
        }
      }
      if (chatChars > 0 && chatChars < minChatOut) minChatOut = chatChars;
    }
    // ANSWER_TEXT captures the final round's text — not present in REQ history
    for (const ev of evs.filter(e => e.ev === 'ANSWER_TEXT')) {
      const chars = ev.chars || (ev.text || '').length;
      if (chars > 0 && chars < minChatOut) minChatOut = chars;
    }
    for (const tc of evs.filter(e => e.ev === 'TOOL_CALL')) {
      const name = tc.tool || '', inp = tc.input || {};
      if (name.includes('submit_findings')) {
        if (inp.verdict === 'prune') pruneVerdictCount++;
        if (Array.isArray(inp.prune_neighbors)) pruneNeighborsCount += inp.prune_neighbors.length;
        let sc = 0;
        for (const sec of (inp.sections || [])) sc += (sec.text || '').length;
        if (sc > maxSections) maxSections = sc;
        // badge_label and note_caption are top-level fields on submit_findings, not in nodes[]
        if ((inp.badge_label || '').length > 50)  badgeLabelViolations++;
        if ((inp.note_caption || '').length > 200) noteCaptionViolations++;
      }
      if (name.includes('present_result')) {
        const c = JSON.stringify(inp).length;
        if (c > presentResultChars) presentResultChars = c;
      }
    }
    for (const tr of evs.filter(e => e.ev === 'TOOL_RESULT')) {
      const payload = parseToolResultPayload(tr);
      const ctCount = payload?.ctPrunedNodeIds?.length
        ?? payload?.result?.ctPrunedNodeIds?.length
        ?? 0;
      if (ctCount > 0) ctAutoPruneCount += ctCount;
    }

    let loops = 0;
    let prevSig = null;
    for (const c of evs.filter(e => e.ev === 'TOOL_CALL')) {
      const sig = `${c.tool}::${JSON.stringify(c.input)}`;
      if (sig === prevSig) loops++;
      prevSig = sig;
    }

    const jmFlags = [
      ...new Set(unexpectedRejects.map(r => `reject:${r.errCode}`)),
      ...(expectedGateRejects.length > 0 ? [`reject_expected_gate:${expectedGateRejects.length}`] : []),
      ...wipes.map(w => `wipe:${w.trigger}`),
      ...(mathViolations   > 0 ? [`math_violation:${mathViolations}`]       : []),
      ...(badgeLabelViolations > 0 ? [`badge_violation:${badgeLabelViolations}`] : []),
      ...(loops > 0 ? [`loop:${loops}`] : []),
    ];

    // Reconstruct token totals from ROUND events to capture all phases.
    // SESSION_END.cumInTok only covers the primary (discover) session invocation;
    // SM phases (active/synthesis/completed) run in subsequent turns and add to ROUND events
    // but are not reflected in SESSION_END.
    const cumIn  = rounds.reduce((s, r) => s + (r.inTok  || 0), 0);
    const cumOut = rounds.reduce((s, r) => s + (r.outTok || 0), 0);
    const peak   = rounds.length > 0 ? Math.max(...rounds.map(r => r.inTok || 0)) : 0;

    let gitSha = 'unknown';
    try { gitSha = execSync('git rev-parse --short HEAD', { stdio: ['pipe','pipe','pipe'] }).toString().trim(); } catch {}

    process.stdout.write(JSON.stringify({
      date:       new Date().toISOString(),
      git_sha:    gitSha,
      file:       path.basename(file),
      sid,
      rounds:     end ? end.rounds  : rounds.length,
      in_tok:     cumIn,
      out_tok:    cumOut,
      peak_tok:   peak,
      rejects:    rejects.length,
      expected_gate_rejects: expectedGateRejects.length,
      unexpected_rejects: unexpectedRejects.length,
      loops,
      wipes:      wipes.length,
      cache_hits: cached.length,
      tool_calls: toolInv.length,
      exit_kind:  end ? end.exitKind : 'unknown',
      phases,
      top_tool_bloat: topBloat,
      detail: {
        max_short_term_memory_chars: maxStm,
        max_sections_text_chars:     maxSections,
        present_result_chars:        presentResultChars,
        min_chat_output_chars:       minChatOut === Infinity ? 0 : minChatOut,
        math_violations:             mathViolations,
        badge_label_violations:      badgeLabelViolations,
        note_caption_violations:     noteCaptionViolations,
        prune_verdict_count:         pruneVerdictCount,
        prune_neighbors_count:       pruneNeighborsCount,
        ct_auto_prune_count:         ctAutoPruneCount,
      },
      flags: jmFlags,
    }) + '\n');
  }
  process.exit(0);
}

// ── --summary ─────────────────────────────────────────────────────────────────

if (flags.size === 0 || flags.has('--summary')) {
  console.log('\n═══ SESSION SUMMARY ═══\n');
  for (const [sid, evs] of sessions) {
    const end    = evs.find(e => e.ev === 'SESSION_END');
    const rounds = evs.filter(e => e.ev === 'ROUND');
    const invocs = evs.filter(e => e.ev === 'TOOL_INVOKE' && !e.cached);
    const cached = evs.filter(e => e.ev === 'TOOL_INVOKE' && e.cached);
    const rejects= evs.filter(e => e.ev === 'TOOL_RESULT' && e.errCode);
    const expectedGateRejects = rejects.filter(isExpectedGateReject);
    const unexpectedRejects = rejects.filter(r => !isExpectedGateReject(r));
    const wipes  = evs.filter(e => e.ev === 'WIPE');

    const cumIn  = end ? end.cumInTok  : rounds.reduce((s, r) => s + (r.inTok  || 0), 0);
    const cumOut = end ? end.cumOutTok : rounds.reduce((s, r) => s + (r.outTok || 0), 0);
    const peak   = end ? end.peakTok   : Math.max(0, ...rounds.map(r => r.inTok || 0));
    const nRound = end ? end.rounds    : rounds.length;
    const nTools = end ? end.tools     : invocs.length;
    const exit   = end ? end.exitKind  : '(no SESSION_END)';
    const roundMs = rounds.reduce((s, r) => s + (r.ms || 0), 0);
    const toolMs = evs
      .filter(e => e.ev === 'TOOL_RESULT')
      .reduce((s, r) => s + (r.ms || 0), 0);
    const modelMs = Math.max(0, roundMs - toolMs);
    const toolPct = roundMs > 0 ? ((toolMs / roundMs) * 100).toFixed(2) : '0.00';
    const modelPct = roundMs > 0 ? ((modelMs / roundMs) * 100).toFixed(2) : '0.00';

    console.log(`sid: ${sid}`);
    console.log(`  exit:     ${exit}`);
    console.log(`  rounds:   ${nRound}   invocations: ${nTools}   cache_hits: ${cached.length}`);
    console.log(`  tokens:   in=${cumIn}  out=${cumOut}  peak_round=${peak}`);
    console.log(`  rejected: ${rejects.length} (expected_gate=${expectedGateRejects.length}, unexpected=${unexpectedRejects.length})   wipes: ${wipes.length}`);
    console.log(`  latency:  total=${roundMs}ms  model≈${modelMs}ms (${modelPct}%)  tools=${toolMs}ms (${toolPct}%)`);
    if (rejects.length > 0) {
      const byTool = {};
      for (const r of rejects) byTool[r.tool] = (byTool[r.tool] || 0) + 1;
      console.log(`  rej_by:   ${Object.entries(byTool).map(([t,n]) => `${short(t)}×${n}`).join(', ')}`);
    }
    // CT session detection in summary
    const ctStart = evs.find(e => e.ev === 'TOOL_CALL' && (e.tool || '').includes('start_exploration')
      && Array.isArray((e.input || {}).targetColumns) && ((e.input || {}).targetColumns || []).length > 0);
    if (ctStart) {
      console.log(`  ct_session: YES  |  tracking: ${(ctStart.input.targetColumns || []).join(', ')}`);
    }
    console.log('');
  }
}

// ── --report ──────────────────────────────────────────────────────────────────
// Full per-round narrative: prompt excerpts, tool calls, results, size split, wipes.
// The goal: read one report and understand the entire session end-to-end.

if (flags.has('--report')) {
  // Known structural blocks to detect in system prompt
  const KNOWN_BLOCKS = [
    '<short_term_memory>', '<current_task>', '<mission_state>', '<mission_brief>',
    '<discovery_summary>', '<lineage_questions>', 'GROUNDING RULE', 'MATHEMATICS',
    'submit_findings', 'present_result', 'start_exploration', 'column_flow',
  ];

  // Truncate a string to maxLen, replacing newlines for inline display
  const snip = (s, maxLen = 300) => {
    if (!s) return '';
    const clean = String(s).replace(/\s+/g, ' ').trim();
    return clean.length <= maxLen ? clean : clean.slice(0, maxLen) + `…(+${clean.length - maxLen})`;
  };

  // Same but keeps line breaks (for multi-line excerpts shown indented)
  const excerpt = (s, maxLen = 500) => {
    if (!s) return '';
    const t = String(s).trim();
    if (t.length <= maxLen) return t;
    return t.slice(0, maxLen) + `\n  …(${t.length - maxLen} more chars)`;
  };

  // Get the assistant text parts (model response text) from messages between two REQs
  const getResponseText = (sid, rid) => {
    // The assistant response for rid is in messages[rid+1].REQ as history
    // More reliably: look at the next REQ's messages and find assistant turns added since prev
    const nextReq = events.find(e => e.ev === 'REQ' && e.sid === sid && e.rid === rid + 1);
    if (!nextReq || !Array.isArray(nextReq.messages)) return null;
    // Find assistant messages that are not in the previous REQ's messages
    const prevReq = events.find(e => e.ev === 'REQ' && e.sid === sid && e.rid === rid);
    const prevLen = prevReq?.messages?.length ?? 0;
    // Assistant messages appear in the history between prevLen and end-1 (last = user eff prompt)
    const newMsgs = nextReq.messages.slice(prevLen, nextReq.messages.length - 1);
    const texts = [];
    for (const m of newMsgs) {
      if (m.role !== 'assistant') continue;
      for (const p of (m.parts || [])) {
        if (p.type === 'text' && p.value) texts.push(p.value);
      }
    }
    return texts.join('\n') || null;
  };

  console.log('\n' + '═'.repeat(80));
  console.log('  ROUND-BY-ROUND REPORT');
  console.log('═'.repeat(80));

  const reqs = events.filter(e => e.ev === 'REQ');
  for (const [sid, evs] of sessions) {
    const sessionReqs = reqs.filter(e => e.sid === sid);
    const sessionEnd  = evs.find(e => e.ev === 'SESSION_END');
    const sessionStart = evs.find(e => e.ev === 'SESSION_START');

    console.log(`\nsid: ${sid}`);
    if (sessionStart) console.log(`model: ${sessionStart.modelId}  maxTokens: ${sessionStart.maxTokens}`);

    for (const req of sessionReqs) {
      const rid   = req.rid;
      const phase = req.phase || '?';
      const round = evs.find(e => e.ev === 'ROUND' && e.rid === rid);
      const wipes = evs.filter(e => e.ev === 'WIPE'  && e.rid === rid);
      const toolCalls   = evs.filter(e => e.ev === 'TOOL_CALL'   && e.rid === rid);
      const toolInvokes = evs.filter(e => e.ev === 'TOOL_INVOKE' && e.rid === rid);
      const toolResults = evs.filter(e => e.ev === 'TOOL_RESULT' && e.rid === rid);

      const inTok  = round?.inTok  ?? '?';
      const outTok = round?.outTok ?? '?';
      const ms     = round?.ms     ?? '?';
      const mode   = req.mode || '?';
      const tools  = (req.tools || []).map(short).join(', ') || '(none)';

      console.log('\n' + '─'.repeat(80));
      console.log(`ROUND ${rid}  |  phase=${phase}  |  ms=${ms}  |  in=${inTok}  out=${outTok}  |  mode=${mode}`);
      console.log(`tools available: ${tools}`);
      console.log('─'.repeat(80));

      // ── SIZE SPLIT ──────────────────────────────────────────────────────────
      const msgs = req.messages || [];
      let sysChars = 0, histChars = 0, toolResChars = 0, effChars = 0;
      const sysTexts = msgs[0]?.parts?.filter(p => p.type === 'text').map(p => p.value || '') || [];
      sysChars = sysTexts.join('').length;
      const lastMsg = msgs[msgs.length - 1];
      const lastTexts = lastMsg?.parts?.filter(p => p.type === 'text').map(p => p.value || '') || [];
      effChars = lastTexts.join('').length;
      for (let i = 1; i < msgs.length - 1; i++) {
        const m = msgs[i];
        for (const p of (m.parts || [])) {
          const len = (p.value || '').length + (p.content || []).join('').length + JSON.stringify(p.input || '').length;
          if (p.type === 'tool_result') toolResChars += len;
          else histChars += len;
        }
      }
      const totalChars = sysChars + histChars + toolResChars + effChars;
      console.log(`\nSIZE SPLIT (chars):  total=${totalChars}  sys=${sysChars}(${pct(sysChars,totalChars)})  hist=${histChars}(${pct(histChars,totalChars)})  tool_res=${toolResChars}(${pct(toolResChars,totalChars)})  prompt=${effChars}(${pct(effChars,totalChars)})`);

      // ── SYSTEM PROMPT BLOCKS DETECTED ───────────────────────────────────────
      const sysText = sysTexts.join('');
      const presentBlocks = KNOWN_BLOCKS.filter(b => sysText.includes(b));
      const absentBlocks  = KNOWN_BLOCKS.filter(b => !sysText.includes(b));
      if (presentBlocks.length > 0)
        console.log(`PROMPT BLOCKS:  ✓ ${presentBlocks.join('  ✓ ')}`);
      if (absentBlocks.length > 0)
        console.log(`               ✗ ${absentBlocks.join('  ✗ ')}`);

      // SM blocks in discover = anomaly
      const smOnlyKeys = ['<short_term_memory>','<current_task>','<mission_state>','<mission_brief>','<discovery_summary>','submit_findings'];
      const leaks = smOnlyKeys.filter(k => sysText.includes(k));
      if (phase === 'discover' && leaks.length > 0)
        console.log(`  ⚠ SM BLOCKS IN DISCOVER PHASE: ${leaks.join(', ')}`);

      // ── SYSTEM PROMPT EXCERPT ───────────────────────────────────────────────
      if (sysText) {
        console.log('\nSYSTEM PROMPT (first 400 chars):');
        const lines = excerpt(sysText, 400).split('\n');
        for (const l of lines) console.log(`  ${l}`);
      }

      // ── EFFECTIVE PROMPT (last user message) ────────────────────────────────
      const effText = lastTexts.join('');
      if (effText && msgs.length > 1) {
        console.log('\nEFFECTIVE PROMPT:');
        const lines = excerpt(effText, 600).split('\n');
        for (const l of lines) console.log(`  ${l}`);
      }

      // ── WIPES BEFORE THIS ROUND ─────────────────────────────────────────────
      if (wipes.length > 0) {
        console.log(`\nWIPES (${wipes.length}):`);
        for (const w of wipes) {
          console.log(`  trigger=${w.trigger}  msgs_discarded=${w.msgsBefore}`);
        }
      }

      // ── TOOL CALLS ──────────────────────────────────────────────────────────
      if (toolCalls.length > 0) {
        console.log(`\nTOOL CALLS (${toolCalls.length}):`);
        for (const tc of toolCalls) {
          const invoke = toolInvokes.find(i => i.callId === tc.callId);
          const result = toolResults.find(r => r.callId === tc.callId);
          const cached = invoke?.cached ? ' [CACHE HIT]' : '';

          // Key input fields (skip large nested objects — flatten to k=v)
          const inp = tc.input || {};
          const inputSummary = Object.entries(inp)
            .map(([k, v]) => {
              const vs = typeof v === 'string' ? v : JSON.stringify(v);
              return `${k}=${snip(vs, 80)}`;
            })
            .join('  ');

          console.log(`  ▶ ${short(tc.tool)}${cached}  ${inputSummary}`);

          if (result) {
            const ms2 = result.ms != null ? `${result.ms}ms` : '?ms';
            if (result.errCode) {
              console.log(`    ✗ REJECTED in ${ms2}  errCode=${result.errCode}`);
              if (result.hint) {
                const h = snip(result.hint, 300);
                console.log(`      hint: ${h}`);
              }
            } else {
              // Summarise the result content
              const resultText = (result.result || []).join('\n');
              const preview = snip(resultText, 200);
              console.log(`    ✓ OK in ${ms2}  result: ${preview}`);
            }
          } else if (invoke?.cached) {
            console.log(`    ✓ cache_hit — no engine call`);
          }
        }
      } else if (round) {
        console.log('\n(no tool calls this round)');
      }

      // ── MODEL RESPONSE TEXT (if available via next round's history) ─────────
      const respText = getResponseText(sid, rid);
      if (respText) {
        console.log('\nMODEL TEXT RESPONSE:');
        // Collapse stream fragments (many newlines between tokens) for readable output
        console.log(`  ${snip(respText, 500)}`);
      }
    }

    // ── SESSION FOOTER ──────────────────────────────────────────────────────
    if (sessionEnd) {
      console.log('\n' + '═'.repeat(80));
      console.log(`SESSION END  exit=${sessionEnd.exitKind}  rounds=${sessionEnd.rounds}  tools=${sessionEnd.tools}`);
      console.log(`TOTAL TOKENS  in=${sessionEnd.cumInTok}  out=${sessionEnd.cumOutTok}  peak_round=${sessionEnd.peakTok}`);
      console.log('═'.repeat(80));
    }
  }
  console.log('');
}

// ── --phase ───────────────────────────────────────────────────────────────────

if (flags.has('--phase')) {
  console.log('\n═══ TOKEN BREAKDOWN BY PHASE ═══\n');
  console.log(pad('phase', 12) + lpad('rounds', 8) + lpad('total_in', 11) + lpad('total_out', 11) + lpad('avg_in', 9) + lpad('avg_out', 9) + lpad('peak_in', 9));
  console.log('─'.repeat(69));

  const phaseOrder = ['compose', 'discover', 'active', 'synthesis', 'completed'];
  const phaseStats = {};

  for (const ev of events.filter(e => e.ev === 'ROUND')) {
    const ph = ev.phase || 'unknown';
    if (!phaseStats[ph]) phaseStats[ph] = { rounds: 0, inTok: 0, outTok: 0, peak: 0 };
    phaseStats[ph].rounds++;
    phaseStats[ph].inTok  += ev.inTok  || 0;
    phaseStats[ph].outTok += ev.outTok || 0;
    if ((ev.inTok || 0) > phaseStats[ph].peak) phaseStats[ph].peak = ev.inTok;
  }

  const orderedPhases = [
    ...phaseOrder.filter(p => phaseStats[p]),
    ...Object.keys(phaseStats).filter(p => !phaseOrder.includes(p)),
  ];

  for (const ph of orderedPhases) {
    const s = phaseStats[ph];
    const avgIn  = s.rounds > 0 ? Math.round(s.inTok  / s.rounds) : 0;
    const avgOut = s.rounds > 0 ? Math.round(s.outTok / s.rounds) : 0;
    console.log(
      pad(ph, 12) + lpad(s.rounds, 8) + lpad(s.inTok, 11) + lpad(s.outTok, 11) +
      lpad(avgIn, 9) + lpad(avgOut, 9) + lpad(s.peak, 9)
    );
  }
  console.log('');
}

// ── --sizes ───────────────────────────────────────────────────────────────────
// Breaks each REQ into: system_prompt | history | tool_results | eff_prompt

if (flags.has('--sizes')) {
  console.log('\n═══ MESSAGE SIZE BREAKDOWN PER ROUND ═══\n');
  console.log('(chars, not tokens — indicative only)\n');

  const reqs = events.filter(e => e.ev === 'REQ');
  for (const ev of reqs) {
    if (!Array.isArray(ev.messages) || ev.messages.length === 0) continue;

    const msgs = ev.messages;
    let sysChars = 0, histChars = 0, toolResChars = 0, effChars = 0;

    // Message 0 = system (User role, first message, contains system instructions)
    const sysTexts = msgs[0]?.parts?.filter(p => p.type === 'text').map(p => p.value || '') || [];
    sysChars = sysTexts.join('').length;

    // Last message = effective prompt (User role, final user directive)
    const lastMsg = msgs[msgs.length - 1];
    const lastTexts = lastMsg?.parts?.filter(p => p.type === 'text').map(p => p.value || '') || [];
    effChars = lastTexts.join('').length;

    // Middle messages = history (assistant turns) + tool results
    for (let i = 1; i < msgs.length - 1; i++) {
      const m = msgs[i];
      if (!m.parts) continue;
      for (const p of m.parts) {
        const len = (p.value || '').length + (p.content || []).join('').length + JSON.stringify(p.input || '').length;
        if (p.type === 'tool_result') toolResChars += len;
        else histChars += len;
      }
    }

    const total = sysChars + histChars + toolResChars + effChars;
    const roundMs = events.find(e => e.ev === 'ROUND' && e.sid === ev.sid && e.rid === ev.rid);
    const inTok = roundMs?.inTok ?? '?';

    console.log(`sid=${ev.sid} rid=${lpad(ev.rid, 2)} phase=${pad(ev.phase, 10)}  total_chars=${total}  inTok=${inTok}`);
    console.log(`  sys_prompt  ${lpad(sysChars, 7)} chars ${bar(total > 0 ? sysChars/total : 0)} ${pct(sysChars, total)}`);
    if (histChars > 0)
      console.log(`  history     ${lpad(histChars, 7)} chars ${bar(total > 0 ? histChars/total : 0)} ${pct(histChars, total)}`);
    if (toolResChars > 0)
      console.log(`  tool_results${lpad(toolResChars, 7)} chars ${bar(total > 0 ? toolResChars/total : 0)} ${pct(toolResChars, total)}`);
    console.log(`  eff_prompt  ${lpad(effChars, 7)} chars ${bar(total > 0 ? effChars/total : 0)} ${pct(effChars, total)}`);
    console.log('');
  }
}

// ── --patterns ────────────────────────────────────────────────────────────────
// Detects which structural prompt blocks appear in which phase,
// and flags SM-only blocks leaking into discover (or vice-versa).

if (flags.has('--patterns')) {
  console.log('\n═══ PROMPT STRUCTURE PATTERNS ═══\n');

  // Collect per-phase presence counts for each marker
  const byPhase = {}; // phase → { markerKey → { present: N, total: N } }
  const reqsByPhase = {}; // phase → [ev]

  for (const ev of events.filter(e => e.ev === 'REQ')) {
    const ph = ev.phase || 'unknown';
    if (!reqsByPhase[ph]) reqsByPhase[ph] = [];
    reqsByPhase[ph].push(ev);
  }

  for (const [ph, evs] of Object.entries(reqsByPhase)) {
    byPhase[ph] = {};
    for (const marker of PROMPT_MARKERS) {
      byPhase[ph][marker.key] = { present: 0, total: evs.length, sources: {} };
    }
    for (const ev of evs) {
      const sysText = (ev.messages?.[0]?.parts || [])
        .filter(p => p.type === 'text').map(p => p.value || '').join('');
      const segments = segmentStablePrefix(sysText);
      for (const marker of PROMPT_MARKERS) {
        if (!sysText.includes(marker.key)) continue;
        byPhase[ph][marker.key].present++;
        const foundIn = new Set();
        for (const seg of segments) { if (seg.text.includes(marker.key)) foundIn.add(seg.block); }
        for (const blk of foundIn) {
          byPhase[ph][marker.key].sources[blk] = (byPhase[ph][marker.key].sources[blk] || 0) + 1;
        }
      }
    }
  }

  const phaseOrder = ['compose', 'discover', 'active', 'synthesis', 'completed'];
  const orderedPhases = [
    ...phaseOrder.filter(p => byPhase[p]),
    ...Object.keys(byPhase).filter(p => !phaseOrder.includes(p)),
  ];

  for (const ph of orderedPhases) {
    const counts = byPhase[ph];
    const total  = reqsByPhase[ph]?.length ?? 0;
    console.log(`Phase: ${ph}  (${total} round${total !== 1 ? 's' : ''})`);
    for (const marker of PROMPT_MARKERS) {
      const c = counts[marker.key];
      if (!c) continue;
      const ratio = c.total > 0 ? c.present / c.total : 0;
      const anomaly = marker.smOnly && ph === 'discover' && c.present > 0
        ? '  ⚠ SM block in discover!'
        : (!marker.smOnly && ph === 'active' && marker.key === 'search_objects' && c.present > 0
          ? '  ⚠ discovery block in active?'
          : '');
      const mark = c.present === 0 ? '·' : c.present === c.total ? '✓' : '~';
      console.log(`  ${mark} ${pad(marker.label, 26)} ${lpad(c.present, 3)}/${c.total}${anomaly}`);
      if (anomaly && c.present > 0) {
        const srcEntries = Object.entries(c.sources || {}).sort((a, b) => b[1] - a[1]);
        if (srcEntries.length > 0) {
          const srcStr = srcEntries.map(([blk, n]) => `<${blk}> (${n}×)`).join(', ');
          console.log(`       ${''.padEnd(26)}  source: ${srcStr}`);
        }
      }
    }
    if (ph === 'active') {
      const reqs = reqsByPhase[ph] || [];
      let dupFocus = 0, dupHop = 0, dupAgenda = 0, dupMission = 0;
      let missingFocus = 0, missingHop = 0, missingAgenda = 0, missingReplay = 0, missingBddl = 0, missingNeighbors = 0;
      for (const req of reqs) {
        const check = getOwnershipCheck(req);
        if (check.duplicates.focus_node_id) dupFocus++;
        if (check.duplicates.hop) dupHop++;
        if (check.duplicates.agenda_remaining) dupAgenda++;
        if (check.duplicates.mission_intent) dupMission++;
        if (check.requiredMissing.mission_state_focus) missingFocus++;
        if (check.requiredMissing.mission_state_hop) missingHop++;
        if (check.requiredMissing.mission_state_agenda) missingAgenda++;
        if (check.requiredMissing.replay_focus_node) missingReplay++;
        if (check.requiredMissing.replay_focus_bb_ddl) missingBddl++;
        if (check.requiredMissing.replay_neighbors) missingNeighbors++;
      }
      console.log('  Ownership checks (active):');
      console.log(`    duplicate carriers: focus_node_id=${dupFocus}/${total}, hop=${dupHop}/${total}, agenda_remaining=${dupAgenda}/${total}, mission_intent=${dupMission}/${total}`);
      console.log(`    required missing : mission_state.focus=${missingFocus}/${total}, mission_state.hop=${missingHop}/${total}, mission_state.agenda=${missingAgenda}/${total}, replay.focus_node=${missingReplay}/${total}, replay.bb_ddl=${missingBddl}/${total}, replay.neighbors=${missingNeighbors}/${total}`);
    }
    console.log('');
  }
}

// ── --redundancy ──────────────────────────────────────────────────────────────
// Finds duplicate text appearing in multiple parts of the same REQ.
// Also checks if tool result content reappears in the next REQ's system prompt.

if (flags.has('--redundancy')) {
  console.log('\n═══ REDUNDANCY / DUPLICATE CONTENT ═══\n');
  const MIN_DUP_LEN = 150; // minimum chars to count as a meaningful duplicate

  const reqs = events.filter(e => e.ev === 'REQ');
  let totalDups = 0;

  for (let ri = 0; ri < reqs.length; ri++) {
    const ev = reqs[ri];
    const texts = extractTexts(ev.messages || []);
    const dups = [];

    // Within-request: check every pair of text fragments
    for (let i = 0; i < texts.length; i++) {
      for (let j = i + 1; j < texts.length; j++) {
        const a = texts[i].text;
        const b = texts[j].text;
        if (!a || !b || a.length < MIN_DUP_LEN || b.length < MIN_DUP_LEN) continue;
        // Find longest common substring (simplified: check if one is a substring of other,
        // or find overlap >= MIN_DUP_LEN)
        const overlap = longestCommonSubstring(a, b, MIN_DUP_LEN);
        if (overlap) {
          dups.push({
            src: `msg[${texts[i].msgIdx}] ${texts[i].type}`,
            dst: `msg[${texts[j].msgIdx}] ${texts[j].type}`,
            len: overlap.length,
            preview: overlap.slice(0, 80).replace(/\n/g, '↵'),
          });
        }
      }
    }

    // Cross-request: did any tool result from the previous REQ reappear in this system prompt?
    if (ri > 0) {
      const prevEv = reqs[ri - 1];
      const prevToolResults = extractTexts(prevEv.messages || [])
        .filter(t => t.type === 'tool_result' && t.text.length >= MIN_DUP_LEN);
      const sysText = (ev.messages?.[0]?.parts || [])
        .filter(p => p.type === 'text').map(p => p.value || '').join('');
      for (const tr of prevToolResults) {
        const overlap = longestCommonSubstring(sysText, tr.text, MIN_DUP_LEN);
        if (overlap) {
          dups.push({
            src: `prev REQ rid=${prevEv.rid} tool_result`,
            dst: `this REQ rid=${ev.rid} sys_prompt`,
            len: overlap.length,
            preview: overlap.slice(0, 80).replace(/\n/g, '↵'),
            crossReq: true,
          });
        }
      }
    }

    if (dups.length > 0) {
      totalDups += dups.length;
      console.log(`sid=${ev.sid} rid=${ev.rid} phase=${ev.phase} — ${dups.length} duplicate section(s):`);
      for (const d of dups) {
        const tag = d.crossReq ? '  [cross-request]' : '  [within-request]';
        console.log(`${tag} ${d.src} ↔ ${d.dst}`);
        console.log(`    ${d.len} chars repeated — "${d.preview}${d.len > 80 ? '…' : ''}"`);
      }
      console.log('');
    }
  }

  if (totalDups === 0) console.log('No significant duplicates found (threshold: ' + MIN_DUP_LEN + ' chars).\n');
  else console.log(`Total duplicate sections found: ${totalDups}\n`);
}

// Finds the longest common substring of length >= minLen.
// Returns the string or null.
function longestCommonSubstring(a, b, minLen) {
  // For large strings, use a rolling check instead of O(n^2) DP
  // Check if b (or significant chunks of it) appears in a
  const step = Math.max(minLen, 200);
  for (let start = 0; start + minLen <= b.length; start += step) {
    const chunk = b.slice(start, start + Math.min(step, b.length - start));
    if (chunk.length >= minLen && a.includes(chunk)) return chunk;
  }
  // Also check a in b
  for (let start = 0; start + minLen <= a.length; start += step) {
    const chunk = a.slice(start, start + Math.min(step, a.length - start));
    if (chunk.length >= minLen && b.includes(chunk)) return chunk;
  }
  return null;
}

// ── --rejected ────────────────────────────────────────────────────────────────

if (flags.has('--rejected')) {
  console.log('\n═══ REJECTIONS ═══\n');
  const rejected = events.filter(e => e.ev === 'TOOL_RESULT' && e.errCode);
  if (rejected.length === 0) { console.log('No rejections found.\n'); }
  const byField = {};
  for (const ev of rejected) {
    const hint = String(ev.hint || '');
    const m = hint.match(/Invalid [^—]+—\s*([a-zA-Z0-9_.\[\]-]+)\s*:/);
    if (m?.[1]) byField[m[1]] = (byField[m[1]] || 0) + 1;
    else if (hint.toLowerCase().includes('route')) byField.route_requests = (byField.route_requests || 0) + 1;
    else if (hint.toLowerCase().includes('focus_node_id')) byField.focus_node_id = (byField.focus_node_id || 0) + 1;
  }
  if (Object.keys(byField).length > 0) {
    const fieldSummary = Object.entries(byField).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k}×${v}`).join(', ');
    console.log(`reject_by_field: ${fieldSummary}\n`);
  }
  for (const ev of rejected) {
    const expected = isExpectedGateReject(ev);
    console.log(`[${ts(ev.t)}] sid=${ev.sid} rid=${ev.rid} tool=${short(ev.tool)}`);
    console.log(`  errCode: ${ev.errCode}${expected ? '  (expected_gate)' : ''}`);
    if (ev.hint) {
      const h = String(ev.hint);
      console.log(`  hint:    ${h.length > 400 ? h.slice(0, 400) + '…' : h}`);
    }
    if (ev.result && ev.result[0]) {
      try {
        const parsed = JSON.parse(ev.result[0]);
        const keys = Object.keys(parsed).filter(k => k !== 'error' && k !== 'hint');
        if (keys.length) console.log(`  extra:   ${keys.map(k => `${k}=${JSON.stringify(parsed[k]).slice(0,60)}`).join(', ')}`);
      } catch { /* not JSON */ }
    }
    console.log('');
  }
}

// ── --loops ───────────────────────────────────────────────────────────────────

if (flags.has('--loops')) {
  console.log('\n═══ REPEATED TOOL CALLS (loops) ═══\n');
  let found = false;
  for (const [sid, evs] of sessions) {
    const calls = evs.filter(e => e.ev === 'TOOL_CALL');
    let prev = null, streak = 1;
    for (const c of calls) {
      const sig = `${c.tool}::${JSON.stringify(c.input)}`;
      if (prev && sig === prev.sig) {
        streak++;
        if (streak === 2) { console.log(`sid=${sid} rid=${c.rid} tool=${short(c.tool)} — repeated ×${streak} (identical input)`); found = true; }
        else { console.log(`  … ×${streak} at rid=${c.rid}`); }
      } else { prev = { sig }; streak = 1; }
    }
  }
  if (!found) console.log('No repeated same-input tool calls detected.');
  console.log('');
}

// ── --wipes ───────────────────────────────────────────────────────────────────

if (flags.has('--wipes')) {
  console.log('\n═══ MEMORY WIPES ═══\n');
  const wipes = events.filter(e => e.ev === 'WIPE');
  if (wipes.length === 0) { console.log('No wipes recorded.\n'); }
  for (const ev of wipes) {
    // Find the ROUND token count for this rid
    const round = events.find(e => e.ev === 'ROUND' && e.sid === ev.sid && e.rid === ev.rid);
    const inTok = round ? `inTok=${round.inTok}` : '';
    console.log(`[${ts(ev.t)}] sid=${ev.sid} rid=${lpad(ev.rid,2)}  trigger=${pad(ev.trigger,22)} msgs_before=${ev.msgsBefore}  ${inTok}`);
  }
  if (wipes.length > 0) console.log(`\nTotal: ${wipes.length} wipe(s)\n`);
}

// ── --waste ───────────────────────────────────────────────────────────────────

if (flags.has('--waste')) {
  console.log('\n═══ TOKEN WASTE ANALYSIS ═══\n');
  for (const [sid, evs] of sessions) {
    const rounds = evs.filter(e => e.ev === 'ROUND');
    const wipes  = evs.filter(e => e.ev === 'WIPE');
    const totalIn = rounds.reduce((s, r) => s + (r.inTok || 0), 0);
    const wipeRids = new Set(wipes.map(w => w.rid));
    const tokAtWipe = rounds.filter(r => wipeRids.has(r.rid)).reduce((s, r) => s + (r.inTok || 0), 0);
    const ratio = totalIn > 0 ? ((tokAtWipe / totalIn) * 100).toFixed(1) : '0.0';

    console.log(`sid=${sid}`);
    console.log(`  total_input_tokens:  ${totalIn}`);
    console.log(`  wipes:               ${wipes.length}`);
    console.log(`  tokens_at_wipe_time: ${tokAtWipe}  (${ratio}% of total input)`);
    for (const w of wipes) {
      const r = rounds.find(x => x.rid === w.rid);
      console.log(`    rid=${w.rid} trigger=${w.trigger}  inTok=${r?.inTok ?? '?'}  msgs_discarded=${w.msgsBefore}`);
    }
    console.log('');
  }
}

// ── --tools ───────────────────────────────────────────────────────────────────

if (flags.has('--tools')) {
  console.log('\n═══ TOOL STATISTICS ═══\n');
  const stats = {};
  for (const ev of events.filter(e => e.ev === 'TOOL_RESULT')) {
    const s = stats[ev.tool] || (stats[ev.tool] = { calls: 0, rejected: 0, totalMs: 0 });
    s.calls++;
    s.totalMs += ev.ms || 0;
    if (ev.errCode) s.rejected++;
  }
  const cacheHits = {};
  for (const ev of events.filter(e => e.ev === 'TOOL_INVOKE' && e.cached)) {
    cacheHits[ev.tool] = (cacheHits[ev.tool] || 0) + 1;
  }
  const allTools = new Set([...Object.keys(stats), ...Object.keys(cacheHits)]);
  const sorted = [...allTools].sort((a, b) => (stats[b]?.calls || 0) - (stats[a]?.calls || 0));

  console.log(pad('tool', 26) + lpad('calls', 7) + lpad('cached', 8) + lpad('rejected', 10) + lpad('rej%', 6) + lpad('avg_ms', 8));
  console.log('─'.repeat(65));
  for (const tool of sorted) {
    const s = stats[tool] || { calls: 0, rejected: 0, totalMs: 0 };
    const hits = cacheHits[tool] || 0;
    const avg  = s.calls > 0 ? Math.round(s.totalMs / s.calls) : 0;
    const rp   = s.calls > 0 ? ((s.rejected / s.calls) * 100).toFixed(0) : '0';
    console.log(pad(short(tool), 26) + lpad(s.calls, 7) + lpad(hits, 8) + lpad(s.rejected, 10) + lpad(rp + '%', 6) + lpad(avg, 8));
  }
  console.log('');
}

// ── --growth ──────────────────────────────────────────────────────────────────
// Per-round total message context in chars and growth % vs previous round.
// Uses a global monotonic counter so repeated per-phase round IDs don't confuse the output.

if (flags.has('--growth')) {
  console.log('\n═══ CONTEXT GROWTH PER ROUND ═══\n');
  console.log('(total message content chars: sys + hist + tool_results + prompt)\n');

  const WARN_PCT = 0.25;
  const CRIT_PCT = 0.50;

  const TOOL_SHORT = t => t
    .replace('lineage_get_object_detail',   'detail')
    .replace('lineage_get_neighbor_columns','neighbor_cols')
    .replace('lineage_search_objects',      'search')
    .replace('lineage_search_ddl',          'search_ddl')
    .replace('lineage_detect_graph_patterns','detect_patterns')
    .replace('lineage_submit_findings',     'submit')
    .replace('lineage_present_result',      'present_result')
    .replace('lineage_start_exploration',   'start_exploration')
    .replace(/^lineage_/, '');

  for (const [sid, evs] of sessions) {
    const reqs      = evs.filter(e => e.ev === 'REQ');
    const toolCalls = evs.filter(e => e.ev === 'TOOL_CALL');
    const toolRes   = evs.filter(e => e.ev === 'TOOL_RESULT' && !e.errCode);
    let prevTotal = 0;
    let globalRound = 0; // monotonic counter — avoids ambiguous "Round 1 | completed" repeats
    console.log(`sid: ${sid}`);

    for (const req of reqs) {
      globalRound++;
      let total = 0;
      for (const msg of (req.messages || [])) {
        for (const p of (msg.parts || [])) {
          total += (p.value  || '').length;
          total += (p.content || []).join('').length;
          if (p.input) total += JSON.stringify(p.input).length;
        }
      }

      const growth = prevTotal > 0 ? (total - prevTotal) / prevTotal : null;
      let flag = '';
      if (growth !== null) {
        if      (growth >= CRIT_PCT) flag = '  ⚡ runaway';
        else if (growth >= WARN_PCT) flag = '  ⚠ near threshold';
      }
      const growthStr = growth !== null
        ? (growth >= 0 ? '+' : '') + (growth * 100).toFixed(0) + '%'
        : 'baseline';

      console.log(`  Round ${lpad(globalRound, 2)} | ${pad(req.phase || '?', 12)} | ${lpad(total.toLocaleString(), 11)} chars | ${growthStr}${flag}`);

      // Per-round tool call detail: counts, hops, column counts
      const roundCalls = toolCalls.filter(tc => tc.rid === req.rid);
      if (roundCalls.length > 0) {
        const counts = {};
        for (const tc of roundCalls) {
          const short = TOOL_SHORT(tc.tool || 'unknown');
          counts[short] = (counts[short] || 0) + 1;
        }
        const toolSummary = Object.entries(counts).map(([t, n]) => `${t}×${n}`).join('  ');
        console.log(`             tools: ${toolSummary}`);

        // Column counts from get_object_detail results in this round
        const detailColCounts = [];
        for (const tr of toolRes.filter(r => r.rid === req.rid && r.tool === 'lineage_get_object_detail')) {
          try {
            const parsed = JSON.parse((tr.result || ['{}'])[0]);
            if (Array.isArray(parsed.columns)) detailColCounts.push(parsed.columns.length);
          } catch {}
        }
        if (detailColCounts.length > 0) {
          console.log(`             detail cols returned: ${detailColCounts.join(', ')} (${detailColCounts.reduce((a,b)=>a+b,0)} total)`);
        }
      }

      prevTotal = total;
    }
    console.log('');
  }
}

// ── --tool-bloat ──────────────────────────────────────────────────────────────
// Per-tool successful result payload size stats.

if (flags.has('--tool-bloat')) {
  console.log('\n═══ TOOL RESULT BLOAT ═══\n');

  const bloat = {};
  let sessionTotal = 0;

  for (const ev of events.filter(e => e.ev === 'TOOL_RESULT' && !e.errCode)) {
    const chars = (ev.result || []).join('').length;
    if (!bloat[ev.tool]) bloat[ev.tool] = { calls: 0, totalChars: 0, maxChars: 0 };
    bloat[ev.tool].calls++;
    bloat[ev.tool].totalChars += chars;
    if (chars > bloat[ev.tool].maxChars) bloat[ev.tool].maxChars = chars;
    sessionTotal += chars;
  }

  if (Object.keys(bloat).length === 0) {
    console.log('No successful tool results found.\n');
  } else {
    const sorted = Object.entries(bloat).sort((a, b) => b[1].totalChars - a[1].totalChars);
    console.log(pad('tool', 30) + lpad('calls', 7) + lpad('avg-chars', 11) + lpad('max-chars', 11) + lpad('total%', 8));
    console.log('─'.repeat(67));
    for (const [tool, s] of sorted) {
      const avg  = s.calls > 0 ? Math.round(s.totalChars / s.calls) : 0;
      const pct2 = sessionTotal > 0 ? ((s.totalChars / sessionTotal) * 100).toFixed(0) + '%' : '0%';
      console.log(pad(short(tool), 30) + lpad(s.calls, 7) + lpad(avg.toLocaleString(), 11) + lpad(s.maxChars.toLocaleString(), 11) + lpad(pct2, 8));
    }
    console.log(`\nTotal tool result chars: ${sessionTotal.toLocaleString()}\n`);
  }
}

// ── --detail-metrics ──────────────────────────────────────────────────────────
// Per-round content depth + math formula violation scan.

if (flags.has('--detail-metrics')) {
  console.log('\n═══ ANSWER DETAIL & MATH VALIDATION ═══\n');

  const BADGE_MAX   = 50;
  const NOTE_MAX    = 200;
  const CHAT_SHORT  = 80;   // chars below which a chat response is suspiciously short
  // Detect bare single-$ inline math only. $$ block math is correct (webview converts it).
  const MATH_RE_DM  = /(?<!\$)\$(?!\$)[A-Za-z@_\\][^$\n]{0,100}\$(?!\$)/g;
  const MATH_BLOCK_DOLLAR_RE = /\$\$[\s\S]*?\$\$/g;
  const MATH_FENCE_RE = /```math[\s\S]*?```/g;

  // Per-round stats from TOOL_CALL events (each call recorded once, no history duplication)
  const ridStats = {};
  for (const ev of events.filter(e => e.ev === 'REQ')) {
    ridStats[ev.rid] = ridStats[ev.rid] || {
      sid: ev.sid, rid: ev.rid, phase: ev.phase || '?',
      stmChars: 0,
      sectionsChars: 0, sectionCount: 0,
      badgeLabelMax: 0, badgeLabelViolations: [],
      noteCaptionMax: 0, noteCaptionViolations: [],
      chatOutputChars: 0,
      presentResultChars: 0,
    };
    ridStats[ev.rid].phase = ev.phase || ridStats[ev.rid].phase;
  }

  for (const tc of events.filter(e => e.ev === 'TOOL_CALL')) {
    const s   = ridStats[tc.rid];
    if (!s) continue;
    const name = tc.tool || '';
    const inp  = tc.input || {};

    if (name.includes('submit_findings')) {
      for (const sec of (inp.sections || [])) {
        s.sectionsChars += (sec.text || '').length;
        s.sectionCount++;
      }
      // badge_label and note_caption are top-level fields on submit_findings, not in nodes[]
      const bl = (inp.badge_label  || '').length;
      const nc = (inp.note_caption || '').length;
      if (bl > s.badgeLabelMax)  s.badgeLabelMax  = bl;
      if (nc > s.noteCaptionMax) s.noteCaptionMax = nc;
      if (bl > BADGE_MAX) s.badgeLabelViolations.push({ id: inp.focus_node_id || '?', chars: bl, val: (inp.badge_label || '').slice(0, 40) });
      if (nc > NOTE_MAX)  s.noteCaptionViolations.push({ id: inp.focus_node_id || '?', chars: nc });
    }

    if (name.includes('present_result')) {
      const c = JSON.stringify(inp).length;
      if (c > s.presentResultChars) s.presentResultChars = c;
    }
  }

  // STM + chat output + math violations from REQ message diffs
  const dmReqs = events.filter(e => e.ev === 'REQ');
  const allMathViolations = [];
  const mathFormatCounts = { block_dollar: 0, math_fence: 0 };
  const routeQuestionStats = { total: 0, generic: 0, concrete: 0 };

  for (let i = 0; i < dmReqs.length; i++) {
    const req  = dmReqs[i];
    const msgs = req.messages || [];
    const s    = ridStats[req.rid];
    if (!s) continue;

    // STM: search last user message (current hop task) for <short_term_memory> block
    const lastMsg = msgs[msgs.length - 1];
    if (lastMsg?.role === 'user') {
      for (const p of (lastMsg.parts || [])) {
        if (p.type !== 'text') continue;
        const m = /<short_term_memory>[\s\S]*?<\/short_term_memory>/.exec(p.value || '');
        if (m) s.stmChars = Math.max(s.stmChars, m[0].length);
      }
    }

    // New messages since last REQ (excludes last = current user message)
    const prevLen = i > 0 ? (dmReqs[i - 1].messages || []).length : 0;
    const newMsgs = msgs.slice(prevLen, msgs.length - 1);

    for (const msg of newMsgs) {
      for (const p of (msg.parts || [])) {
        if (p.type !== 'text') continue;
        if (msg.role === 'assistant') s.chatOutputChars += (p.value || '').length;
        const text = p.value || '';
        mathFormatCounts.block_dollar += countRegexMatches(text, MATH_BLOCK_DOLLAR_RE);
        mathFormatCounts.math_fence += countRegexMatches(text, MATH_FENCE_RE);

        // Math violation: scan all new text parts (system prompt on round 0, assistant responses)
        const cleaned = text.replace(/```math[\s\S]*?```/g, '');
        MATH_RE_DM.lastIndex = 0;
        let m;
        while ((m = MATH_RE_DM.exec(cleaned)) !== null) {
          allMathViolations.push({ rid: req.rid, role: msg.role, excerpt: m[0].slice(0, 100).replace(/\n/g, '↵') });
        }
      }
    }

    // Also scan system prompt text on the first round for math violations in instructions
    if (i === 0) {
      const sysParts = (msgs[0]?.parts || []).filter(p => p.type === 'text');
      for (const p of sysParts) {
        const text = p.value || '';
        mathFormatCounts.block_dollar += countRegexMatches(text, MATH_BLOCK_DOLLAR_RE);
        mathFormatCounts.math_fence += countRegexMatches(text, MATH_FENCE_RE);
        const cleaned = text.replace(/```math[\s\S]*?```/g, '');
        MATH_RE_DM.lastIndex = 0;
        let m;
        while ((m = MATH_RE_DM.exec(cleaned)) !== null) {
          allMathViolations.push({ rid: req.rid, role: 'system_prompt', excerpt: m[0].slice(0, 100).replace(/\n/g, '↵') });
        }
      }
    }
  }

  // ANSWER_TEXT events capture the final round's response — never in REQ history because there is no subsequent REQ.
  for (const ev of events.filter(e => e.ev === 'ANSWER_TEXT')) {
    const s = ridStats[ev.rid];
    if (!s) continue;
    const chars = ev.chars || (ev.text || '').length;
    s.chatOutputChars = Math.max(s.chatOutputChars, chars);
    s.finalAnswerExcerpt = (ev.text || '').slice(0, 300).replace(/\n/g, '↵');
    const text = ev.text || '';
    mathFormatCounts.block_dollar += countRegexMatches(text, MATH_BLOCK_DOLLAR_RE);
    mathFormatCounts.math_fence += countRegexMatches(text, MATH_FENCE_RE);
    const cleaned = text.replace(/```math[\s\S]*?```/g, '');
    MATH_RE_DM.lastIndex = 0;
    let mf;
    while ((mf = MATH_RE_DM.exec(cleaned)) !== null) {
      allMathViolations.push({ rid: ev.rid, role: 'assistant (final answer)', excerpt: mf[0].slice(0, 100).replace(/\n/g, '↵') });
    }
  }

  for (const tc of events.filter(e => e.ev === 'TOOL_CALL' && (e.tool || '').includes('submit_findings'))) {
    const routes = tc.input?.route_requests;
    if (!Array.isArray(routes)) continue;
    for (const r of routes) {
      const q = r?.question;
      if (typeof q !== 'string') continue;
      routeQuestionStats.total++;
      if (isGenericRouteQuestion(q)) routeQuestionStats.generic++;
      else routeQuestionStats.concrete++;
    }
  }

  // Print per-round detail
  const rids = Object.keys(ridStats).map(Number).sort((a, b) => a - b);
  for (const rid of rids) {
    const s = ridStats[rid];
    console.log(`Round ${lpad(s.rid, 2)} | ${s.phase}`);

    if (s.stmChars > 0)
      console.log(`  short_term_memory   : ${s.stmChars.toLocaleString()} chars`);
    else
      console.log(`  short_term_memory   : — (not present)`);

    if (s.sectionCount > 0) {
      console.log(`  sections text       : ${s.sectionsChars.toLocaleString()} chars  [${s.sectionCount} section${s.sectionCount !== 1 ? 's' : ''}]`);
      const blLine = s.badgeLabelViolations.length > 0
        ? `  ⚡ ${s.badgeLabelViolations.length} violation(s): ${s.badgeLabelViolations.map(v => `${v.id}(${v.chars}ch)`).join(', ')}`
        : `  OK (max ${s.badgeLabelMax} chars)`;
      console.log(`  badge labels        :${blLine}`);
      const ncLine = s.noteCaptionViolations.length > 0
        ? `  ⚡ ${s.noteCaptionViolations.length} violation(s): ${s.noteCaptionViolations.map(v => `${v.id}(${v.chars}ch)`).join(', ')}`
        : `  OK (max ${s.noteCaptionMax} chars)`;
      console.log(`  note captions       :${ncLine}`);
    } else {
      console.log(`  sections text       : — (no submit_findings this round)`);
    }

    if (s.presentResultChars > 0)
      console.log(`  present_result      : ${s.presentResultChars.toLocaleString()} chars`);

    if (s.chatOutputChars > 0) {
      const shortFlag = s.chatOutputChars < CHAT_SHORT ? '  ⚠ short — possible confusion' : '';
      const capturedFlag = s.finalAnswerExcerpt ? '  [ANSWER_TEXT]' : '';
      console.log(`  chat output         : ${s.chatOutputChars.toLocaleString()} chars${shortFlag}${capturedFlag}`);
      if (s.finalAnswerExcerpt) {
        console.log(`  answer excerpt      : "${s.finalAnswerExcerpt.slice(0, 200)}"`);
      }
    } else {
      console.log(`  chat output         : — (no new assistant text this round)`);
    }

    console.log('');
  }

  // Math violations summary
  if (allMathViolations.length > 0) {
    console.log(`MATH FORMULA VIOLATIONS (${allMathViolations.length}):`);
    for (const v of allMathViolations) {
      console.log(`  Round ${v.rid} | ${v.role}:`);
      console.log(`    "${v.excerpt}"`);
      console.log(`    → bare $…$ outside \`\`\`math\`\`\` fence — violates rendering contract`);
    }
  } else {
    console.log('MATH FORMULA VIOLATIONS: none found ✓');
  }
  console.log(`MATH FORMAT COUNTS: $$ blocks=${mathFormatCounts.block_dollar}  \`\`\`math\`\`\` fences=${mathFormatCounts.math_fence}  bare-$ violations=${allMathViolations.length}`);
  if (routeQuestionStats.total > 0) {
    console.log(`ROUTE QUESTION QUALITY: concrete=${routeQuestionStats.concrete}/${routeQuestionStats.total}  generic=${routeQuestionStats.generic}/${routeQuestionStats.total}`);
  } else {
    console.log('ROUTE QUESTION QUALITY: no route_requests questions found');
  }
  console.log('');
}

// ── --ct ──────────────────────────────────────────────────────────────────────
// Column Tracing session analysis: detects CT runs, reports per-hop coverage,
// CT-specific rejection breakdown, and column propagation edges.

if (flags.has('--ct')) {
  console.log('\n═══ COLUMN TRACING ANALYSIS ═══\n');

  for (const [sid, evs] of sessions) {
    console.log(`sid: ${sid}`);

    // Detect CT activation: start_exploration with non-empty targetColumns
    const ctStarts = evs.filter(e =>
      e.ev === 'TOOL_CALL' && (e.tool || '').includes('start_exploration')
      && Array.isArray((e.input || {}).targetColumns)
      && (e.input.targetColumns || []).length > 0
    );

    if (ctStarts.length === 0) {
      console.log('  Not a CT session — no start_exploration with targetColumns found.\n');
      continue;
    }

    const lastStart  = ctStarts[ctStarts.length - 1];
    const trackedCols = lastStart.input.targetColumns || [];
    console.log(`  CT session  |  columns tracked (${trackedCols.length}): ${trackedCols.join(', ')}\n`);

    // CT-specific rejections
    const CT_CODES = ['ct_requires_sm', 'column_flow_required', 'column_flow_validation_failed'];
    const ctRejects = evs.filter(e => e.ev === 'TOOL_RESULT' && CT_CODES.includes(e.errCode));
    const byCode = {};
    for (const r of ctRejects) byCode[r.errCode] = (byCode[r.errCode] || 0) + 1;

    console.log('  CT rejections:');
    for (const code of CT_CODES) {
      const n = byCode[code] || 0;
      const flag = code === 'column_flow_required' && n > 0 ? '  ← VIOLATION' : '';
      console.log(`    ${code.padEnd(37)} ${String(n).padStart(3)}${flag}`);
    }
    console.log('');

    // Per-hop analysis: one row per submit_findings TOOL_CALL
    const submitHops = evs
      .filter(e => e.ev === 'TOOL_CALL' && (e.tool || '').includes('submit_findings'))
      .map(tc => {
        const inp     = tc.input || {};
        const result  = evs.find(e => e.ev === 'TOOL_RESULT' && e.callId === tc.callId);
        const verdict = (inp.verdict || '').toLowerCase();
        const focus   = inp.focus_node_id || '?';
        const flows   = Array.isArray(inp.column_flow) ? inp.column_flow : [];
        const isPrune = verdict === 'prune';
        const errCode = result ? result.errCode : undefined;
        let status;
        if      (errCode === 'column_flow_required')          status = 'VIOLATION (flow missing)';
        else if (errCode === 'column_flow_validation_failed') status = `REJECTED (validation failed)`;
        else if (errCode)                                     status = `REJECTED (${errCode})`;
        else if (isPrune)                                     status = 'OK (prune)';
        else if (flows.length === 0)                          status = 'WARN (no flow, accepted)';
        else                                                  status = 'OK';
        return { focus, verdict, flows, flowCount: flows.length, isPrune, errCode, status };
      });

    if (submitHops.length === 0) {
      console.log('  No submit_findings calls found.\n');
      continue;
    }

    const fW = 32;
    console.log(`  ${'hop'.padStart(3)}  ${'focus_node'.padEnd(fW)}  ${'verdict'.padEnd(8)}  ${'flow#'.padStart(5)}  status`);
    console.log(`  ${'─'.repeat(3)}  ${'─'.repeat(fW)}  ${'─'.repeat(8)}  ${'─'.repeat(5)}  ${'─'.repeat(26)}`);
    let hop = 0;
    for (const h of submitHops) {
      hop++;
      const focusTrunc = h.focus.length > fW ? h.focus.slice(0, fW - 1) + '…' : h.focus;
      console.log(`  ${String(hop).padStart(3)}  ${focusTrunc.padEnd(fW)}  ${(h.verdict || '?').padEnd(8)}  ${String(h.flowCount).padStart(5)}  ${h.status}`);
    }

    const nonPrune  = submitHops.filter(h => !h.isPrune);
    const withFlow  = nonPrune.filter(h => h.flowCount > 0 && !h.errCode);
    const pruned    = submitHops.filter(h => h.isPrune);
    const violated  = submitHops.filter(h => h.errCode === 'column_flow_required');
    const covPct    = nonPrune.length > 0 ? Math.round((withFlow.length / nonPrune.length) * 100) : 100;

    console.log('');
    console.log(`  Coverage: ${withFlow.length}/${nonPrune.length} non-prune hops with flow (${covPct}%)  |  prune hops: ${pruned.length}  |  violations: ${violated.length}`);
    console.log('');

    // Column propagation: aggregate from→out edges across all flow entries
    const edges = {};
    for (const h of submitHops) {
      for (const f of h.flows) {
        const outCol = f.out_col || '?';
        for (const c of (f.contributors || [])) {
          const key = `${c.from_col || '?'}→${outCol}`;
          if (!edges[key]) edges[key] = { from: c.from_col || '?', to: outCol, fromNode: c.from_node || '?', role: c.role || '', count: 0 };
          edges[key].count++;
        }
      }
    }
    const edgeList = Object.values(edges).sort((a, b) => b.count - a.count);
    if (edgeList.length > 0) {
      console.log('  Column propagation edges (from_col → out_col):');
      const eW = 30;
      for (const e of edgeList) {
        const fromTrunc = e.from.length > eW ? e.from.slice(0, eW - 1) + '…' : e.from;
        const toTrunc   = e.to.length   > eW ? e.to.slice(0, eW - 1)   + '…' : e.to;
        console.log(`    ${fromTrunc.padEnd(eW)} → ${toTrunc.padEnd(eW)}  [${e.role}]  (${e.count}×)`);
      }
    } else {
      console.log('  No column_flow entries found — all hops pruned or no CT activity.');
    }
    console.log('');
  }
}

// ── --timeline ────────────────────────────────────────────────────────────────

if (flags.has('--timeline')) {
  console.log('\n═══ TIMELINE ═══\n');
  const display = filterSid ? events : (sessions[0]?.[1] ?? []);
  for (const ev of display) {
    const base = `[${ts(ev.t)}] rid=${lpad(ev.rid, 2)} ${pad(ev.ev, 14)}`;
    switch (ev.ev) {
      case 'SESSION_START':
        console.log(`${base} model=${ev.modelId}  maxTok=${ev.maxTokens}`);
        break;
      case 'REQ':
        console.log(`${base} phase=${pad(ev.phase, 10)}  msgs=${ev.msgCount}  tools=[${(ev.tools || []).map(short).join(',')}]  mode=${ev.mode}`);
        break;
      case 'TOOL_CALL':
        console.log(`${base} tool=${short(ev.tool)}  cid=${ev.callId}`);
        break;
      case 'TOOL_INVOKE':
        console.log(`${base} tool=${short(ev.tool)}  cached=${ev.cached}`);
        break;
      case 'TOOL_RESULT': {
        const err = ev.errCode ? `  ERR=${ev.errCode}` : '';
        console.log(`${base} tool=${short(ev.tool)}  ms=${ev.ms}${err}`);
        if (ev.hint) console.log(`${''.padEnd(base.length + 1)}hint: ${String(ev.hint).slice(0, 200)}`);
        break;
      }
      case 'ROUND':
        console.log(`${base} phase=${pad(ev.phase, 10)}  ms=${ev.ms}  in=${ev.inTok}  out=${ev.outTok}  tools=${ev.toolCount}`);
        break;
      case 'WIPE':
        console.log(`${base} trigger=${ev.trigger}  msgs_before=${ev.msgsBefore}`);
        break;
      case 'SESSION_END':
        console.log(`${base} exit=${ev.exitKind}  rounds=${ev.rounds}  cumIn=${ev.cumInTok}  cumOut=${ev.cumOutTok}`);
        break;
      default:
        console.log(`${base}`);
    }
  }
  console.log('');
}
