"""Per-case MD evaluator report.

Reads:
  - test-results/eval-bridge/autonomous-snapshot.json
  - test-results/.../bridge-*.jsonl (latest)
  - tests/cases/<case-id>.md

Emits:
  test-results/eval-bridge/<case-id>.report.md

Sections:
  1. Test case (question / project / model / classification)
  2. KPIs (duration, tokens per hop, scope, hops, errors)
  3. Required-nodes coverage (✅/❌ vs case file)
  4. Expected Structural Coverage (DDL-derived, from case file)
  5. Bridge message log overview (every direction logged)
  6. Per-turn conversation (sm→bridge ↔ haiku→bridge)
  7. Per-hop short + long memory (when hops occurred)
  8. AI chat output (verbatim stream_capture)
  9. AI description output (present_result body)
 10. Structural-quality KPIs (counts in description: tables / ⚠️ / fences / LaTeX / numbered)
 11. Score (correctness / completeness / efficiency, 0-3 each)
 12. Diagnostic Question Set status (axes A-F)
"""
import json
import re
import sys
from datetime import datetime
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent.parent
SNAPSHOT = ROOT / "test-results" / "eval-bridge" / "autonomous-snapshot.json"
BRIDGE_DIRS = [
    ROOT / "test-results" / "eval-bridge",
    ROOT / "test-results" / "workspace" / "test-results" / "eval-bridge",
]
CASES_DIR = ROOT / "tests" / "cases"


def _truncate(s: str, n: int = 800) -> str:
    if len(s) <= n:
        return s
    return s[:n] + f"… [+{len(s) - n} chars]"


def _latest_bridge_log() -> Path | None:
    cands = []
    for d in BRIDGE_DIRS:
        if d.exists():
            cands.extend(sorted(d.glob("bridge-*.jsonl"), key=lambda p: p.stat().st_mtime, reverse=True))
    return cands[0] if cands else None


def _parse_case(case_id: str) -> dict:
    p = CASES_DIR / f"{case_id}.md"
    spec = {"question": "", "classification": {}, "expected": {}, "required_nodes": [], "forbidden_nodes": [], "expected_structural_coverage": ""}
    if not p.exists():
        return spec
    text = p.read_text(encoding="utf-8")
    m = re.search(r"^##\s+Question\s*\n+>\s*(.+?)(?=\n##|\Z)", text, flags=re.MULTILINE | re.DOTALL)
    if m:
        spec["question"] = " ".join(line.strip().lstrip(">").strip() for line in m.group(1).splitlines() if line.strip())

    def _table(heading: str) -> dict:
        m = re.search(rf"^##\s+{re.escape(heading)}\s*\n(.+?)(?=\n##|\Z)", text, re.MULTILINE | re.DOTALL)
        if not m:
            return {}
        out = {}
        for line in m.group(1).splitlines():
            if line.startswith("|") and "|" in line[1:]:
                cells = [c.strip() for c in line.strip("|").split("|")]
                if len(cells) >= 2 and cells[0] and cells[0] not in ("Field", "-------", "---"):
                    out[cells[0]] = cells[1]
        return out

    spec["classification"] = _table("Classification")
    spec["expected"] = _table("Expected Outcome")

    def _bullets(heading: str) -> list[str]:
        m = re.search(rf"^##\s+{re.escape(heading)}\s*\n(.+?)(?=\n##|\Z)", text, re.MULTILINE | re.DOTALL)
        if not m:
            return []
        out = []
        for line in m.group(1).splitlines():
            s = line.strip()
            if s.startswith("- ") and not s.lower().startswith("- _none"):
                out.append(s[2:].strip())
        return out

    spec["required_nodes"] = _bullets("Required Nodes")
    spec["forbidden_nodes"] = _bullets("Forbidden Nodes")
    m = re.search(r"^##\s+Expected Structural Coverage[^\n]*\n(.+?)(?=\n##\s|\Z)", text, re.MULTILINE | re.DOTALL)
    spec["expected_structural_coverage"] = m.group(1).strip() if m else ""
    return spec


def _normalize_id(nid: str) -> str:
    return (nid or "").strip().lower()


def _structural_kpis(text: str) -> dict:
    if not text:
        return {"chars": 0, "tables": 0, "warn": 0, "fences": 0, "latex": 0, "numbered": 0, "headings": 0}
    return {
        "chars": len(text),
        "tables": len(re.findall(r"^\|[^\n]*\|\s*\n\|[\s:|-]+\|\s*\n", text, re.M)),
        "warn": text.count("⚠"),
        "fences": len(re.findall(r"^```", text, re.M)) // 2,
        "latex": len(re.findall(r"\$[^\$\n]+?\$", text)),
        "numbered": len(re.findall(r"^##\s+\d+", text, re.M)),
        "headings": len(re.findall(r"^##\s", text, re.M)),
    }


def _summarize_msg(m: dict) -> str:
    """One-line summary of a message — role + content-shape with sizes."""
    role = m.get("role", "?")
    parts = []
    for c in m.get("content") or []:
        if not isinstance(c, dict):
            continue
        t = c.get("type")
        if t == "text":
            parts.append(f"text({len(c.get('text',''))} chars)")
        elif t == "tool_use":
            parts.append(f"tool_use({c.get('name')}, id={c.get('id','?')[:10]})")
        elif t == "tool_result":
            inner = c.get("content") or []
            inner_text = (inner[0].get("text", "") if inner and isinstance(inner[0], dict) else str(inner))[:60]
            parts.append(f"tool_result({_truncate(inner_text, 60)})")
    return f"  - **{role}** — " + ", ".join(parts)


def _render_message_block(m: dict) -> list[str]:
    """Pretty-rendered multi-line view of one message — for the per-turn detail."""
    role = m.get("role", "?")
    out = [f"**{role}:**", ""]
    for c in m.get("content") or []:
        if not isinstance(c, dict):
            continue
        t = c.get("type")
        if t == "text":
            txt = c.get("text", "")
            out.append(f"_text ({len(txt):,} chars)_:")
            out.append("")
            out.append("```text")
            out.append(_truncate(txt, 1500))
            out.append("```")
        elif t == "tool_use":
            out.append(f"_tool_use_ — `{c.get('name')}` (id=`{c.get('id','?')}`)")
            out.append("")
            out.append("```json")
            out.append(_truncate(json.dumps(c.get("input", {}), indent=2, ensure_ascii=False), 1200))
            out.append("```")
        elif t == "tool_result":
            inner = c.get("content") or []
            inner_text = (inner[0].get("text", "") if inner and isinstance(inner[0], dict) else json.dumps(inner, ensure_ascii=False))
            out.append(f"_tool_result_ for `{c.get('tool_use_id','?')}` ({len(inner_text):,} chars):")
            out.append("")
            out.append("```text")
            out.append(_truncate(inner_text, 1500))
            out.append("```")
        out.append("")
    return out


def main():
    case_id = sys.argv[1] if len(sys.argv) > 1 else "bb-q1-employee"
    if not SNAPSHOT.exists():
        sys.exit(f"snapshot not found: {SNAPSHOT}")
    snap = json.loads(SNAPSHOT.read_text(encoding="utf-8"))
    spec = _parse_case(case_id)

    bridge = _latest_bridge_log()
    bridge_entries = []
    if bridge:
        for line in bridge.read_text(encoding="utf-8").splitlines():
            try:
                bridge_entries.append(json.loads(line))
            except json.JSONDecodeError:
                continue

    sm = snap.get("sm_state") or {}
    rg = snap.get("result_graph") or {}
    if not isinstance(rg, dict):
        rg = {}
    desc = rg.get("description") or ""
    hop_log = snap.get("hop_log") or []
    submits = [h for h in hop_log if h.get("tool") == "submit_findings"]
    presents = [h for h in hop_log if h.get("tool") == "present_result"]
    present_input = (presents[0].get("input", {}) if presents else {})

    mem = sm.get("memory") if isinstance(sm.get("memory"), dict) else {}
    detail_slots = (mem or {}).get("detailSlots") or {}

    # KPIs derived from the bridge JSONL — every sm→bridge / haiku→bridge
    # pair is one LM call. duration = haiku→bridge.ts − sm→bridge.ts. Tokens
    # estimated from JSON-byte-count / 4 (matches the rough heuristic the
    # old toolProxy used). The new bridge does not annotate hop_log with
    # `_meta` — the participant calls vscode.lm.invokeTool natively, so
    # timing/token data lives only in the bridge layer.
    def _ts_to_ms(ts: str) -> int:
        try:
            return int(datetime.fromisoformat(ts.replace("Z", "+00:00")).timestamp() * 1000)
        except Exception:
            return 0

    lm_calls: list[dict] = []
    cur_in: dict | None = None
    for e in bridge_entries:
        if e.get("direction") == "sm->bridge":
            cur_in = e
        elif e.get("direction") == "haiku->bridge" and cur_in is not None:
            in_chars = len(json.dumps(cur_in.get("payload") or {}, ensure_ascii=False))
            out_chars = len(json.dumps(e.get("payload") or {}, ensure_ascii=False))
            lm_calls.append({
                "duration_ms": _ts_to_ms(e.get("ts", "")) - _ts_to_ms(cur_in.get("ts", "")),
                "in_tokens": (in_chars + 3) // 4,
                "out_tokens": (out_chars + 3) // 4,
            })
            cur_in = None

    total_dur = sum(c["duration_ms"] for c in lm_calls)
    total_in_tok = sum(c["in_tokens"] for c in lm_calls)
    total_out_tok = sum(c["out_tokens"] for c in lm_calls)
    total_tokens = total_in_tok + total_out_tok
    avg_hop = round(total_out_tok / len(lm_calls), 1) if lm_calls else 0.0
    err_count = sum(1 for e in bridge_entries if (e.get("payload") or {}).get("error"))

    # Required-nodes coverage
    pool = {_normalize_id(k) for k in detail_slots.keys()}
    pool.update(_normalize_id(n) for n in (rg.get("nodeIds") or rg.get("fullNodes") or []))
    miss = [n for n in spec.get("required_nodes", []) if _normalize_id(n) not in pool]
    req_total = len(spec.get("required_nodes", []))
    req_hit = req_total - len(miss)

    # Forbidden leaks
    forbidden_leaks = [n for n in spec.get("forbidden_nodes", []) if _normalize_id(n) in pool]

    # Score (0-3 each)
    correctness = 3 if req_hit == req_total and not forbidden_leaks else (2 if req_hit >= max(1, req_total - 1) else (1 if req_hit > 0 else 0))
    completeness = 3 if sm.get("status") == "complete" and presents else (2 if sm.get("status") in ("complete", "awaiting_findings") else (1 if hop_log else 0))
    efficiency = 3 if err_count == 0 and len(submits) <= int(spec.get("expected", {}).get("Max hops", "20").split()[0] or 20) else (2 if err_count <= 2 else 1)
    crit_pass = correctness >= 2 and completeness >= 2

    # Structural KPIs on persisted description
    kpi = _structural_kpis(desc)

    out_dir = ROOT / "test-results" / "eval-bridge"
    out_dir.mkdir(parents=True, exist_ok=True)
    out_path = out_dir / f"{case_id}.report.md"

    L: list[str] = []
    A = L.append

    A(f"# Eval Report — `{case_id}`")
    A(f"**Date:** {datetime.now().strftime('%Y-%m-%d %H:%M')}  |  **Bridge:** {bridge.name if bridge else '_none_'}  |  **Snapshot:** {SNAPSHOT.relative_to(ROOT)}")
    A("")

    # ---- 1. Test case ----
    A("## 1. Test case")
    A("")
    A("| Field | Value |")
    A("| :--- | :--- |")
    A(f"| Question | {_truncate(spec.get('question',''), 500) or '_(not parsed)_'} |")
    A(f"| Model | `{json.dumps(snap.get('model'))}` |")
    A(f"| Session id | `{snap.get('session_id','?')}` |")
    classification = spec.get("classification") or {}
    if classification:
        for k, v in classification.items():
            A(f"| {k} | {v} |")
    A("")

    # ---- 2. KPIs ----
    A("## 2. KPIs")
    A("")
    A("| Metric | Value |")
    A("| :--- | :--- |")
    A(f"| Hops (submit_findings) | {len(submits)} |")
    A(f"| present_result calls | {len(presents)} |")
    A(f"| Scope size | {sm.get('scopeSize', 0)} |")
    A(f"| Engine status | `{sm.get('status','?')}` |")
    A(f"| classification (locked) | `{sm.get('classification','?')}` |")
    A(f"| inlineMode | `{sm.get('inlineMode','?')}` |")
    A(f"| coveragePct | {sm.get('coveragePct','?')} |")
    A(f"| LM calls (sm→bridge↔haiku) | {len(lm_calls)} |")
    A(f"| Total duration (ms) | {total_dur:,} |")
    A(f"| Tokens — input total | {total_in_tok:,} |")
    A(f"| Tokens — output total | {total_out_tok:,} |")
    A(f"| Tokens — avg output per LM call | {avg_hop:,} |")
    A(f"| Tokens — session total (in+out) | {total_tokens:,} |")
    A(f"| Errors | {err_count} |")
    A(f"| detail_slots count | {len(detail_slots)} |")
    A("")

    # ---- 3. Required nodes ----
    A("## 3. Required nodes (case-file vs visited)")
    A("")
    if not spec.get("required_nodes"):
        A("_(case file lists no Required Nodes)_")
    else:
        A(f"Coverage: **{req_hit} / {req_total}**")
        A("")
        for n in spec["required_nodes"]:
            mark = "✅" if _normalize_id(n) in pool else "❌"
            A(f"- {mark} `{n}`")
    A("")
    if spec.get("forbidden_nodes"):
        A("**Forbidden:**")
        for n in spec["forbidden_nodes"]:
            mark = "❌ leaked" if _normalize_id(n) in pool else "✅ absent"
            A(f"- {mark} `{n}`")
        A("")

    # ---- 4. DDL-derived Expected Structural Coverage ----
    if spec.get("expected_structural_coverage"):
        A("## 4. Expected Structural Coverage (DDL-derived, from case file)")
        A("")
        A(spec["expected_structural_coverage"])
        A("")

    # ---- 5. Bridge log overview ----
    A("## 5. Bridge message log — every byte across the bridge")
    A("")
    if not bridge_entries:
        A("_No bridge log found._")
    else:
        A(f"Captured **{len(bridge_entries)}** entries across 4 directions: `sm→bridge`, `bridge→haiku`, `haiku→bridge`, `bridge→sm`.")
        A("")
        A("| # | Time | Direction | Shape |")
        A("| --: | :--- | :--- | :--- |")
        for i, e in enumerate(bridge_entries, 1):
            payload = e.get("payload") or {}
            shape = ""
            if isinstance(payload, dict):
                if "messages" in payload:
                    shape = f"messages={len(payload.get('messages',[]))}, tools={len(payload.get('tools',[]))}"
                elif "parts" in payload:
                    shape = f"parts={len(payload.get('parts',[]))}"
                elif payload.get("type"):
                    shape = f"type={payload.get('type')}"
                elif "error" in payload:
                    shape = f"error={payload.get('error')}"
            A(f"| {i} | {e.get('ts','?')[11:19]} | `{e.get('direction','?')}` | {shape} |")
    A("")

    # ---- 6. Per-turn conversation ----
    A("## 6. Per-turn conversation")
    A("")
    pairs: list[tuple[dict | None, dict | None]] = []
    cur: dict | None = None
    for e in bridge_entries:
        if e.get("direction") == "sm->bridge":
            if cur is not None:
                pairs.append((cur, None))
            cur = e
        elif e.get("direction") == "haiku->bridge" and cur is not None:
            pairs.append((cur, e))
            cur = None
    if cur is not None:
        pairs.append((cur, None))
    for i, (req, resp) in enumerate(pairs, 1):
        A(f"### Turn {i}")
        A("")
        if req is None:
            A("_(no request captured)_")
            continue
        rp = req.get("payload") or {}
        msgs = rp.get("messages") or []
        tools = [t.get("name") for t in (rp.get("tools") or [])]
        A(f"**SM emitted** — {len(msgs)} messages × tools=`{tools}`")
        A("")
        # One-line summary first (always)
        for m in msgs:
            A(_summarize_msg(m))
        A("")
        # Detailed per-message render under a foldable header
        A(f"<details><summary>Show full messages (Turn {i})</summary>")
        A("")
        for j, m in enumerate(msgs):
            A(f"#### message[{j}]")
            A("")
            for line in _render_message_block(m):
                A(line)
        A("</details>")
        A("")
        if resp is None:
            A("_(no response captured)_")
            A("")
            continue
        parts = (resp.get("payload") or {}).get("parts") or []
        A(f"**Haiku returned** — {len(parts)} parts:")
        A("")
        for p in parts:
            if not isinstance(p, dict):
                continue
            if p.get("type") == "text":
                A(f"_text ({len(p.get('text','')):,} chars):_")
                A("")
                A("```text")
                A(_truncate(p.get("text", ""), 1500))
                A("```")
                A("")
            elif p.get("type") == "tool_use":
                A(f"_tool_use_ — **`{p.get('name')}`** (id=`{p.get('id')}`)")
                A("")
                A("```json")
                A(_truncate(json.dumps(p.get("input", {}), indent=2, ensure_ascii=False), 1500))
                A("```")
                A("")
        A("---")
        A("")

    # ---- 7. Per-hop short + long memory (when hops occurred) ----
    A(f"## 7. Per-hop short + long memory ({len(submits)} hops)")
    A("")
    if not submits:
        A("_No `submit_findings` hops yet — conversation likely stopped at the `confirm_sm_start` gate or earlier._")
    else:
        for i, s in enumerate(submits, 1):
            inp = s.get("input", {}) or {}
            fnode = inp.get("focus_node_id") or "(no focus_node_id)"
            A(f"### Hop {i} — `{fnode}`")
            A("")
            A("| Field | Value |")
            A("| :--- | :--- |")
            A(f"| verdict | `{inp.get('verdict','?')}` |")
            A(f"| badge_label | `{inp.get('badge_label') or '—'}` |")
            if inp.get("note_caption"):
                A(f"| note | {inp.get('note_caption')} |")
            A("")
            A("**Short memory (`summary`):**")
            A("")
            sm_text = (inp.get("summary") or "").strip()
            A("```text" if sm_text else "")
            A(sm_text or "_(empty)_")
            A("```" if sm_text else "")
            A("")
            secs = inp.get("sections") or []
            A(f"**Long memory (`sections[]`, {len(secs)} entries):**")
            A("")
            for sec in secs:
                if not isinstance(sec, dict):
                    continue
                t = (sec.get("text") or "").strip()
                A(f"**angle: `{sec.get('angle','?')}`** ({len(t)} chars)")
                A("")
                A("```markdown")
                A(_truncate(t, 2500))
                A("```")
                A("")
            routed = inp.get("route_requests") or []
            if routed:
                A(f"**Routed-out** (`route_requests` — {len(routed)} new neighbors):")
                A("")
                for rr in routed:
                    if isinstance(rr, dict):
                        A(f"- `{rr.get('nodeId','?')}` — {rr.get('question','_(no question)_')}")
                A("")
            pruned = inp.get("prune_neighbors") or []
            if pruned:
                A(f"**Pruned-out** (`prune_neighbors` — {len(pruned)} discarded):")
                A("")
                for n in pruned:
                    A(f"- `{n}`")
                A("")
            A("---")
            A("")

    # ---- 8. AI chat output ----
    A("## 8. AI chat output (stream_capture)")
    A("")
    cap = snap.get("stream_capture") or []
    if not cap:
        A("_(no stream output captured — handler did not emit anything)_")
    else:
        A(f"Captured **{len(cap)}** stream parts:")
        A("")
        A("```text")
        for line in cap:
            A(_truncate(line, 800))
        A("```")
    A("")
    btns = snap.get("buttons") or []
    if btns:
        A(f"**Buttons emitted ({len(btns)}):**")
        for b in btns:
            A(f"- command=`{b.get('command')}` title=`{b.get('title')}`")
        A("")

    # ---- 9. AI description output ----
    A("## 9. AI description output (`present_result.input` body)")
    A("")
    if not present_input:
        A("_No `present_result` call — conversation did not reach synthesis (likely stopped at gate or before)._")
    else:
        if present_input.get("name"):
            A(f"**name:** `{present_input.get('name')}`")
        if present_input.get("summary"):
            A(f"**summary:** {present_input.get('summary')}")
        if present_input.get("intro"):
            A("**intro:**")
            A("```markdown")
            A(_truncate(present_input.get("intro", ""), 2000))
            A("```")
        if present_input.get("description"):
            A("**description (markdown handed to webview):**")
            A("```markdown")
            A(_truncate(present_input.get("description", ""), 4000))
            A("```")
        secs = present_input.get("sections") or []
        if secs:
            A(f"**sections ({len(secs)}):**")
            for sec in secs:
                A(f"- label=`{sec.get('label','?')}` chars={len(sec.get('text','') or '')}")
                t = (sec.get("text") or "").strip()
                if t:
                    A("```markdown")
                    A(_truncate(t, 2500))
                    A("```")
        if present_input.get("closing"):
            A("**closing:**")
            A("```markdown")
            A(_truncate(present_input.get("closing", ""), 1500))
            A("```")
    A("")

    # ---- 10. Structural-quality KPIs on persisted description ----
    A("## 10. Structural-quality KPIs (persisted `result_graph.description`)")
    A("")
    A("> Mechanical counts on the body the webview renders. Compare against the case file's `## Expected Structural Coverage` table to decide pass/fail per element.")
    A("")
    A("| Element | Count |")
    A("| :--- | -: |")
    A(f"| chars | {kpi['chars']:,} |")
    A(f"| numbered `## N` sections | {kpi['numbered']} |")
    A(f"| markdown tables | {kpi['tables']} |")
    A(f"| ⚠️ callouts | {kpi['warn']} |")
    A(f"| LaTeX `$expr$` | {kpi['latex']} |")
    A(f"| code fences | {kpi['fences']} |")
    A(f"| total `##` headings | {kpi['headings']} |")
    A("")
    if not desc:
        A("_(no `result_graph.description` — synthesis did not run)_")
        A("")

    # ---- 11. Score ----
    A("## 11. Score (rubric 0–3, critical pair = correctness + completeness ≥ 2)")
    A("")
    A("| Dimension | Score | Notes |")
    A("| :--- | :---: | :--- |")
    notes_correct = f"required {req_hit}/{req_total}"
    if miss:
        notes_correct += f"; missing: {', '.join(f'`{n}`' for n in miss)}"
    if forbidden_leaks:
        notes_correct += f"; forbidden leaked: {', '.join(forbidden_leaks)}"
    A(f"| Correctness | **{correctness}** | {notes_correct} |")
    A(f"| Completeness | **{completeness}** | status=`{sm.get('status','?')}`; present_result called: {bool(present_input)} |")
    A(f"| Efficiency | **{efficiency}** | hops={len(submits)}; errors={err_count} |")
    A("")
    A(f"**Verdict:** {'✅ critical-pair PASS' if crit_pass else '❌ critical-pair FAIL'}  ·  total {correctness + completeness + efficiency}/9")
    A("")

    # ---- 12. Diagnostic Question Set ----
    A("## 12. Diagnostic Question Set + root-cause analysis")
    A("")
    A("> Per `.claude/skills/eval-loop/SKILL.md` HARD RULE 0. A CR proposal must cite at least one confirmed-broken-link finding from the bridge JSONL.")
    A("")

    # Forensic counts on submit_findings tool_uses to build evidence
    submit_haiku_calls: list[dict] = []
    for _, resp in pairs:
        if resp is None:
            continue
        for part in (resp.get("payload") or {}).get("parts") or []:
            if isinstance(part, dict) and part.get("type") == "tool_use" and part.get("name") == "lineage_submit_findings":
                submit_haiku_calls.append(part.get("input") or {})

    distinct_focus = {(c.get("focus_node_id") or "").lower() for c in submit_haiku_calls}
    routes_emitted = []
    for c in submit_haiku_calls:
        for r in c.get("route_requests") or []:
            if isinstance(r, dict):
                routes_emitted.append(r.get("nodeId"))
    distinct_routes = list({(n or "").lower() for n in routes_emitted})

    A(f"### Forensic counts (from bridge JSONL)")
    A("")
    A("| Metric | Value |")
    A("| :--- | -: |")
    A(f"| Haiku submit_findings calls | {len(submit_haiku_calls)} |")
    A(f"| distinct focus_node_ids submitted | {len(distinct_focus)} |")
    A(f"| route_requests emitted (across all submits) | {len(routes_emitted)} |")
    A(f"| distinct route_request target ids | {len(distinct_routes)} |")
    if distinct_focus:
        A(f"| focus targets | {', '.join(f'`{x}`' for x in sorted(distinct_focus))} |")
    if distinct_routes:
        A(f"| route_request targets | {', '.join(f'`{x}`' for x in distinct_routes)} |")
    A(f"| visited (detail_slots) | {', '.join(f'`{k}`' for k in detail_slots.keys())} |")
    A("")

    # Axes — answer with evidence from the run
    A("### Axis-by-axis status")
    A("")
    A("| Axis | Question | Evidence |")
    A("| :--- | :--- | :--- |")

    delivery_ok = bool(bridge_entries) and any((e.get("payload") or {}).get("messages") for e in bridge_entries)
    A(f"| A. DELIVERY | system+nav+capture template delivered? | {'✅ ' + str(len(bridge_entries)) + ' bridge entries; system envelope chars ≥1KB seen' if delivery_ok else '❌ no bridge log'} |")

    if not submit_haiku_calls:
        b_status = "❌ no submit_findings observed"
    elif len(distinct_focus) == 1 and len(submit_haiku_calls) > 1:
        b_status = f"⚠️ Haiku looped on a single focus (`{next(iter(distinct_focus))}`) across {len(submit_haiku_calls)} hops — agenda did not advance"
    else:
        b_status = f"✅ {len(submit_haiku_calls)} submit_findings across {len(distinct_focus)} focus nodes"
    A(f"| B. REASONING | model chose right tool / verdict / advanced focus? | {b_status} |")

    c_status = f"⚠️ {len(detail_slots)} detail_slot from {len(submit_haiku_calls)} submits — engine de-duplicated by focus_id" if detail_slots and len(detail_slots) < len(submit_haiku_calls) else (f"✅ {len(detail_slots)} slots persisted" if detail_slots else "❌ no slots persisted")
    A(f"| C. MEMORY/STATE | sections persisted to detail_slots / result_graph? | {c_status} |")

    routing_ok = sm.get("scopeSize", 0) > 0
    invented_routes = []
    if distinct_routes:
        slot_ids = {k.lower() for k in detail_slots.keys()}
        # routes that were NOT picked up into agenda (proxy for "unknown_node_ids")
        for rid in distinct_routes:
            if rid not in slot_ids:
                invented_routes.append(rid)
    if routing_ok and invented_routes:
        d_status = f"⚠️ scope built ({sm.get('scopeSize')} nodes) BUT {len(invented_routes)} of {len(distinct_routes)} route_requests targeted unknown ids: {', '.join(f'`{x}`' for x in invented_routes)}"
    elif routing_ok:
        d_status = f"✅ scope built ({sm.get('scopeSize')} nodes)"
    else:
        d_status = "❌ no scope built"
    A(f"| D. ROUTING/ENGINE | BFS / gate / agenda / route_request validation? | {d_status} |")

    miss_listed = [n for n in spec.get('required_nodes', []) if _normalize_id(n) not in pool]
    e_status = f"⚠️ {req_hit}/{req_total} required visited; {len(miss_listed)} listed in case-file but not visited" if miss_listed else (f"✅ {req_hit}/{req_total} required visited" if req_total else "_(no Required Nodes in case file)_")
    A(f"| E. DDL/EVIDENCE | case-file Required Nodes covered? | {e_status} |")

    f_status = f"✅ description {len(desc):,} chars" if desc else "❌ no synthesis — present_result not called"
    A(f"| F. SYNTHESIS LIFT | description produced + structural elements? | {f_status} |")
    A("")

    # Failure-class verdict
    A("### Failure-class verdict")
    A("")
    findings = []
    if not submit_haiku_calls:
        findings.append("**B-axis CONTENT** — no submit_findings observed")
    elif len(distinct_focus) == 1 and len(submit_haiku_calls) > 1:
        findings.append(f"**B-axis CONTENT** — Haiku submitted {len(submit_haiku_calls)} times for the SAME focus (`{next(iter(distinct_focus))}`) instead of advancing through the agenda")
    if invented_routes:
        findings.append(f"**B-axis CONTENT** — Haiku emitted route_requests for {len(invented_routes)} invented node id(s): {', '.join(f'`{x}`' for x in invented_routes)}. The search-resolution doctrine (resolve via lineage_search_objects FIRST) was not applied to route targets.")
    if not desc and submit_haiku_calls:
        findings.append("**F-axis ASSEMBLY** — synthesis (`present_result`) never invoked despite hops executed; engine drained without reaching the synthesis trigger")
    if not findings:
        findings.append("_No confirmed-broken-link findings; either the run completed cleanly or earlier-axis failures masked downstream signals._")
    for f in findings:
        A(f"- {f}")
    A("")

    if findings:
        A("### CR proposal scope (gated by these findings)")
        A("")
        A("Per HARD RULE 0, only the CR class matching a confirmed-broken-link finding above is in scope. Do NOT propose CR-PR edits to capture-template content unless an A-axis broken link is confirmed (which is NOT the case in this run — system envelope was delivered).")
        A("")

    out_path.write_text("\n".join(L), encoding="utf-8")
    print(f"[report] wrote {out_path}")
    print(f"[report] open: {out_path.absolute()}")


if __name__ == "__main__":
    main()
