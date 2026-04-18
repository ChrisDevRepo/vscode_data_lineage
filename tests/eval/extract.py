"""
Post-agent scoring for the structural eval runner.

Fetches the final SM state from the proxy, merges with any agent-authored
JSON, scores against tests/cases/EVAL-RUBRIC.md, and writes:

    test-results/eval-runs/<run-id>/<test-id>.json
    test-results/eval-runs/<run-id>/<test-id>.md
    test-results/eval-runs/<run-id>/snapshots/<test-id>/errors.json
    test-results/eval-runs/<run-id>/snapshots/<test-id>/hop-timing.json
    test-results/eval-runs/<run-id>/snapshots/<test-id>/enrich-view-audit.json
    test-results/eval-runs/<run-id>/snapshots/<test-id>/sm-state-trimmed.json
    test-results/eval-runs/<run-id>/summary.json  (append per test)

Consolidates what used to live in test-results/run-test.py + gen-quality-md.py.
The quality-first MD is the sole output format — no intermediate "baseline-format"
MD is written.

Usage:
    python tests/eval/extract.py <test-id> <session-id> [run-id]

If run-id is omitted, uses $EVAL_RUN_ID env var, else 'default-run'.
"""
from __future__ import annotations

import json
import os
import sys
from collections import Counter
from datetime import datetime
from pathlib import Path
from urllib.error import URLError
from urllib.request import Request, urlopen

PROXY = "http://127.0.0.1:3271"
PROJECT_ROOT = Path(__file__).resolve().parent.parent.parent
CASES_DIR = PROJECT_ROOT / "tests" / "cases"
RUNS_ROOT = PROJECT_ROOT / "test-results" / "eval-runs"


# ---------------------------------------------------------------------------
# Proxy state fetch + merge
# ---------------------------------------------------------------------------


def fetch_state(session_id: str) -> dict:
    try:
        req = Request(f"{PROXY}/session/{session_id}/state")
        with urlopen(req, timeout=10) as r:
            return json.loads(r.read().decode("utf-8", errors="replace"))
    except (URLError, OSError, ValueError) as e:
        return {"error": str(e)}


def merge_state(run_dir: Path, test_id: str, state: dict) -> dict:
    """Merge fetched state with any pre-existing agent JSON on disk.

    Agent-authored JSON (if present) contributes non-SM keys; the state dump
    is authoritative for sm_state, hop_log, session_hop_log, result_graph.
    """
    json_path = run_dir / f"{test_id}.json"
    agent_path = run_dir / f"{test_id}.agent.json"
    merged: dict = {}
    if agent_path.exists():
        merged.update(json.loads(agent_path.read_text(encoding="utf-8")))
    elif json_path.exists():
        prev = json.loads(json_path.read_text(encoding="utf-8"))
        for k, v in prev.items():
            if k not in ("sm_state", "hop_log", "session_hop_log", "result_graph"):
                merged[k] = v
    for k in ("sm_state", "hop_log", "session_hop_log", "result_graph"):
        if k in state:
            merged[k] = state[k]
    return merged


# ---------------------------------------------------------------------------
# Test-case parsing
# ---------------------------------------------------------------------------


def parse_case(test_id: str) -> dict:
    path = CASES_DIR / f"{test_id}.md"
    out = {"question": "", "required": [], "forbidden": [], "source_nodes": [], "expected": {}}
    if not path.exists():
        return out
    text = path.read_text(encoding="utf-8", errors="replace")
    section = None
    for line in text.split("\n"):
        if line.startswith("> ") and not out["question"]:
            out["question"] = line[2:].strip()
        if line.startswith("## "):
            s = line[3:].strip().lower()
            if "required nodes" in s:
                section = "required"
            elif "forbidden nodes" in s:
                section = "forbidden"
            elif "source nodes" in s:
                section = "source_nodes"
            elif "expected outcome" in s:
                section = "expected"
            else:
                section = None
            continue
        if section in ("required", "forbidden", "source_nodes") and line.startswith("- "):
            name = line[2:].strip()
            if name and not name.startswith("_") and name != "None":
                out[section].append(name)
        elif section == "expected" and line.startswith("|") and "|" in line[1:]:
            parts = [p.strip() for p in line.strip("|").split("|")]
            if (
                len(parts) >= 2
                and parts[0]
                and parts[0] not in ("Field", "Value")
                and "-" not in parts[0][:3]
            ):
                out["expected"][parts[0]] = parts[1]
    return out


def name_of(full_id: str) -> str:
    return full_id.split("].[")[-1].rstrip("]") if "].[" in full_id else full_id


# ---------------------------------------------------------------------------
# Scoring — quality-first (EVAL-RUBRIC.md 4-dim x 0-3)
# ---------------------------------------------------------------------------


def score_and_build_md(test_id: str, merged: dict, git_head: str) -> tuple[str, dict]:
    """Return (markdown_report, summary_row)."""
    hl = merged.get("hop_log") or []
    sm = merged.get("sm_state") or {}
    rg = merged.get("result_graph") or {}
    case = parse_case(test_id)

    submits = [h for h in hl if h.get("tool") == "submit_findings"]
    enriches = [h for h in hl if h.get("tool") == "enrich_view"]
    enrich_input = enriches[0].get("input", {}) if enriches else {}

    # Per-submit metrics
    summary_lens = [len(s.get("input", {}).get("summary", "")) for s in submits]
    det_lens = [len(s.get("input", {}).get("detail_analysis", "")) for s in submits]
    verdicts = Counter(s.get("input", {}).get("verdict") for s in submits)
    badges = [s.get("input", {}).get("badge_label") for s in submits if s.get("input", {}).get("badge_label")]
    empty_summary = sum(1 for n in summary_lens if n == 0)
    sql_keywords = ["INSERT ", "UPDATE ", "SELECT ", "JOIN ", "FROM ", "WHERE "]
    sql_hops = sum(
        1
        for s in submits
        if any(k in s.get("input", {}).get("detail_analysis", "").upper() for k in sql_keywords)
    )
    latex_hops = sum(1 for s in submits if "$" in s.get("input", {}).get("detail_analysis", ""))
    block5_hops = sum(1 for s in submits if "**Business Purpose:**" in s.get("input", {}).get("detail_analysis", ""))
    table_hops = sum(
        1
        for s in submits
        if "|---" in s.get("input", {}).get("detail_analysis", "")
        or "| --- |" in s.get("input", {}).get("detail_analysis", "")
    )
    avg_summary = (sum(summary_lens) / len(summary_lens)) if summary_lens else 0
    avg_det = (sum(det_lens) / len(det_lens)) if det_lens else 0

    # Coverage vs spec
    visited = [s.get("input", {}).get("focus_node_id", "") for s in submits]
    notes = enrich_input.get("notes", [])
    note_ids = [n.get("node_id", "") for n in notes]
    graph_ids = rg.get("nodeIds", []) if rg else []
    all_mentioned = set(visited) | set(note_ids) | set(graph_ids)
    mentioned_names = {name_of(x).lower() for x in all_mentioned if x}
    req_results = [(r, r.lower() in mentioned_names) for r in case["required"]]
    forb_results = [(f, f.lower() in mentioned_names) for f in case["forbidden"]]
    req_covered = sum(1 for _, f in req_results if f)
    forb_leaked = sum(1 for _, f in forb_results if f)
    src_results = [(s, s.lower() in mentioned_names) for s in case["source_nodes"]]
    src_covered = sum(1 for _, f in src_results if f)

    # CT-specific
    try:
        chain_min = int(case["expected"].get("Chain length min", "0").strip())
    except (ValueError, AttributeError):
        chain_min = 0
    try:
        renames_min = int(case["expected"].get("Column renames min", "0").strip())
    except (ValueError, AttributeError):
        renames_min = 0
    agent_chain_len = len(merged.get("chain_path", []))
    agent_renames = len(merged.get("column_renames", []))

    # Efficiency
    total_ms = sum(h.get("_meta", {}).get("durationMs", 0) for h in hl)
    total_in = sum(h.get("_meta", {}).get("inputTokens", 0) for h in hl)
    total_out = sum(h.get("_meta", {}).get("outputTokens", 0) for h in hl)
    sub_ms = sum(h.get("_meta", {}).get("durationMs", 0) for h in submits)
    sub_in = sum(h.get("_meta", {}).get("inputTokens", 0) for h in submits)
    sub_out = sum(h.get("_meta", {}).get("outputTokens", 0) for h in submits)
    e_meta = enriches[0].get("_meta", {}) if enriches else {}
    errs = [h for h in hl if h.get("_meta", {}).get("isError")]

    # Rubric scoring
    if test_id.startswith("ct-"):
        penalty = 0
        if case["source_nodes"] and src_covered < len(case["source_nodes"]):
            penalty += len(case["source_nodes"]) - src_covered
        if chain_min and agent_chain_len < chain_min:
            penalty += 1
        if renames_min and agent_renames < renames_min:
            penalty += 1
        correctness = max(0, 3 - penalty)
    elif case["required"]:
        if req_covered == len(case["required"]) and forb_leaked == 0:
            correctness = 3
        elif req_covered == len(case["required"]):
            correctness = 2
        elif req_covered >= len(case["required"]) - 2:
            correctness = 1
        else:
            correctness = 0
    else:
        correctness = 3

    if submits and enrich_input.get("sections") and enrich_input.get("notes"):
        completeness = 3
    elif submits:
        completeness = 1
    elif not case["required"] and merged.get("final_text_response"):
        completeness = 3
    else:
        completeness = 0

    sec_texts = [len(s.get("text", "")) for s in enrich_input.get("sections", [])]
    avg_sec_text = (sum(sec_texts) / len(sec_texts)) if sec_texts else 0
    populated_secs = sum(1 for x in sec_texts if x >= 100)
    if not submits and len(merged.get("final_text_response", "")) > 100:
        qa = 3
    elif (
        enrich_input.get("summary")
        and populated_secs == len(sec_texts)
        and len(notes) > 0
        and avg_sec_text >= 300
    ):
        qa = 3
    elif enrich_input.get("summary") and populated_secs >= 1:
        qa = 2
    elif enrich_input:
        qa = 1
    else:
        qa = 0

    type_score = 2
    if test_id.startswith("ct-") and latex_hops < 1 and table_hops < 1:
        type_score = 1
    elif test_id.startswith("ct-") and (latex_hops >= 1 or table_hops >= 1):
        type_score = 3
    elif test_id.startswith("disc-"):
        type_score = 3 if len(merged.get("final_text_response", "")) > 200 else 2
    elif test_id.startswith("bb-"):
        type_score = 3 if submits and block5_hops == len(submits) and sql_hops == len(submits) else 2

    pregate_pass = (avg_det >= 400 and avg_summary >= 40 and empty_summary == 0) if submits else True
    total = correctness + completeness + qa + type_score
    if not pregate_pass:
        total = min(total, 6)
    grade = "EXCELLENT" if total >= 11 else ("PASS" if total >= 8 else ("PARTIAL" if total >= 5 else "FAIL"))

    # --- MD ---
    L: list[str] = []
    A = L.append
    A(f"# {test_id} — Quality-First Eval Report")
    A("")
    A(f"> **Question:** {case['question']}")
    A(f"> **Test case:** [tests/cases/{test_id}.md](../../../tests/cases/{test_id}.md)")
    A("> **Dacpac:** AdventureWorks2025_AI.dacpac")
    A(f"> **Model:** haiku | **Session:** `{merged.get('sessionId','?')}` | **Date:** {datetime.now().strftime('%Y-%m-%d')}")
    A(f"> **Git HEAD:** `{git_head}`")
    A("")
    A("---")
    A("")
    A("## 1. Verdict")
    A("")
    A(f"### Grade: **{grade}** — {total}/12")
    A("")
    A("| Dimension | Score | Detail |")
    A("|-----------|-------|--------|")
    if test_id.startswith("ct-"):
        corr_detail = (
            f"source_nodes covered: {src_covered}/{len(case['source_nodes'])} | "
            f"chain length: {agent_chain_len} (min {chain_min}) | renames: {agent_renames} (min {renames_min})"
        )
    elif case["required"]:
        corr_detail = f"required covered: {req_covered}/{len(case['required'])} | forbidden leaked: {forb_leaked}"
    else:
        corr_detail = "no spec nodes — discovery/open-ended test"
    A(f"| Correctness | **{correctness}/3** | {corr_detail} |")
    A(
        f"| Completeness | **{completeness}/3** | hops: {len(submits)} | "
        f"sections: {len(enrich_input.get('sections', []))} | notes: {len(notes)} |"
    )
    qa_detail = (
        f"summary={'OK' if enrich_input.get('summary') else 'MISSING'} | "
        f"populated sections {populated_secs}/{len(sec_texts)} (avg text {avg_sec_text:.0f} chars) | notes={len(notes)}"
        if submits
        else ("final_text_response present" if merged.get("final_text_response") else "no explicit answer")
    )
    A(f"| Question-Answering **(PRIMARY)** | **{qa}/3** | {qa_detail} |")
    A(
        f"| Type-Appropriate Detail | **{type_score}/3** | 5-block: {block5_hops}/{len(submits)} | "
        f"SQL: {sql_hops}/{len(submits)} | LaTeX: {latex_hops}/{len(submits)} | tables: {table_hops}/{len(submits)} |"
    )
    A("")
    A(f"**Memory-Quality Pre-Gate:** **{'PASS' if pregate_pass else 'FAIL — score capped at 6/12'}**")
    A("")
    A("| Pre-Gate Check | Measured | Threshold | Status |")
    A("|---|---|---|---|")
    A(f"| Avg detail_analysis chars/node | {avg_det:.0f} | >= 400 | {'OK' if avg_det >= 400 else 'FAIL'} |")
    A(f"| Avg summary chars/hop | {avg_summary:.0f} | >= 40 | {'OK' if avg_summary >= 40 else 'FAIL'} |")
    A(f"| Empty summary hops | {empty_summary} | = 0 | {'OK' if empty_summary == 0 else 'FAIL'} |")
    A(
        f"| Badge coverage | {len(badges)}/{len(submits)} hops | 100% on relevant | "
        f"{'OK' if len(badges) >= verdicts.get('relevant', 0) else 'FAIL'} |"
    )
    A(
        f"| SQL evidence | {sql_hops}/{len(submits)} hops | >=1 per noted | "
        f"{'OK' if sql_hops >= len(submits) or not submits else 'WARN'} |"
    )
    A("")
    A("---")
    A("")
    A("## 2. Answer (enrich_view rendering)")
    A("")
    if enrich_input:
        A(f"**Graph Name:** {enrich_input.get('name', '')}")
        A(f"**Title:** {enrich_input.get('title', '')}")
        A(f"**Summary:** {enrich_input.get('summary', '')}")
        A("")
        for s in enrich_input.get("sections", []):
            A(f"### {s.get('label', '')}")
            A("")
            A(f"*Nodes:* `{'`, `'.join(s.get('node_ids', []))}`")
            A("")
            A(s.get("text", ""))
            A("")
        hg = enrich_input.get("highlight_groups", [])
        if hg:
            A("### Highlight Groups")
            A("")
            A("| Group | Color | Nodes |")
            A("|---|---|---|")
            for g in hg:
                A(f"| {g.get('label', '')} | {g.get('color', '')} | {', '.join(g.get('node_ids', []))} |")
            A("")
        if notes:
            A("### Node Notes")
            A("")
            A("| Node | Note |")
            A("|---|---|")
            for n in notes:
                A(f"| `{n.get('node_id', '')}` | {n.get('text', '')} |")
            A("")
    elif merged.get("final_text_response"):
        A("_Classic discovery answer (no enrich_view):_")
        A("")
        A(merged.get("final_text_response", ""))
        A("")
    else:
        A("_No answer assembled._")
        A("")
    A("---")
    A("")
    A("## 3. Correctness")
    A("")
    if case["required"]:
        A("### Required nodes")
        A("")
        A("| # | Required Node | Present | Role |")
        A("|---|---|:---:|---|")
        for i, (r, present) in enumerate(req_results, 1):
            role = ""
            for n in notes:
                if r.lower() in n.get("node_id", "").lower():
                    role = n.get("text", "")
                    break
            A(f"| {i} | {r} | {'OK' if present else 'MISSING'} | {role or '-'} |")
        A("")
        pct = 100 * req_covered // max(1, len(case["required"]))
        A(f"**Required coverage:** {req_covered}/{len(case['required'])} = {pct}%")
        A("")
    if case["forbidden"]:
        A("### Forbidden nodes (must be absent or cascade-pruned)")
        A("")
        A("| Forbidden Node | Present? | Expected |")
        A("|---|:---:|---|")
        for f, present in forb_results:
            A(f"| {f} | {'PRESENT (BUG)' if present else 'Absent'} | Cascade-prune or out-of-scope |")
        A("")
    if case["source_nodes"]:
        A("### Source nodes (CT — must be reached in chain)")
        A("")
        A("| Source Node | Reached? |")
        A("|---|:---:|")
        for s, present in src_results:
            A(f"| {s} | {'OK' if present else 'MISSING'} |")
        A("")
        pct = 100 * src_covered // max(1, len(case["source_nodes"]))
        A(
            f"**Source coverage:** {src_covered}/{len(case['source_nodes'])} = {pct}%  |  "
            f"Chain length: {agent_chain_len} (min {chain_min})  |  Renames: {agent_renames} (min {renames_min})"
        )
        A("")
    A("---")
    A("")
    A("## 4. Completeness")
    A("")
    A("| Metric | Value |")
    A("|---|---|")
    A(f"| Hops (submit_findings) | {len(submits)} |")
    A(
        f"| Verdicts | relevant={verdicts.get('relevant', 0)}, pass={verdicts.get('pass', 0)}, "
        f"irrelevant={verdicts.get('irrelevant', 0)} |"
    )
    A(f"| Result graph nodes | {len(graph_ids)} |")
    A(f"| enrich_view sections | {len(enrich_input.get('sections', []))} |")
    A(f"| enrich_view notes | {len(notes)} |")
    A(f"| Highlight groups | {len(enrich_input.get('highlight_groups', []))} |")
    A("")
    A("---")
    A("")
    A("## 5. Format Compliance")
    A("")
    A("| Check | Score |")
    A("|---|---|")
    pct5 = 100 * block5_hops // max(1, len(submits))
    A(f"| 5-block detail template | {block5_hops}/{len(submits)} hops ({pct5}%) |")
    A(f"| SQL keywords in detail_analysis | {sql_hops}/{len(submits)} hops |")
    A(f"| LaTeX math (`$...$`) | {latex_hops}/{len(submits)} hops |")
    A(f"| Markdown tables | {table_hops}/{len(submits)} hops |")
    A(f"| Badge coverage | {len(badges)}/{len(submits)} hops |")
    wr_labels = sum(
        1
        for s in enrich_input.get("sections", [])
        if "writer" in s.get("label", "").lower() or "reader" in s.get("label", "").lower()
    )
    sec_total = len(enrich_input.get("sections", []))
    term_status = f"WARN: {wr_labels} labels use Writer/Reader" if wr_labels else "OK"
    A(f"| Terminology (no Writer/Reader) | {sec_total - wr_labels}/{sec_total} clean | {term_status} |")
    A("")
    A("---")
    A("")
    if submits:
        A("## 6. Per-Hop Evidence Archive")
        A("")
        A("Full `detail_analysis` per hop — the agent's grounded reasoning at each stop.")
        A("")
        for i, s in enumerate(submits, 1):
            inp = s.get("input", {})
            focus = inp.get("focus_node_id", "")
            A(f"### Hop {i} — `{name_of(focus)}` (`{focus}`)")
            A("")
            A("| Field | Value |")
            A("|---|---|")
            A(f"| Verdict | **{inp.get('verdict', '')}** |")
            A(f"| Badge | {inp.get('badge_label', '') or '-'} |")
            A(f"| Note caption | {inp.get('note_caption', '') or '-'} |")
            A(f"| Duration | {s.get('_meta', {}).get('durationMs', '?')}ms |")
            A(
                f"| Tokens | in={s.get('_meta', {}).get('inputTokens', '?')}, "
                f"out={s.get('_meta', {}).get('outputTokens', '?')} |"
            )
            A(f"| route_requests | {len(inp.get('route_requests', []))} |")
            A("")
            if inp.get("summary"):
                A(f"**summary ({len(inp.get('summary', ''))} chars):**")
                A("")
                A(f"> {inp.get('summary', '')}")
                A("")
            A(f"**detail_analysis ({len(inp.get('detail_analysis', ''))} chars):**")
            A("")
            A(inp.get("detail_analysis", ""))
            A("")
            A("---")
            A("")
        A("## 7. Summary Chain")
        A("")
        for i, s in enumerate(submits, 1):
            A(f"{i}. {s.get('input', {}).get('summary', '')}")
        A("")
        A("---")
        A("")
        A("## 8. Hop Sequence")
        A("")
        A("| # | Focus | Verdict | Badge | summary | detail | ms | in | out |")
        A("|---|---|---|---|---:|---:|---:|---:|---:|")
        for i, s in enumerate(submits, 1):
            inp = s.get("input", {})
            m = s.get("_meta", {})
            A(
                f"| {i} | {name_of(inp.get('focus_node_id', ''))} | {inp.get('verdict', '')} | "
                f"{inp.get('badge_label', '') or '-'} | {len(inp.get('summary', ''))} | "
                f"{len(inp.get('detail_analysis', ''))} | {m.get('durationMs', '?')} | "
                f"{m.get('inputTokens', '?')} | {m.get('outputTokens', '?')} |"
            )
        A("")
        A("---")
        A("")
    A("## 9. Efficiency (secondary)")
    A("")
    A("| Metric | Value |")
    A("|---|---|")
    A(f"| Total tool time (proxy-side) | {total_ms}ms |")
    A(f"| Total calls | {len(hl)} |")
    A(f"| Total input tokens | {total_in:,} |")
    A(f"| Total output tokens | {total_out:,} |")
    if submits:
        A(
            f"| Per-submit avg | {sub_ms / len(submits):.1f}ms, "
            f"in={sub_in // len(submits)}, out={sub_out // len(submits)} |"
        )
    if e_meta:
        A(
            f"| enrich_view | {e_meta.get('durationMs', '?')}ms, "
            f"in={e_meta.get('inputTokens', '?')}, out={e_meta.get('outputTokens', '?')} |"
        )
    if notes:
        A(f"| Output tokens per noted node | {total_out // len(notes)} |")
    A("")
    A("---")
    A("")
    A("## 10. Tool Usage")
    A("")
    tools_counter = Counter(h.get("tool") for h in hl)
    A("| Tool | Calls | Errors |")
    A("|---|---:|---:|")
    for t, c in sorted(tools_counter.items(), key=lambda x: -x[1]):
        tool_errs = sum(1 for h in hl if h.get("tool") == t and h.get("_meta", {}).get("isError"))
        A(f"| {t} | {c} | {tool_errs} |")
    A("")
    A("---")
    A("")
    A("## 11. Rejections")
    A("")
    if errs:
        A("| Tool | Error type | Classification |")
        A("|---|---|---|")
        valid = {
            "focus_mismatch",
            "route_validation_failed",
            "orphan_rejection",
            "narrative_too_long",
        }
        for e in errs:
            et = e.get("_meta", {}).get("errorType", "?")
            cls = "VALID_REJECTION" if et in valid else "TBD"
            A(f"| {e.get('tool')} | {et} | {cls} |")
    else:
        A("_No errors in this run._")
    A("")
    A("---")
    A("")
    A("_Report generated by tests/eval/extract.py._")

    summary = {
        "grade": grade,
        "total": total,
        "dimensions": {
            "correctness": correctness,
            "completeness": completeness,
            "question_answering": qa,
            "type_appropriate_detail": type_score,
        },
        "memory_pregate": "PASS" if pregate_pass else "FAIL",
        "hops": len(submits),
        "scope_size": sm.get("scopeSize", 0),
        "status": sm.get("status", "unknown"),
        "enrich_view_called": bool(enriches),
        "errors": len(errs),
        "total_input_tokens": total_in,
        "total_output_tokens": total_out,
        "total_ms": total_ms,
        "required_coverage": f"{req_covered}/{len(case['required'])}" if case["required"] else None,
        "forbidden_leaked": forb_leaked if case["forbidden"] else None,
        "source_coverage": f"{src_covered}/{len(case['source_nodes'])}" if case["source_nodes"] else None,
        "avg_detail_chars": round(avg_det, 1),
        "avg_summary_chars": round(avg_summary, 1),
    }
    return "\n".join(L), summary


# ---------------------------------------------------------------------------
# Snapshot bundle
# ---------------------------------------------------------------------------


def write_snapshots(run_dir: Path, test_id: str, merged: dict) -> None:
    snap_dir = run_dir / "snapshots" / test_id
    snap_dir.mkdir(parents=True, exist_ok=True)

    hl = merged.get("hop_log") or []
    sm = merged.get("sm_state") or {}

    errors = []
    for h in hl:
        m = h.get("_meta") or {}
        if not m.get("isError"):
            continue
        errors.append(
            {
                "tool": h.get("tool"),
                "errorType": m.get("errorType"),
                "timestamp": h.get("timestamp"),
                "durationMs": m.get("durationMs"),
                "input": h.get("input"),
                "output": h.get("output"),
            }
        )
    (snap_dir / "errors.json").write_text(
        json.dumps(errors, indent=2, ensure_ascii=False), encoding="utf-8"
    )

    timing = [
        {
            "tool": h.get("tool"),
            "timestamp": h.get("timestamp"),
            "durationMs": (h.get("_meta") or {}).get("durationMs"),
            "inputBytes": (h.get("_meta") or {}).get("inputBytes"),
            "outputBytes": (h.get("_meta") or {}).get("outputBytes"),
            "inputTokens": (h.get("_meta") or {}).get("inputTokens"),
            "outputTokens": (h.get("_meta") or {}).get("outputTokens"),
            "isError": (h.get("_meta") or {}).get("isError"),
        }
        for h in hl
    ]
    (snap_dir / "hop-timing.json").write_text(json.dumps(timing, indent=2), encoding="utf-8")

    enriches = [h for h in hl if h.get("tool") == "enrich_view"]
    audit = []
    for e in enriches:
        einp = e.get("input") or {}
        audit.append(
            {
                "timestamp": e.get("timestamp"),
                "durationMs": (e.get("_meta") or {}).get("durationMs"),
                "inputTokens": (e.get("_meta") or {}).get("inputTokens"),
                "outputTokens": (e.get("_meta") or {}).get("outputTokens"),
                "isError": (e.get("_meta") or {}).get("isError"),
                "sent": {
                    "fields": list(einp.keys()),
                    "name": einp.get("name"),
                    "title": einp.get("title"),
                    "summary_length": len(einp.get("summary", "") or ""),
                    "section_count": len(einp.get("sections", []) or []),
                    "sections": [
                        {
                            "label": s.get("label"),
                            "node_count": len(s.get("node_ids", []) or []),
                            "text_length": len(s.get("text", "") or ""),
                            "has_latex": "$" in (s.get("text") or ""),
                            "has_sql_keywords": any(
                                k in (s.get("text") or "").upper()
                                for k in ("SELECT ", "INSERT ", "UPDATE ", "JOIN ", "CASE ")
                            ),
                            "has_table": "|---" in (s.get("text") or ""),
                        }
                        for s in einp.get("sections", []) or []
                    ],
                    "note_count": len(einp.get("notes", []) or []),
                    "highlight_group_count": len(einp.get("highlight_groups", []) or []),
                },
                "response": e.get("output"),
            }
        )
    (snap_dir / "enrich-view-audit.json").write_text(
        json.dumps(audit, indent=2, ensure_ascii=False), encoding="utf-8"
    )

    trimmed = {
        "mode": sm.get("mode"),
        "status": sm.get("status"),
        "hopCount": sm.get("hopCount"),
        "scopeSize": sm.get("scopeSize"),
        "inlineMode": sm.get("inlineMode"),
        "agendaSize": sm.get("agendaSize"),
        "currentFocusNodeId": sm.get("currentFocusNodeId"),
        "visited_count": len(sm.get("visited", []) or []),
        "removed_count": len(sm.get("removedSet", []) or []),
        "slotCount": (sm.get("memory") or {}).get("slotCount"),
        "userQuestion": (sm.get("memory") or {}).get("userQuestion"),
    }
    (snap_dir / "sm-state-trimmed.json").write_text(json.dumps(trimmed, indent=2), encoding="utf-8")


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------


def get_git_head() -> str:
    try:
        head_path = PROJECT_ROOT / ".git" / "HEAD"
        ref = head_path.read_text(encoding="utf-8").strip()
        if ref.startswith("ref: "):
            ref_path = PROJECT_ROOT / ".git" / ref[5:]
            return ref_path.read_text(encoding="utf-8").strip()[:7]
        return ref[:7]
    except OSError:
        return "unknown"


def main() -> int:
    if len(sys.argv) < 3:
        print("Usage: python tests/eval/extract.py <test-id> <session-id> [run-id]", file=sys.stderr)
        return 2
    test_id = sys.argv[1]
    session_id = sys.argv[2]
    run_id = sys.argv[3] if len(sys.argv) > 3 else os.environ.get("EVAL_RUN_ID", "default-run")

    run_dir = RUNS_ROOT / run_id
    run_dir.mkdir(parents=True, exist_ok=True)

    print(f"[extract] {test_id} session={session_id} run={run_id}")
    state = fetch_state(session_id)
    if "error" in state:
        print(f"[extract] state fetch warning: {state['error']}")
        state = {"sm_state": {}, "hop_log": [], "result_graph": None}

    merged = merge_state(run_dir, test_id, state)
    merged["sessionId"] = session_id

    json_path = run_dir / f"{test_id}.json"
    json_path.write_text(json.dumps(merged, indent=2, ensure_ascii=False), encoding="utf-8")

    git_head = get_git_head()
    md_text, summary = score_and_build_md(test_id, merged, git_head)
    md_path = run_dir / f"{test_id}.md"
    md_path.write_text(md_text, encoding="utf-8", errors="replace")

    write_snapshots(run_dir, test_id, merged)

    summary_path = run_dir / "summary.json"
    if summary_path.exists():
        all_summary = json.loads(summary_path.read_text(encoding="utf-8"))
    else:
        all_summary = {}
    all_summary[test_id] = summary
    summary_path.write_text(json.dumps(all_summary, indent=2, ensure_ascii=False), encoding="utf-8")

    print(f"[extract] wrote {md_path.relative_to(PROJECT_ROOT)}")
    print(f"[extract] Grade: {summary['grade']} ({summary['total']}/12)")
    print(
        f"[extract] hops={summary['hops']} scope={summary['scope_size']} "
        f"enrich={summary['enrich_view_called']} errors={summary['errors']}"
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
