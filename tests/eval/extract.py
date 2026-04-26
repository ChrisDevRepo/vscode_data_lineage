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
import json
import os
import re
import subprocess
import sys
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
    A("> One block per visited node (hop order). All fields sourced 1:1 from `submit_findings.input` for that hop; subquestion comes from the prior hop's `route_requests[]`.")
    A("")
    for i, s in enumerate(submits):
        inp = s.get("input", {}) or {}
        out = s.get("output", {}) or {}
        fnode = inp.get("focus_node_id") or "(no focus_node_id)"
        # node-meta lookup: SM mode emits focus_node, inline mode uses fullNodes[0]/detail_slots[0]
        node_meta = out.get("focus_node") or {}
        if not node_meta:
            nested = (out.get("result") or {}) if isinstance(out.get("result"), dict) else {}
            fn = nested.get("fullNodes") or []
            if fn:
                node_meta = fn[0]
            else:
                ds = nested.get("detail_slots") or []
                if ds:
                    ds0 = ds[0]
                    node_meta = {"s": ds0.get("schema"), "n": ds0.get("name"), "t": ds0.get("type")}
        type_str = node_meta.get("t") or node_meta.get("type") or "?"
        sub_q = reasons.get(_normalize_node_id(fnode)) or "_(initial origin — no routing question)_"

        A(f"### Hop {i+1} — `{fnode}`  *({type_str})*")
        A("")
        A("| Field | Value |")
        A("| :--- | :--- |")
        A(f"| Subquestion | {sub_q} |")
        A(f"| Status (verdict) | `{inp.get('verdict', '?')}` |")
        A(f"| Label (badge) | `{inp.get('badge_label') or '—'}` |")
        if inp.get("note_caption"):
            A(f"| Note | {inp.get('note_caption')} |")
        A("")
        A("**Short memory** (`summary`)")
        A("")
        summary_text = (inp.get("summary") or "").strip()
        if not summary_text:
            A("_(empty)_")
        else:
            A("```text")
            A(summary_text)
            A("```")
        A("")
        A("**Long memory** (`sections[]`)")
        A("")
        secs = inp.get("sections") or []
        if not secs:
            A("_(no sections submitted)_")
            A("")
        else:
            for sec in secs:
                if not isinstance(sec, dict):
                    continue
                A(f"**angle: `{sec.get('angle','?')}`**")
                A("")
                sec_text = (sec.get("text", "") or "").strip()
                if not sec_text:
                    A("_(empty)_")
                else:
                    # Fence section text so embedded markdown headers / lists in the AI's
                    # authored memory don't collide with the report's own outline.
                    A("```markdown")
                    A(sec_text)
                    A("```")
                A("")
        A("---")
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
    if len(sys.argv) < 3:
        print("Usage: python extract.py <test-id> <session-id>", file=sys.stderr)
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
    chat_text = _read_chat_text(run_dir, test_id)

    report, summary = build_md(
        test_id, merged, _git_head(),
        chat_text=chat_text,
        host_log_name=host_log_path.name if host_log_path else None,
    )
    (run_dir / f"{test_id}.md").write_text(report, encoding="utf-8")

    _write_snapshots(run_dir, test_id, state)

    print(f"[extract] wrote {test_id}.md + snapshots under {run_dir}")
    print(f"[extract] score: correctness={summary['correctness']} completeness={summary['completeness']} efficiency={summary['efficiency']} critical_pair_pass={summary['critical_pair_pass']}")
    if host_log_path:
        print(f"[extract] host log copied -> {host_log_path.name}")
    if chat_text:
        print(f"[extract] chat text captured ({len(chat_text)} chars)")
