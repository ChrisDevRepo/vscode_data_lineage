"""
Eval report builder — fetches SM state from the live test-electron proxy,
merges with the agent run metadata, scores against the test-case spec, and
writes a single self-contained Markdown report.

Layout (one section per spec, every value sourced 1:1 from SM state — no
harness paraphrasing):

    1. Test case      — question, source dacpac, filter
    2. KPIs           — duration total / phase 2 / phase 3, token avg, token of summary
    3. Baseline check — current run vs baseline-v1-2026-04-19 (or the most recent
                        prior baseline run found under test-results/eval-runs/)
    4. Expected outcome  — parsed from tests/cases/<id>.md "Expected Outcome" + Required + Forbidden
    5. Score          — correctness, completeness, efficiency (0–3 each;
                        correctness + completeness are the critical pair)
    6. Hops           — one block per visited node: subquestion, status, label,
                        short memory, long memory
    7. AI summary chat output    — verbatim from <id>.chat.txt
    8. AI description output     — verbatim from present_result.input.description

Usage: python extract.py <test-id> <session-id>
"""
import hashlib
import json
import os
import re
import subprocess
import sys
import time
from datetime import datetime
from collections import Counter
from pathlib import Path
from urllib.error import URLError
from urllib.request import urlopen

PROXY = "http://127.0.0.1:3271"
PROJECT_ROOT = Path(__file__).resolve().parent.parent.parent
RUNS_ROOT = PROJECT_ROOT / "test-results" / "eval-runs"
CASES_DIR = PROJECT_ROOT / "tests" / "cases"
BASELINE_RUN_ID = "baseline-v1-2026-04-19"


def _truncate(value, limit: int) -> object:
    """Stringify and clip for snapshot artifacts; preserves dict/list at top level."""
    if value is None:
        return None
    if isinstance(value, (dict, list)):
        s = json.dumps(value, ensure_ascii=False)
    else:
        s = str(value)
    if len(s) <= limit:
        return s
    return s[:limit] + f"… [+{len(s) - limit} chars]"


# ---------------------------------------------------------------------------
# Test-case file parsing
# ---------------------------------------------------------------------------

def _read_case_file(test_id: str) -> str:
    """Locate and return raw text of the case file. Falls back through the
    same search roots as run.py so ad-hoc cases work."""
    candidates = [CASES_DIR / f"{test_id}.md"]
    candidates.extend(CASES_DIR.glob(f"*/{test_id}.md"))
    adhoc_root = PROJECT_ROOT / "test-results" / "cases"
    if adhoc_root.exists():
        candidates.extend(adhoc_root.rglob(f"{test_id}.md"))
    for p in candidates:
        if p.exists():
            return p.read_text(encoding="utf-8", errors="replace")
    return ""


def parse_case_spec(test_id: str) -> dict:
    """Parse a case .md into a structured dict for scoring + report headers.

    Extracts: question, classification table, expected-outcome table,
    required/forbidden node lists. Tolerant of missing sections; returns
    empty defaults when fields are absent."""
    text = _read_case_file(test_id)
    spec = {
        "question": "",
        "classification": {},
        "expected": {},
        "required_nodes": [],
        "forbidden_nodes": [],
    }
    if not text:
        return spec

    # Question — first blockquote under "## Question"
    m = re.search(r"^##\s+Question\s*\n+>\s*(.+?)(?=\n##|\Z)", text, re.MULTILINE | re.DOTALL)
    if m:
        spec["question"] = " ".join(line.strip().lstrip(">").strip() for line in m.group(1).splitlines() if line.strip()).strip()

    # Generic table-section parser — pulls "| Field | Value |" rows under a heading.
    def _table_under(heading: str) -> dict:
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

    spec["classification"] = _table_under("Classification")
    spec["expected"] = _table_under("Expected Outcome")

    # Bulleted node lists
    def _bullets_under(heading: str) -> list[str]:
        m = re.search(rf"^##\s+{re.escape(heading)}\s*\n(.+?)(?=\n##|\Z)", text, re.MULTILINE | re.DOTALL)
        if not m:
            return []
        items = []
        for line in m.group(1).splitlines():
            s = line.strip()
            if s.startswith("- ") and not s.lower().startswith("- _none"):
                items.append(s[2:].strip())
        return items

    spec["required_nodes"] = _bullets_under("Required Nodes")
    spec["forbidden_nodes"] = _bullets_under("Forbidden Nodes")

    # DDL-derived expected structural coverage — entire markdown block under
    # the heading; rendered verbatim into the report so reviewers see the
    # per-element pass/fail target alongside the actual structural counts.
    m = re.search(r"^##\s+Expected Structural Coverage[^\n]*\n(.+?)(?=\n##\s|\Z)", text, re.MULTILINE | re.DOTALL)
    spec["expected_structural_coverage"] = m.group(1).strip() if m else ""
    return spec


# ---------------------------------------------------------------------------
# Hop-log analysis helpers
# ---------------------------------------------------------------------------

def _concat_sections(inp: dict) -> str:
    secs = inp.get("sections") or []
    return "\n\n".join(s.get("text", "") for s in secs if isinstance(s, dict))


def _build_reasons_map(submits: list[dict]) -> dict[str, str]:
    """Map nodeId -> the routing question posed by an earlier hop's
    route_requests. First occurrence wins."""
    reasons: dict[str, str] = {}
    for s in submits:
        for rr in (s.get("input") or {}).get("route_requests") or []:
            nid = (rr.get("nodeId") or "").lower()
            q = rr.get("question") or ""
            if nid and q and nid not in reasons:
                reasons[nid] = q
    return reasons


# ---------------------------------------------------------------------------
# Scoring (correctness, completeness, efficiency — 0–3 each)
# ---------------------------------------------------------------------------

def _normalize_node_id(nid: str) -> str:
    """Lowercase, strip whitespace; case files use mixed casing for ids."""
    return (nid or "").strip().lower()


def _required_coverage(required: list[str], detail_slot_ids: set[str], rg_node_ids: set[str]) -> tuple[int, int, list[str]]:
    """Return (covered_count, total, missing_list)."""
    if not required:
        return (0, 0, [])
    covered = 0
    missing = []
    pool = detail_slot_ids | rg_node_ids
    for r in required:
        if _normalize_node_id(r) in pool:
            covered += 1
        else:
            missing.append(r)
    return (covered, len(required), missing)


def _forbidden_handled(forbidden: list[str], submits: list[dict]) -> tuple[int, int, list[str]]:
    """Return (pruned_or_absent, total, leaked_list).
    Forbidden nodes either MUST be pruned (verdict=prune) or never analyzed."""
    if not forbidden:
        return (0, 0, [])
    leaked = []
    handled = 0
    for fnode_full in forbidden:
        # Forbidden lines are often free-text — extract bare object names if any
        # (e.g. "Forbidden utility nodes (uspLogError, uspPrintError, ErrorLog) ...")
        names = re.findall(r"\b([a-zA-Z][a-zA-Z0-9_]+)\b", fnode_full)
        for name in names:
            if name.lower() in {"forbidden", "utility", "nodes", "in", "scope", "at", "but", "must", "be", "pruned", "via", "verdict", "prune"}:
                continue
            for s in submits:
                fid = _normalize_node_id((s.get("input") or {}).get("focus_node_id"))
                verdict = (s.get("input") or {}).get("verdict")
                if name.lower() in fid and verdict == "analyze":
                    leaked.append(f"{name} (analyzed at hop, expected prune)")
        handled += 1  # counted handled at the line-item level
    return (handled - len(leaked), handled, leaked)


def score_run(spec: dict, sm: dict, hop_log: list[dict], rg: dict, present_input: dict) -> dict:
    """Compute correctness, completeness, efficiency scores (0–3 each).

    Correctness + completeness are the critical pair (must each ≥2 for PASS).
    Efficiency is supplementary: tracks budget adherence (max hops, max runtime).
    """
    submits = [h for h in hop_log if h.get("tool") == "submit_findings"]
    detail_slots = (sm.get("memory") or {}).get("detailSlots") or {}
    detail_slot_ids = {_normalize_node_id(k) for k in detail_slots.keys()}
    rg_node_ids = {_normalize_node_id(n) for n in (rg.get("nodeIds") or rg.get("fullNodes") or [])}

    # ---- Correctness (required nodes coverage + verdict alignment) ----
    cov, tot, missing = _required_coverage(spec.get("required_nodes", []), detail_slot_ids, rg_node_ids)
    forbidden_kept, forbidden_total, leaked = _forbidden_handled(spec.get("forbidden_nodes", []), submits)
    has_present = bool(present_input)
    if tot == 0:
        # No required nodes specified — score on present_result existence + no leaked forbidden
        if has_present and not leaked:
            correctness = 3
        elif has_present:
            correctness = 2
        else:
            correctness = 1
    else:
        ratio = cov / tot
        if ratio == 1.0 and not leaked:
            correctness = 3
        elif ratio >= 0.8 and len(leaked) <= 1:
            correctness = 2
        elif ratio >= 0.5:
            correctness = 1
        else:
            correctness = 0

    # ---- Completeness (scope visited %, agenda drained, present_result quality) ----
    scope_size = sm.get("scopeSize") or 0
    hop_count = len(submits)
    sections = present_input.get("sections") or []
    has_summary = bool(present_input.get("summary"))
    has_name = bool(present_input.get("name"))
    visited_ratio = hop_count / scope_size if scope_size > 0 else 0
    status = sm.get("status")

    # T-2 — rubric mode-aware. The SM-shape rubric (status==complete + present_result
    # called + visited_ratio thresholds) only applies when the case expects SM delivery.
    # Discovery / explanation / guard-test cases never call start_exploration → no SM
    # state → completeness=0 even when the answer was correct. Gate on case spec.
    expected_for_completeness = spec.get("expected") or {}
    delivery_field = (
        expected_for_completeness.get("Delivery")
        or expected_for_completeness.get("delivery")
        or expected_for_completeness.get("SM Type")
        or ""
    )
    is_sm_case = "sm" in str(delivery_field).lower()
    started_exploration = any(h.get("tool") == "start_exploration" for h in hop_log)
    rubric_mode = "sm" if (is_sm_case and started_exploration) else "non_sm"

    if rubric_mode == "non_sm":
        # Non-SM modes: discovery / explanation / guard-test. Completeness scored on
        # whether the agent produced a non-empty answer (chat or tool output) without
        # erroring out on every hop.
        any_tool_succeeded = any(not (h.get("_meta") or {}).get("isError", False) for h in hop_log)
        any_tool_called = len(hop_log) > 0
        if any_tool_called and any_tool_succeeded:
            completeness = 3
        elif any_tool_called:
            completeness = 1
        else:
            completeness = 0
    else:
        if status == "complete" and has_present and has_name and has_summary and len(sections) >= 1 and visited_ratio >= 0.3:
            completeness = 3
        elif has_present and len(sections) >= 1 and visited_ratio >= 0.2:
            completeness = 2
        elif has_present:
            completeness = 1
        else:
            completeness = 0

    # ---- Efficiency (hops vs max, runtime vs max, no error churn) ----
    expected = spec.get("expected") or {}
    max_hops = expected.get("Max hops") or expected.get("max hops")
    max_runtime_ms = expected.get("Max total runtime (ms)") or expected.get("Max total runtime")
    try:
        max_hops_i = int(re.sub(r"[^\d]", "", str(max_hops))) if max_hops else None
    except Exception:
        max_hops_i = None
    try:
        max_runtime_i = int(re.sub(r"[^\d]", "", str(max_runtime_ms))) if max_runtime_ms else None
    except Exception:
        max_runtime_i = None

    total_dur = sum((h.get("_meta") or {}).get("durationMs", 0) for h in hop_log)
    error_count = sum(1 for h in hop_log if (h.get("_meta") or {}).get("isError"))

    eff_factors = []
    if max_hops_i:
        eff_factors.append(hop_count <= max_hops_i)
    if max_runtime_i:
        eff_factors.append(total_dur <= max_runtime_i)
    eff_factors.append(error_count == 0)
    if not eff_factors:
        efficiency = 2
    else:
        passed = sum(1 for x in eff_factors if x)
        if passed == len(eff_factors):
            efficiency = 3
        elif passed >= len(eff_factors) - 1:
            efficiency = 2
        elif passed >= 1:
            efficiency = 1
        else:
            efficiency = 0

    return {
        "correctness": correctness,
        "completeness": completeness,
        "efficiency": efficiency,
        "rubric_mode": rubric_mode,
        "required_coverage": f"{cov}/{tot}",
        "missing_required": missing,
        "forbidden_leaked": leaked,
        "max_hops_budget": max_hops_i,
        "actual_hops": hop_count,
        "max_runtime_budget_ms": max_runtime_i,
        "actual_runtime_ms": total_dur,
        "error_count": error_count,
        "visited_ratio_pct": round(visited_ratio * 100, 1),
    }


# ---------------------------------------------------------------------------
# Baseline comparison (current vs baseline-v1-2026-04-19)
# ---------------------------------------------------------------------------

def load_baseline_metrics(test_id: str) -> dict | None:
    """Return per-case baseline KPIs from the locked baseline run, or None."""
    baseline_path = RUNS_ROOT / BASELINE_RUN_ID / f"{test_id}.json"
    if not baseline_path.exists():
        return None
    try:
        d = json.loads(baseline_path.read_text(encoding="utf-8"))
    except Exception:
        return None
    hl = d.get("hop_log") or []
    sm = d.get("sm_state") or {}
    submits = [h for h in hl if h.get("tool") == "submit_findings"]
    presents = [h for h in hl if h.get("tool") == "present_result"]
    total_dur = sum((h.get("_meta") or {}).get("durationMs", 0) for h in hl)
    submit_dur = sum((h.get("_meta") or {}).get("durationMs", 0) for h in submits)
    present_dur = sum((h.get("_meta") or {}).get("durationMs", 0) for h in presents)
    submit_tokens = [(h.get("_meta") or {}).get("outputTokens", 0) for h in submits]
    present_tokens = [(h.get("_meta") or {}).get("outputTokens", 0) for h in presents]
    return {
        "hops": len(submits),
        "scope": sm.get("scopeSize") or 0,
        "total_dur_ms": total_dur,
        "phase2_dur_ms": submit_dur,
        "phase3_dur_ms": present_dur,
        "token_avg_hop": round(sum(submit_tokens) / len(submit_tokens), 1) if submit_tokens else 0,
        "token_summary": present_tokens[0] if present_tokens else 0,
    }


# ---------------------------------------------------------------------------
# Markdown report builder
# ---------------------------------------------------------------------------

def build_md(test_id: str, merged: dict, git_head: str, chat_text: str | None = None, host_log_name: str | None = None) -> tuple[str, dict]:
    hl = merged.get("hop_log") or []
    sm = merged.get("sm_state") or {}
    rg = merged.get("result_graph") or {}
    project = merged.get("project") or "(unknown — proxy did not return project)"
    proxy_filter = merged.get("filter") or {}
    submits = [h for h in hl if h.get("tool") == "submit_findings"]
    presents = [h for h in hl if h.get("tool") == "present_result"]
    present_input = presents[0].get("input", {}) if presents else {}

    spec = parse_case_spec(test_id)
    scores = score_run(spec, sm, hl, rg, present_input)
    baseline = load_baseline_metrics(test_id)

    # Per-tool durations / token tallies
    total_dur = sum((h.get("_meta") or {}).get("durationMs", 0) for h in hl)
    phase2_dur = sum((h.get("_meta") or {}).get("durationMs", 0) for h in submits)
    phase3_dur = sum((h.get("_meta") or {}).get("durationMs", 0) for h in presents)
    submit_tokens = [(h.get("_meta") or {}).get("outputTokens", 0) for h in submits]
    present_tokens = [(h.get("_meta") or {}).get("outputTokens", 0) for h in presents]
    total_tokens = sum((h.get("_meta") or {}).get("outputTokens", 0) for h in hl)
    avg_hop_tokens = round(sum(submit_tokens) / len(submit_tokens), 1) if submit_tokens else 0
    summary_tokens = present_tokens[0] if present_tokens else 0

    # User question — prefer SM-recorded; fall back to case spec
    user_question = (sm.get("memory") or {}).get("userQuestion") or spec.get("question") or ""

    # Filter — prefer live proxy filter; fall back to case-file Classification → "Filter" cell
    filt_schemas = proxy_filter.get("schemas") or []
    filt_types = proxy_filter.get("types") or []
    if not filt_schemas and not filt_types:
        case_filter = (spec.get("classification") or {}).get("Filter")
        if case_filter and case_filter.lower() != "_none_":
            # parse "schemas: [a, b]; types: [t]" or just "schemas: [...]"
            for token in case_filter.split(";"):
                t = token.strip()
                if t.lower().startswith("schemas:"):
                    filt_schemas = [s.strip() for s in t.split(":", 1)[1].strip().strip("[]").split(",") if s.strip()]
                elif t.lower().startswith("types:"):
                    filt_types = [s.strip() for s in t.split(":", 1)[1].strip().strip("[]").split(",") if s.strip()]

    # Mode strings
    mode_label = "CT (column_trace)" if sm.get("columnAspect") else "BB (blackboard)"
    memory_label = "inline" if sm.get("inlineMode") else "sliding"

    reasons = _build_reasons_map(submits)
    detail_slots = (sm.get("memory") or {}).get("detailSlots") or {}

    # Look up node type/schema/name by id — detail_slots are the authoritative
    # per-node record (one slot per visited node). Avoids the off-by-one trap of
    # reading `submit.output.focus_node`, which is the NEXT hop's focus (engine
    # advances after submit, not before).
    def _node_meta_for(node_id: str) -> dict:
        nid_norm = _normalize_node_id(node_id)
        for k, v in detail_slots.items():
            if _normalize_node_id(k) == nid_norm and isinstance(v, dict):
                return {"s": v.get("schema"), "n": v.get("name"), "t": v.get("type")}
        # Fallback: scan scope
        for n in (sm.get("scopeNodeIds") or []):
            if _normalize_node_id(n) == nid_norm:
                return {"s": "?", "n": n.split(".")[-1].strip("[]"), "t": "?"}
        return {}

    # Structural-quality KPIs — measure b1-shape coverage of the persisted description.
    def _structural_kpis(text: str) -> dict:
        if not text:
            return {"chars": 0, "tables": 0, "warnings": 0, "latex_inline": 0, "code_fences": 0, "numbered_sections": 0, "headings": 0}
        return {
            "chars": len(text),
            "tables": len(re.findall(r"^\|[^\n]*\|\s*\n\|[\s:|-]+\|\s*\n", text, re.MULTILINE)),
            "warnings": text.count("⚠️") + text.count("⚠"),
            "latex_inline": len(re.findall(r"\$[^$\n]{2,}?\$", text)),
            "code_fences": len(re.findall(r"^```", text, re.MULTILINE)) // 2,
            "numbered_sections": len(re.findall(r"^##\s+\d+[.\s]", text, re.MULTILINE)),
            "headings": len(re.findall(r"^##\s", text, re.MULTILINE)),
        }

    persisted_description = (rg.get("description") or "")
    description_kpis = _structural_kpis(persisted_description)
    chat_kpis = _structural_kpis(chat_text or "")

    lines: list[str] = []
    A = lines.append

    A(f"# Eval Report — `{test_id}`")
    A(f"**Date:** {datetime.now().strftime('%Y-%m-%d %H:%M')}  |  **GIT_HEAD:** `{git_head}`")
    if host_log_name:
        A(f"**Host log:** [`{host_log_name}`](./{host_log_name})")
    A("")

    # ---- 1. Test case ----
    A("## 1. Test case")
    A("")
    A("| Field | Value |")
    A("| :--- | :--- |")
    A(f"| Question | {user_question or '_(not captured)_'} |")
    A(f"| Source (project) | `{project}` |")
    A(f"| Mode | {mode_label} / {memory_label} |")
    A(f"| Filter — schemas | {', '.join(filt_schemas) if filt_schemas else '_(none)_'} |")
    A(f"| Filter — types | {', '.join(filt_types) if filt_types else '_(none)_'} |")
    column_aspect = sm.get("columnAspect")
    if column_aspect:
        cols = column_aspect if isinstance(column_aspect, list) else [str(column_aspect)]
        A(f"| Target columns (CT) | {', '.join(cols)} |")
    A("")

    # ---- 2. KPIs ----
    A("## 2. KPIs")
    A("")
    A("| Metric | Value |")
    A("| :--- | :--- |")
    A(f"| Duration — total | {total_dur:,} ms |")
    A(f"| Duration — phase 2 (exploration / submit_findings) | {phase2_dur:,} ms |")
    A(f"| Duration — phase 3 (synthesis / present_result) | {phase3_dur:,} ms |")
    A(f"| Tokens — avg per hop (submit_findings) | {avg_hop_tokens:,} |")
    A(f"| Tokens — final summary (present_result) | {summary_tokens:,} |")
    A(f"| Tokens — total session (all tool I/O) | {total_tokens:,} |")
    A(f"| Hops (submit_findings) | {len(submits)} |")
    A(f"| Scope size | {sm.get('scopeSize', 0)} nodes |")
    A(f"| Engine status | `{sm.get('status', '?')}` |")
    A(f"| Errors | {scores['error_count']} |")
    A("")

    # ---- 3. Baseline check ----
    A(f"## 3. Baseline check (vs `{BASELINE_RUN_ID}`)")
    A("")
    if baseline is None:
        A(f"_No baseline metrics available for this test-id under `{BASELINE_RUN_ID}/` — skipping comparison._")
        A("")
    else:
        def _delta(cur, base, unit=""):
            if base == 0:
                return f"{cur:,}{unit} (baseline: 0)"
            d = round(cur - base, 1)
            pct = (d / base * 100) if base else 0
            sign = "+" if d >= 0 else ""
            return f"{cur:,}{unit} ({sign}{d:,}{unit}, {sign}{pct:.1f}% vs baseline {base:,}{unit})"

        A("| Metric | Current | Δ vs baseline |")
        A("| :--- | ---: | :--- |")
        A(f"| Hops | {len(submits)} | {_delta(len(submits), baseline['hops'])} |")
        A(f"| Scope | {sm.get('scopeSize', 0)} | {_delta(sm.get('scopeSize', 0), baseline['scope'])} |")
        A(f"| Duration total (ms) | {total_dur:,} | {_delta(total_dur, baseline['total_dur_ms'], ' ms')} |")
        A(f"| Phase 2 (ms) | {phase2_dur:,} | {_delta(phase2_dur, baseline['phase2_dur_ms'], ' ms')} |")
        A(f"| Phase 3 (ms) | {phase3_dur:,} | {_delta(phase3_dur, baseline['phase3_dur_ms'], ' ms')} |")
        A(f"| Token avg / hop | {avg_hop_tokens:,} | {_delta(avg_hop_tokens, baseline['token_avg_hop'])} |")
        A(f"| Token summary | {summary_tokens:,} | {_delta(summary_tokens, baseline['token_summary'])} |")
        A("")

    # ---- 4. Expected outcome ----
    A("## 4. Expected outcome (from case file)")
    A("")
    expected = spec.get("expected") or {}
    if expected:
        A("| Field | Value |")
        A("| :--- | :--- |")
        for k, v in expected.items():
            A(f"| {k} | {v} |")
        A("")
    else:
        A("_No `## Expected Outcome` table parsed from case file._")
        A("")

    if spec.get("required_nodes"):
        A("**Required nodes:**")
        # Match the scoring pool so the per-node mark and the score never disagree.
        pool = {_normalize_node_id(k) for k in detail_slots.keys()} | {_normalize_node_id(n) for n in (rg.get("nodeIds") or rg.get("fullNodes") or [])}
        for n in spec["required_nodes"]:
            present = "✅" if _normalize_node_id(n) in pool else "❌"
            A(f"- {present} `{n}`")
        A("")

    if spec.get("forbidden_nodes"):
        A("**Forbidden nodes:**")
        for n in spec["forbidden_nodes"]:
            A(f"- `{n}`")
        A("")

    # ---- 5. Score ----
    A("## 5. Score")
    A("")
    A("> **Correctness and completeness are the critical pair.** Each ≥ 2 → run is acceptable. Efficiency is supplementary (budget adherence).")
    A("")
    A("| Dimension | Score (0–3) | Notes |")
    A("| :--- | :---: | :--- |")
    cov_str = scores["required_coverage"]
    miss = scores["missing_required"]
    leak = scores["forbidden_leaked"]
    notes_correct = f"required coverage {cov_str}"
    if miss:
        notes_correct += f"; missing: {', '.join(f'`{m}`' for m in miss)}"
    if leak:
        notes_correct += f"; forbidden leaked: {', '.join(leak)}"
    A(f"| Correctness | **{scores['correctness']}** | {notes_correct} |")
    A(f"| Completeness | **{scores['completeness']}** | visited {scores['visited_ratio_pct']}% of scope; status=`{sm.get('status','?')}`; present_result called: {bool(present_input)} |")
    eff_notes = []
    if scores["max_hops_budget"]:
        eff_notes.append(f"hops {scores['actual_hops']}/{scores['max_hops_budget']}")
    if scores["max_runtime_budget_ms"]:
        eff_notes.append(f"runtime {scores['actual_runtime_ms']:,}/{scores['max_runtime_budget_ms']:,} ms")
    eff_notes.append(f"errors {scores['error_count']}")
    A(f"| Efficiency | **{scores['efficiency']}** | {'; '.join(eff_notes)} |")
    A("")
    crit_pass = scores["correctness"] >= 2 and scores["completeness"] >= 2
    A(f"**Verdict:** {'✅ critical-pair PASS' if crit_pass else '❌ critical-pair FAIL'}  ·  total {scores['correctness']+scores['completeness']+scores['efficiency']}/9")
    A("")

    # ---- 6. Hops ----
    A(f"## 6. Hops ({len(submits)})")
    A("")
    A("> One block per visited node (hop order). Short/long memory sourced 1:1 from `submit_findings.input` for that hop. `Routed-out` = `route_requests[]` from the same hop; `Pruned-out` = `prune_neighbors[]`. Subquestion = the prior hop's `route_requests[].question` for this node id.")
    A("")

    # Per-hop summary table — one row per hop, mechanical KPIs for delta-vs-baseline reading.
    A("### Hop summary table")
    A("")
    A("| # | Focus | Type | Verdict | Badge | Sections | Long-mem chars | Routed-out | Pruned-out | Duration (ms) | Tokens (out) |")
    A("| -: | :--- | :--- | :--- | :--- | -: | -: | -: | -: | -: | -: |")
    for i, s in enumerate(submits):
        inp = s.get("input", {}) or {}
        meta = s.get("_meta") or {}
        fnode = inp.get("focus_node_id") or "(no focus_node_id)"
        node_meta = _node_meta_for(fnode)
        type_str = node_meta.get("t") or "?"
        secs = inp.get("sections") or []
        long_chars = sum(len((sec.get("text") or "")) for sec in secs if isinstance(sec, dict))
        routed_out = inp.get("route_requests") or []
        pruned_out = inp.get("prune_neighbors") or []
        A(f"| {i+1} | `{fnode}` | {type_str} | `{inp.get('verdict','?')}` | {inp.get('badge_label') or '—'} | {len(secs)} | {long_chars:,} | {len(routed_out)} | {len(pruned_out)} | {meta.get('durationMs', 0):,} | {meta.get('outputTokens', 0):,} |")
    A("")

    # Per-hop expanded blocks
    for i, s in enumerate(submits):
        inp = s.get("input", {}) or {}
        meta = s.get("_meta") or {}
        fnode = inp.get("focus_node_id") or "(no focus_node_id)"
        node_meta = _node_meta_for(fnode)
        type_str = node_meta.get("t") or "?"
        sub_q = reasons.get(_normalize_node_id(fnode)) or "_(initial origin — no routing question)_"

        A(f"### Hop {i+1} — `{fnode}`  *({type_str})*")
        A("")
        A("| Field | Value |")
        A("| :--- | :--- |")
        A(f"| Subquestion (why visited) | {sub_q} |")
        A(f"| Verdict | `{inp.get('verdict', '?')}` |")
        A(f"| Badge | `{inp.get('badge_label') or '—'}` |")
        if inp.get("note_caption"):
            A(f"| Note | {inp.get('note_caption')} |")
        A(f"| Hop duration | {meta.get('durationMs', 0):,} ms |")
        A(f"| Hop output tokens | {meta.get('outputTokens', 0):,} |")
        A("")
        A("**Short memory** (`summary` — one-line digest carried into next hop's `<short_term_memory>`)")
        A("")
        summary_text = (inp.get("summary") or "").strip()
        if not summary_text:
            A("_(empty)_")
        else:
            A("```text")
            A(summary_text)
            A("```")
        A("")
        A("**Long memory** (`sections[]` — full per-angle capture stored in detail-archive)")
        A("")
        secs = inp.get("sections") or []
        if not secs:
            A("_(no sections submitted)_")
            A("")
        else:
            for sec in secs:
                if not isinstance(sec, dict):
                    continue
                sec_text = (sec.get("text", "") or "").strip()
                A(f"**angle: `{sec.get('angle','?')}`**  ·  {len(sec_text):,} chars")
                A("")
                if not sec_text:
                    A("_(empty)_")
                else:
                    A("```markdown")
                    A(sec_text)
                    A("```")
                A("")

        # Routing decisions emitted from this hop
        routed_out = inp.get("route_requests") or []
        pruned_out = inp.get("prune_neighbors") or []
        if routed_out:
            A(f"**Routed-out** (`route_requests` — {len(routed_out)} new neighbors queued)")
            A("")
            for rr in routed_out:
                if not isinstance(rr, dict):
                    continue
                rr_id = rr.get("nodeId") or "?"
                rr_q = (rr.get("question") or "").strip() or "_(no question)_"
                rr_cols = rr.get("columns") or []
                col_str = f"  cols=[{', '.join(rr_cols)}]" if rr_cols else ""
                A(f"- `{rr_id}` — {rr_q}{col_str}")
            A("")
        if pruned_out:
            A(f"**Pruned-out** (`prune_neighbors` — {len(pruned_out)} neighbors discarded)")
            A("")
            for n in pruned_out:
                A(f"- `{n}`")
            A("")
        A("---")
        A("")

    # ---- 6.4 DDL-derived expected coverage (from case file) ----
    esc = spec.get("expected_structural_coverage") or ""
    if esc:
        A("## 6.4 Expected structural coverage (DDL-derived, from case file)")
        A("")
        A("> Lifted verbatim from `tests/cases/<id>.md` `## Expected Structural Coverage (DDL-derived)`. The rubric counts presence per element — DDL contains the evidence ⇒ output should reflect it. Compare against the actual counts in `## 6.5` below.")
        A("")
        A(esc)
        A("")

    # ---- 6.5 Structural counts (no char floors) ----
    # Per skill HARD RULE 5/6/7: rubric counts presence of structural elements,
    # never length. DDL-derived expected coverage lives in the case file's
    # `## Expected Structural Coverage (DDL-derived)` table. The chat-vs-
    # description ratio surfaces synthesis-role-split inversion at-a-glance.
    A("## 6.5 Structural element counts (presence, not length)")
    A("")
    A("> No char floors anywhere. A thin DDL legitimately yields a short capture; a rich DDL legitimately yields a long one. This block counts the structural elements present in each surface — compare against the case file's `## Expected Structural Coverage (DDL-derived)` table to decide pass/fail per element.")
    A("")
    A("| Element | Description (`result_graph.description`) | Chat (`<id>.chat.txt`) |")
    A("| :--- | -: | -: |")
    A(f"| numbered `## N` sections | {description_kpis['numbered_sections']} | {chat_kpis['numbered_sections']} |")
    A(f"| markdown tables | {description_kpis['tables']} | {chat_kpis['tables']} |")
    A(f"| ⚠️ callouts | {description_kpis['warnings']} | {chat_kpis['warnings']} |")
    A(f"| LaTeX `$expr$` | {description_kpis['latex_inline']} | {chat_kpis['latex_inline']} |")
    A(f"| code fences | {description_kpis['code_fences']} | {chat_kpis['code_fences']} |")
    A(f"| total `##` headings | {description_kpis['headings']} | {chat_kpis['headings']} |")
    A(f"| chars (informational only) | {description_kpis['chars']:,} | {chat_kpis['chars']:,} |")
    A("")
    if chat_kpis['chars'] > description_kpis['chars'] and description_kpis['chars'] > 0:
        ratio = chat_kpis['chars'] / max(1, description_kpis['chars'])
        A(f"> ⚠️ **Synthesis role-split inverted** — chat narration ({chat_kpis['chars']:,} chars) is **{ratio:.2f}×** the persisted description ({description_kpis['chars']:,} chars). Expected: description >> chat. The model is dumping content into the wrong surface.")
        A("")

    # detail-memory aggregate KPIs
    detail_section_count = 0
    detail_total_chars = 0
    detail_business_chars = 0
    detail_technical_chars = 0
    for slot in detail_slots.values():
        if not isinstance(slot, dict):
            continue
        for sec in (slot.get("sections") or []):
            if not isinstance(sec, dict):
                continue
            txt = sec.get("text") or ""
            detail_section_count += 1
            detail_total_chars += len(txt)
            if sec.get("angle") == "business":
                detail_business_chars += len(txt)
            elif sec.get("angle") == "technical":
                detail_technical_chars += len(txt)
    avg_detail_section = round(detail_total_chars / detail_section_count, 1) if detail_section_count else 0

    A("### Detail-memory totals (across all hops)")
    A("")
    A("| Metric | Value |")
    A("| :--- | -: |")
    A(f"| detail_slots count | {len(detail_slots)} |")
    A(f"| section count | {detail_section_count} |")
    A(f"| total long-memory chars | {detail_total_chars:,} |")
    A(f"| avg chars / section | {avg_detail_section:,} |")
    A(f"| business-angle chars | {detail_business_chars:,} |")
    A(f"| technical-angle chars | {detail_technical_chars:,} |")
    A(f"| AW reference (bb-q1-employee-technical) avg | 819 |")
    A("")

    # Routing precision — compare routed neighbors vs slots actually produced
    all_routed = set()
    all_pruned = set()
    for s in submits:
        for rr in (s.get("input") or {}).get("route_requests") or []:
            nid = _normalize_node_id(rr.get("nodeId") or "")
            if nid:
                all_routed.add(nid)
        for n in (s.get("input") or {}).get("prune_neighbors") or []:
            nid = _normalize_node_id(n)
            if nid:
                all_pruned.add(nid)
    visited = {_normalize_node_id(k) for k in detail_slots.keys()}
    routed_visited = all_routed & visited
    A("### Routing precision (auto-add / auto-prune)")
    A("")
    A("| Metric | Value |")
    A("| :--- | -: |")
    A(f"| nodes routed via `route_requests` | {len(all_routed)} |")
    A(f"| nodes pruned via `prune_neighbors` | {len(all_pruned)} |")
    A(f"| routed → visited (produced a slot) | {len(routed_visited)} / {len(all_routed)} |")
    A("")

    # ---- 7. AI summary chat output ----
    A("## 7. AI summary chat output")
    A("")
    if chat_text:
        A("_Verbatim from `<test-id>.chat.txt` — the final markdown the Haiku agent wrote back to the user after all tool calls._")
        A("")
        A("```text")
        A(chat_text.strip())
        A("```")
    else:
        A("_No `<test-id>.chat.txt` found in the run directory. Save the agent's final reply to that file before re-running extract.py to populate this section._")
    A("")

    # ---- 8. AI description output (present_result.input.description) ----
    A("## 8. AI description output (sent to React AI-preview)")
    A("")
    if not present_input:
        A("> _The agent did not call `lineage_present_result` — webview card would render empty._")
    else:
        if present_input.get("name"):
            A(f"**View name:** `{present_input.get('name')}`")
            A("")
        if present_input.get("summary"):
            A(f"**Summary:** {present_input.get('summary')}")
            A("")
        if present_input.get("description"):
            A("**Description (markdown handed to webview):**")
            A("")
            A("```markdown")
            A(present_input.get("description"))
            A("```")
            A("")
        secs = present_input.get("sections") or []
        if secs:
            A(f"**Sections ({len(secs)}):**")
            A("")
            for sec in secs:
                A(f"**section label:** `{sec.get('label', 'Untitled')}`")
                A("")
                sec_text = (sec.get("text", "") or "").strip()
                if not sec_text:
                    A("_(empty)_")
                else:
                    A("```markdown")
                    A(sec_text)
                    A("```")
                A("")
    A("")

    summary_row = {
        "id": test_id,
        "mode": mode_label,
        "memory": memory_label,
        "hops": len(submits),
        "scope": sm.get("scopeSize", 0),
        "total_dur_ms": total_dur,
        "phase2_dur_ms": phase2_dur,
        "phase3_dur_ms": phase3_dur,
        "token_avg_hop": avg_hop_tokens,
        "token_summary": summary_tokens,
        "correctness": scores["correctness"],
        "completeness": scores["completeness"],
        "efficiency": scores["efficiency"],
        "critical_pair_pass": crit_pass,
    }
    return "\n".join(lines), summary_row


# ---------------------------------------------------------------------------
# Snapshot / log / chat helpers (carried over from prior version)
# ---------------------------------------------------------------------------

def _fetch_sm_state(session_id: str, offline_fallback: Path | None = None) -> dict:
    url = f"{PROXY}/session/{session_id}/state"
    try:
        with urlopen(url, timeout=10) as resp:
            return json.loads(resp.read().decode("utf-8"))
    except URLError as e:
        if offline_fallback and offline_fallback.exists():
            print(f"[extract] proxy unreachable ({e}); using offline dump {offline_fallback.name}", file=sys.stderr)
            dump = json.loads(offline_fallback.read_text(encoding="utf-8"))
            return {
                "sm_state": dump.get("sm_state") or {},
                "hop_log": dump.get("hop_log") or [],
                "session_hop_log": dump.get("session_hop_log") or [],
                "result_graph": dump.get("result_graph") or {},
                "project": dump.get("project"),
                "filter": dump.get("filter"),
            }
        print(f"[extract] ERROR: cannot reach proxy at {url}: {e}", file=sys.stderr)
        sys.exit(2)


def _resolve_run_dir(test_id: str, session_id: str) -> Path:
    env_run_id = os.environ.get("EVAL_RUN_ID")
    if env_run_id:
        candidate = RUNS_ROOT / env_run_id
        if (candidate / f"{test_id}.agent.json").exists():
            return candidate
    if RUNS_ROOT.exists():
        for run_dir in sorted(RUNS_ROOT.iterdir(), reverse=True):
            if not run_dir.is_dir():
                continue
            agent_path = run_dir / f"{test_id}.agent.json"
            if not agent_path.exists():
                continue
            try:
                meta = json.loads(agent_path.read_text(encoding="utf-8"))
            except json.JSONDecodeError:
                continue
            if meta.get("session_id") == session_id:
                return run_dir
    print(f"[extract] ERROR: no run-dir found for test_id={test_id} session_id={session_id}.", file=sys.stderr)
    sys.exit(3)


def _git_head() -> str:
    try:
        out = subprocess.run(
            ["git", "rev-parse", "--short", "HEAD"],
            capture_output=True, text=True, timeout=5, cwd=str(PROJECT_ROOT),
        )
        return out.stdout.strip() or "HEAD"
    except (FileNotFoundError, subprocess.TimeoutExpired):
        return "HEAD"


# ---------------------------------------------------------------------------
# Phase A2 — decision-trace.json: parse [AI] structured lines from host.log.
# Per .claude/rules/logging.md, every decision boundary emits a structured
# line. We extract the full set; prefixes with zero hits surface as
# `missing_log_emitters` — the empty list IS the evidence that a product-side
# emitter is missing (deferred to iter-2 product-code work).
# ---------------------------------------------------------------------------

# Prefix patterns we expect per logging.md §"[AI] sub-categories"
_DECISION_PREFIXES = [
    "[AI] [NL]",
    "[AI] [Contract]",
    "[AI] [Engine] [BFS]",
    "[AI] [Engine] [BFS-refine]",
    "[AI] [Gate]",
    "[AI] [Refine]",
    "[AI] [PromptBudget]",
]

# `[AI] [Hop N]` is per-hop; we treat it separately to capture N.
_HOP_RE = re.compile(r"\[AI\]\s*\[Hop\s+(\d+)\]\s*(.*)$")
# Optional leading timestamp `[2026-04-27T05:08:57Z]` or `2026-04-27 05:08:57`.
_TS_RE = re.compile(r"^\s*\[?(\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}\.?\d*Z?)\]?\s+")


def _parse_decision_trace(host_log_text: str) -> dict:
    if not host_log_text:
        return {"events": [], "missing_log_emitters": _DECISION_PREFIXES + ["[AI] [Hop N]"], "host_log_present": False}

    seen_prefixes: set[str] = set()
    events: list[dict] = []

    for raw in host_log_text.splitlines():
        line = raw.rstrip()
        ts_m = _TS_RE.match(line)
        ts = ts_m.group(1) if ts_m else None
        body_after_ts = line[ts_m.end():] if ts_m else line

        hop_m = _HOP_RE.search(body_after_ts)
        if hop_m:
            seen_prefixes.add("[AI] [Hop N]")
            events.append({
                "ts": ts,
                "prefix": "[AI] [Hop N]",
                "hop": int(hop_m.group(1)),
                "body": hop_m.group(2).strip(),
            })
            continue

        for pref in _DECISION_PREFIXES:
            idx = body_after_ts.find(pref)
            if idx != -1:
                seen_prefixes.add(pref)
                events.append({
                    "ts": ts,
                    "prefix": pref,
                    "hop": None,
                    "body": body_after_ts[idx + len(pref):].strip(),
                })
                break

    expected = set(_DECISION_PREFIXES + ["[AI] [Hop N]"])
    missing = sorted(expected - seen_prefixes)

    return {
        "events": events,
        "missing_log_emitters": missing,
        "host_log_present": True,
        "event_count": len(events),
    }


def _extract_model_id(host_log_text: str) -> str | None:
    """Best-effort scan for the LM model id from the host log."""
    if not host_log_text:
        return None
    # Common patterns: `[AI] [Session] modelName=...`, `model=claude-haiku-4.5`, etc.
    for pat in (
        r"\[AI\][^\n]*?modelName=([\w\-\.]+)",
        r"\[AI\][^\n]*?model=([\w\-\.]+)",
        r"\bmodel[_\s]?id[=:]\s*([\w\-\.]+)",
    ):
        m = re.search(pat, host_log_text, re.IGNORECASE)
        if m:
            return m.group(1)
    return None


# ---------------------------------------------------------------------------
# Phase A6 — perf.json fetch
# ---------------------------------------------------------------------------

def _fetch_perf(session_id: str) -> dict | None:
    """GET /session/:id/perf — proxy may not implement; tolerate 404."""
    try:
        with urlopen(f"{PROXY}/session/{session_id}/perf", timeout=5) as r:
            raw = r.read().decode("utf-8", errors="replace")
            return json.loads(raw) if raw else None
    except (URLError, OSError, ValueError):
        return None


# ---------------------------------------------------------------------------
# Phase A5 — gate.md from session state (or /session/:id/gates if exposed)
# ---------------------------------------------------------------------------

def _fetch_gates(session_id: str, state: dict) -> list[dict]:
    """Try the dedicated endpoint first; fall back to a `gates` field on /state."""
    try:
        with urlopen(f"{PROXY}/session/{session_id}/gates", timeout=5) as r:
            raw = r.read().decode("utf-8", errors="replace")
            data = json.loads(raw) if raw else {}
            if isinstance(data, dict) and isinstance(data.get("gates"), list):
                return data["gates"]
            if isinstance(data, list):
                return data
    except (URLError, OSError, ValueError):
        pass
    gates = state.get("gates")
    return gates if isinstance(gates, list) else []


# ---------------------------------------------------------------------------
# Phase A8 — atomic chat-capture: poll for chat.txt before declaring missing.
# ---------------------------------------------------------------------------

def _poll_chat_text(run_dir: Path, test_id: str, timeout_s: int = 10) -> str | None:
    path = run_dir / f"{test_id}.chat.txt"
    deadline = time.time() + timeout_s
    while time.time() < deadline:
        if path.exists():
            try:
                return path.read_text(encoding="utf-8", errors="replace")
            except OSError:
                pass
        time.sleep(0.5)
    return None


# ---------------------------------------------------------------------------
# Phase A7 — eval-runs-index.json append (cross-run trend index)
# ---------------------------------------------------------------------------

def _append_runs_index(
    run_id: str,
    test_id: str,
    git_sha: str,
    summary: dict,
    sm_state: dict,
    hop_log: list,
    artifacts: list[str],
    frame_errors: int,
    track: str = "track_a",
) -> None:
    idx_path = RUNS_ROOT / "eval-runs-index.json"
    rows: list[dict] = []
    if idx_path.exists():
        try:
            rows = json.loads(idx_path.read_text(encoding="utf-8"))
        except json.JSONDecodeError:
            rows = []
    submits = [h for h in hop_log if h.get("tool") == "submit_findings"]
    submit_tokens = [(h.get("_meta") or {}).get("outputTokens", 0) for h in submits]
    total_dur = sum((h.get("_meta") or {}).get("durationMs", 0) for h in hop_log)
    err_count = sum(1 for h in hop_log if (h.get("_meta") or {}).get("isError"))
    row = {
        "run_id": run_id,
        "test_id": test_id,
        "track": track,
        "git_sha": git_sha,
        "ts": datetime.now().isoformat(),
        "status": sm_state.get("status"),
        "phase": sm_state.get("phase"),
        "scope_size": sm_state.get("scopeSize"),
        "hops": len(submits),
        "duration_ms": total_dur,
        "token_avg_hop": round(sum(submit_tokens) / len(submit_tokens), 1) if submit_tokens else 0,
        "errors": err_count,
        "frame_errors": frame_errors,
        "correctness": summary.get("correctness"),
        "completeness": summary.get("completeness"),
        "efficiency": summary.get("efficiency"),
        "critical_pair_pass": summary.get("critical_pair_pass"),
        "captured_artifacts": artifacts,
    }
    # Replace any existing row for the same (run_id, test_id) — re-runs supersede
    rows = [r for r in rows if not (r.get("run_id") == run_id and r.get("test_id") == test_id and r.get("track", "track_a") == track)]
    rows.append(row)
    idx_path.write_text(json.dumps(rows, indent=2, ensure_ascii=False), encoding="utf-8")


# ---------------------------------------------------------------------------
# Phase A7b — --compare flag: diff iteration N vs N-1 from the index.
# ---------------------------------------------------------------------------

def _compare_runs(current_run_id: str, baseline_run_id: str) -> str:
    idx_path = RUNS_ROOT / "eval-runs-index.json"
    if not idx_path.exists():
        return "_(eval-runs-index.json missing — run --compare after at least one full run)_"
    rows = json.loads(idx_path.read_text(encoding="utf-8"))

    def by_run(rid: str) -> dict[str, dict]:
        return {r["test_id"]: r for r in rows if r.get("run_id") == rid}

    cur = by_run(current_run_id)
    base = by_run(baseline_run_id)
    if not cur:
        return f"_(no rows for run_id={current_run_id})_"
    if not base:
        return f"_(no rows for baseline run_id={baseline_run_id})_"

    cases = sorted(set(cur.keys()) | set(base.keys()))
    out: list[str] = []
    out.append(f"# Eval-runs Diff — `{baseline_run_id}` → `{current_run_id}`")
    out.append("")
    out.append("| Case | Δ correctness | Δ completeness | Δ efficiency | Δ hops | Δ errors | Δ token_avg_hop | Note |")
    out.append("| :--- | :---: | :---: | :---: | :---: | :---: | :---: | :--- |")

    def fmt_delta(c, b, key):
        cv, bv = c.get(key), b.get(key)
        if cv is None or bv is None:
            return "—"
        delta = cv - bv
        sign = "+" if delta > 0 else ""
        return f"{sign}{delta}"

    for tid in cases:
        c = cur.get(tid, {})
        b = base.get(tid, {})
        if not c:
            out.append(f"| `{tid}` | — | — | — | — | — | — | _missing in current_ |")
            continue
        if not b:
            out.append(f"| `{tid}` | — | — | — | — | — | — | _new in current_ |")
            continue
        note = ""
        if c.get("critical_pair_pass") and not b.get("critical_pair_pass"):
            note = "regressed→passed"
        elif b.get("critical_pair_pass") and not c.get("critical_pair_pass"):
            note = "REGRESSION"
        out.append(
            f"| `{tid}` | {fmt_delta(c, b, 'correctness')} | {fmt_delta(c, b, 'completeness')} | "
            f"{fmt_delta(c, b, 'efficiency')} | {fmt_delta(c, b, 'hops')} | "
            f"{fmt_delta(c, b, 'errors')} | {fmt_delta(c, b, 'token_avg_hop')} | {note} |"
        )
    return "\n".join(out) + "\n"


# ---------------------------------------------------------------------------
# Phase A1 augmentation — fill model_id in inputs.json post-run
# ---------------------------------------------------------------------------

# ---------------------------------------------------------------------------
# T-1 — length-vs-reference.json: per-case content-depth telemetry.
#
# Records char/line counts for chat.txt, persisted result_graph.description,
# and the present_result.input body fields, alongside an AdventureWorks-only
# internal-benchmark reference (the iter-1 best-performing AW case). DOES NOT
# reference CadenceWorker / tmp/baseline/{b1,b2,b3,output_main} — those are
# customer-data, reserved for UAT, never tuning targets.
# ---------------------------------------------------------------------------

# AdventureWorks domain internal floor (iter-1 best-performing AW case).
# Update when a new AW case beats this; never replace with customer-data refs.
_AW_REFERENCE = {
    "case_id": "bb-q1-employee-technical",
    "iter": "iteration-1-baseline-2026-04-27",
    "detail_slots": 12,
    "avg_section_chars": 819,
    "present_result_sections": 6,
    "critical_pair_pass": True,
    "note": "iter-1 best AW-domain case (technical classification). bb-q1-employee (default-business) regressed to 1/1/2; this is the depth floor it should reach.",
}


def _line_count(s: str) -> int:
    return s.count("\n") + (1 if s and not s.endswith("\n") else 0)


def _build_length_vs_reference(
    test_id: str,
    chat_text: str | None,
    state: dict,
    hop_log: list,
) -> dict:
    sm = state.get("sm_state") or {}
    rg = state.get("result_graph") or {}
    presents = [h for h in hop_log if h.get("tool") == "present_result"]
    pr_input = (presents[0].get("input") or {}) if presents else {}

    chat_chars = len(chat_text or "")
    chat_lines = _line_count(chat_text or "")
    persisted_desc = rg.get("description") or ""
    pr_sections = pr_input.get("sections") or []
    section_chars = [len((s.get("text") or "")) for s in pr_sections]

    # Per-slot avg from sm_state.memory.detailSlots — what active-phase capture wrote.
    detail_slots = (sm.get("memory") or {}).get("detailSlots") or {}
    slot_section_chars: list[int] = []
    for slot in detail_slots.values():
        for sec in (slot.get("sections") or []):
            slot_section_chars.append(len(sec.get("text") or ""))

    return {
        "test_id": test_id,
        "ts": datetime.now().isoformat(),
        "chat_txt": {
            "chars": chat_chars,
            "lines": chat_lines,
        },
        "result_graph_persisted": {
            "description_chars": len(persisted_desc),
            "summary_chars": len(rg.get("summary") or ""),
            "intro_chars": len(rg.get("intro") or ""),
            "closing_chars": len(rg.get("closing") or ""),
            "title_chars": len(rg.get("title") or ""),
            "sections_count": len(rg.get("sections") or []),
        },
        "present_result_input": {
            "name_chars": len(pr_input.get("name") or ""),
            "summary_chars": len(pr_input.get("summary") or ""),
            "intro_chars": len(pr_input.get("intro") or ""),
            "closing_chars": len(pr_input.get("closing") or ""),
            "sections_count": len(pr_sections),
            "avg_section_chars": round(sum(section_chars) / len(section_chars)) if section_chars else 0,
            "max_section_chars": max(section_chars) if section_chars else 0,
            "min_section_chars": min(section_chars) if section_chars else 0,
        },
        "detail_memory": {
            "slot_count": len(detail_slots),
            "total_section_count": len(slot_section_chars),
            "avg_section_chars": round(sum(slot_section_chars) / len(slot_section_chars)) if slot_section_chars else 0,
            "min_section_chars": min(slot_section_chars) if slot_section_chars else 0,
            "max_section_chars": max(slot_section_chars) if slot_section_chars else 0,
        },
        "aw_reference": _AW_REFERENCE,
        "deltas_vs_aw_reference": {
            "detail_slot_count_delta": len(detail_slots) - _AW_REFERENCE["detail_slots"],
            "avg_section_delta": (
                round(sum(slot_section_chars) / len(slot_section_chars)) if slot_section_chars else 0
            ) - _AW_REFERENCE["avg_section_chars"],
            "present_result_section_delta": len(pr_sections) - _AW_REFERENCE["present_result_sections"],
        },
        "notes": [
            "AW-only reference — CadenceWorker (tmp/baseline/) is reserved for UAT, not tuning.",
            "If detail_memory.avg_section_chars is below 400, the active-phase capture template is the upstream gap (CR-6).",
            "If present_result_input.sections is rich but result_graph_persisted.description_chars == 0, that's B-1 (persistence) — should be fixed in iter-2 round 1a.",
        ],
    }


def _augment_inputs_json(run_dir: Path, test_id: str, host_log_text: str) -> None:
    p = run_dir / f"{test_id}.inputs.json"
    if not p.exists():
        return
    try:
        d = json.loads(p.read_text(encoding="utf-8"))
    except json.JSONDecodeError:
        return
    if not d.get("model_id"):
        mid = _extract_model_id(host_log_text)
        if mid:
            d["model_id"] = mid
            p.write_text(json.dumps(d, indent=2, ensure_ascii=False), encoding="utf-8")


def _write_snapshots(run_dir: Path, test_id: str, state: dict) -> None:
    snap_dir = run_dir / "snapshots" / test_id
    snap_dir.mkdir(parents=True, exist_ok=True)
    sm = state.get("sm_state") or {}
    trimmed = {
        "status": sm.get("status"),
        "phase": sm.get("phase"),
        "hopCount": sm.get("hopCount"),
        "scopeSize": sm.get("scopeSize"),
        "scopeNodeIds": sm.get("scopeNodeIds"),
        "columnAspect": sm.get("columnAspect"),
        "verdictCounts": sm.get("verdictCounts"),
    }
    (snap_dir / "sm-state-trimmed.json").write_text(json.dumps(trimmed, indent=2, ensure_ascii=False), encoding="utf-8")

    hl = state.get("hop_log") or []
    hop_timing = [
        {
            "hop": i + 1,
            "tool": h.get("tool"),
            "focus_node_id": (h.get("input") or {}).get("focus_node_id"),
            "duration_ms": (h.get("_meta") or {}).get("durationMs"),
            "output_tokens": (h.get("_meta") or {}).get("outputTokens"),
        }
        for i, h in enumerate(hl)
    ]
    (snap_dir / "hop-timing.json").write_text(json.dumps(hop_timing, indent=2, ensure_ascii=False), encoding="utf-8")

    errors = [
        {"hop": i + 1, "tool": h.get("tool"), "error": (h.get("_meta") or {}).get("errorType")}
        for i, h in enumerate(hl) if (h.get("_meta") or {}).get("isError")
    ]
    (snap_dir / "errors.json").write_text(json.dumps(errors, indent=2, ensure_ascii=False), encoding="utf-8")

    # Phase A4 — errors-detailed: preserve the full error message body that
    # toolProxy.ts now records under _meta.errorMessage (in addition to errorType).
    # If errorMessage is absent (older proxy), this is still useful: it captures
    # the response output verbatim so we can post-mortem the failure.
    errors_detailed = []
    for i, h in enumerate(hl):
        meta = h.get("_meta") or {}
        if not meta.get("isError"):
            continue
        errors_detailed.append({
            "hop": i + 1,
            "tool": h.get("tool"),
            "error_type": meta.get("errorType"),
            "error_message": meta.get("errorMessage"),
            "input_truncated": _truncate(h.get("input"), 300),
            "output_truncated": _truncate(h.get("output"), 600),
            "duration_ms": meta.get("durationMs"),
        })
    (run_dir / f"{test_id}.errors-detailed.json").write_text(
        json.dumps(errors_detailed, indent=2, ensure_ascii=False), encoding="utf-8"
    )

    # Phase A3 — tool-io.json: full per-call I/O dump (authoritative source).
    # Snapshot files above are lossy summaries; this is the raw record.
    tool_io = []
    for i, h in enumerate(hl):
        meta = h.get("_meta") or {}
        tool_io.append({
            "hop": i + 1,
            "tool": h.get("tool"),
            "input": h.get("input"),
            "output": h.get("output"),
            "duration_ms": meta.get("durationMs"),
            "input_bytes": meta.get("inputBytes"),
            "output_bytes": meta.get("outputBytes"),
            "input_tokens": meta.get("inputTokens"),
            "output_tokens": meta.get("outputTokens"),
            "is_error": bool(meta.get("isError")),
            "error_type": meta.get("errorType"),
            "error_message": meta.get("errorMessage"),
        })
    (run_dir / f"{test_id}.tool-io.json").write_text(
        json.dumps(tool_io, indent=2, ensure_ascii=False), encoding="utf-8"
    )

    presents = [h for h in hl if h.get("tool") == "present_result"]
    enrich_audit = {
        "called": bool(presents),
        "calls": [
            {
                "hop": i + 1,
                "name": (p.get("input") or {}).get("name"),
                "section_count": len((p.get("input") or {}).get("sections") or []),
            }
            for i, p in enumerate(presents)
        ],
    }
    (snap_dir / "enrich-view-audit.json").write_text(json.dumps(enrich_audit, indent=2, ensure_ascii=False), encoding="utf-8")


def _copy_host_log(run_dir: Path, test_id: str) -> Path | None:
    candidates: list[Path] = []
    env_log = os.environ.get("EVAL_HOST_LOG")
    if env_log:
        candidates.append(Path(env_log))
    candidates.append(Path("/tmp/test-eval.log"))
    import tempfile as _tempfile
    candidates.append(Path(_tempfile.gettempdir()) / "test-eval.log")
    for src in candidates:
        if src.exists() and src.is_file():
            dest = run_dir / f"{test_id}.host.log"
            try:
                dest.write_text(src.read_text(encoding="utf-8", errors="replace"), encoding="utf-8")
                return dest
            except OSError as exc:
                print(f"[extract] could not copy host log from {src}: {exc}", file=sys.stderr)
    return None


def _read_chat_text(run_dir: Path, test_id: str) -> str | None:
    path = run_dir / f"{test_id}.chat.txt"
    if path.exists():
        return path.read_text(encoding="utf-8", errors="replace")
    return None


# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------

if __name__ == "__main__":
    # --compare <baseline-run-id> [--current <current-run-id>]: cross-run diff
    if len(sys.argv) >= 3 and sys.argv[1] == "--compare":
        baseline_rid = sys.argv[2]
        current_rid = os.environ.get("EVAL_RUN_ID")
        if "--current" in sys.argv:
            i = sys.argv.index("--current")
            if i + 1 < len(sys.argv):
                current_rid = sys.argv[i + 1]
        if not current_rid:
            print("[extract] --compare requires EVAL_RUN_ID env var or --current <run-id>", file=sys.stderr)
            sys.exit(2)
        diff_md = _compare_runs(current_rid, baseline_rid)
        out_path = RUNS_ROOT / current_rid / f"_compare-vs-{baseline_rid}.md"
        out_path.parent.mkdir(parents=True, exist_ok=True)
        out_path.write_text(diff_md, encoding="utf-8")
        print(f"[extract] diff written -> {out_path.relative_to(PROJECT_ROOT)}")
        sys.exit(0)

    if len(sys.argv) < 3:
        print("Usage: python extract.py <test-id> <session-id>", file=sys.stderr)
        print("       python extract.py --compare <baseline-run-id> [--current <run-id>]", file=sys.stderr)
        sys.exit(1)

    test_id = sys.argv[1]
    session_id = sys.argv[2]
    run_dir = _resolve_run_dir(test_id, session_id)

    offline_dump = run_dir / f"{test_id}.json"
    state = _fetch_sm_state(session_id, offline_fallback=offline_dump)

    agent_meta_path = run_dir / f"{test_id}.agent.json"
    try:
        agent_meta = json.loads(agent_meta_path.read_text(encoding="utf-8"))
    except (FileNotFoundError, json.JSONDecodeError):
        agent_meta = {}

    merged = {
        "test_id": test_id,
        "session_id": session_id,
        "agent_meta": agent_meta,
        "sm_state": state.get("sm_state") or {},
        "hop_log": state.get("hop_log") or [],
        "session_hop_log": state.get("session_hop_log") or [],
        "result_graph": state.get("result_graph") or {},
        "project": state.get("project"),
        "filter": state.get("filter"),
    }

    (run_dir / f"{test_id}.json").write_text(json.dumps(merged, indent=2, ensure_ascii=False), encoding="utf-8")

    host_log_path = _copy_host_log(run_dir, test_id)
    # Phase A8 — atomic chat-capture: poll up to 10s for chat.txt before declaring missing.
    chat_text = _poll_chat_text(run_dir, test_id, timeout_s=10)

    # Phase A2 — decision-trace.json (best-effort host.log scan)
    host_log_text = ""
    if host_log_path and host_log_path.exists():
        host_log_text = host_log_path.read_text(encoding="utf-8", errors="replace")
    decision_trace = _parse_decision_trace(host_log_text)
    (run_dir / f"{test_id}.decision-trace.json").write_text(
        json.dumps(decision_trace, indent=2, ensure_ascii=False), encoding="utf-8"
    )

    # Phase A1 augmentation — fill model_id in inputs.json from host.log
    _augment_inputs_json(run_dir, test_id, host_log_text)

    # Phase A6 — perf.json (best-effort; proxy may not implement endpoint yet)
    perf = _fetch_perf(session_id)
    if perf is not None:
        (run_dir / f"{test_id}.perf.json").write_text(
            json.dumps(perf, indent=2, ensure_ascii=False), encoding="utf-8"
        )

    # Phase A5 — gate.md (best-effort; falls back to no-file if proxy lacks the endpoint)
    gates = _fetch_gates(session_id, state)
    if gates:
        gate_lines = [f"# Gate Detail — `{test_id}`", ""]
        for g in gates:
            gtype = g.get("type") or g.get("gate") or "(unknown)"
            gate_lines.append(f"## {gtype}")
            gate_lines.append("")
            detail = g.get("detail") or g.get("markdown") or ""
            gate_lines.append(detail if isinstance(detail, str) else json.dumps(detail, indent=2, ensure_ascii=False))
            gate_lines.append("")
        (run_dir / f"{test_id}.gate.md").write_text("\n".join(gate_lines), encoding="utf-8")

    report, summary = build_md(
        test_id, merged, _git_head(),
        chat_text=chat_text,
        host_log_name=host_log_path.name if host_log_path else None,
    )
    (run_dir / f"{test_id}.md").write_text(report, encoding="utf-8")

    _write_snapshots(run_dir, test_id, state)

    # T-1 — length-vs-reference artifact (AW-only internal benchmark)
    lvr = _build_length_vs_reference(test_id, chat_text, state, merged.get("hop_log") or [])
    (run_dir / f"{test_id}.length-vs-reference.json").write_text(
        json.dumps(lvr, indent=2, ensure_ascii=False), encoding="utf-8"
    )

    # Phase A7 — append/update eval-runs-index.json (cross-run trend index)
    artifacts = []
    for ext in (".md", ".inputs.json", ".decision-trace.json", ".tool-io.json",
                ".errors-detailed.json", ".perf.json", ".gate.md", ".chat.txt", ".host.log"):
        if (run_dir / f"{test_id}{ext}").exists():
            artifacts.append(f"{test_id}{ext}")
    run_id = run_dir.name
    _append_runs_index(
        run_id=run_id,
        test_id=test_id,
        git_sha=_git_head(),
        summary=summary,
        sm_state=state.get("sm_state") or {},
        hop_log=merged.get("hop_log") or [],
        artifacts=artifacts,
        frame_errors=0,
        track="track_a",
    )

    print(f"[extract] wrote {test_id}.md + snapshots under {run_dir}")
    print(f"[extract] score: correctness={summary['correctness']} completeness={summary['completeness']} efficiency={summary['efficiency']} critical_pair_pass={summary['critical_pair_pass']}")
    if decision_trace.get("missing_log_emitters"):
        print(f"[extract] decision-trace: missing log emitters = {decision_trace['missing_log_emitters']}")
    if host_log_path:
        print(f"[extract] host log copied -> {host_log_path.name}")
    if chat_text:
        print(f"[extract] chat text captured ({len(chat_text)} chars)")
    else:
        print("[extract] WARNING: chat text not captured after 10s poll — §7 will flag explicitly")
