import json
import os
import subprocess
import sys
from datetime import datetime
from collections import Counter
from pathlib import Path
from urllib.error import URLError
from urllib.request import urlopen

# Usage: python extract.py <test-id> <session-id>
# Fetches SM state from http://127.0.0.1:3271/session/<session-id>/state,
# merges with <run-dir>/<test-id>.agent.json metadata, scores via
# score_and_build_md, and writes <test-id>.md + snapshots/<test-id>/*.json
# under the run directory (resolved from $EVAL_RUN_ID or by walking
# test-results/eval-runs/*/).

PROXY = "http://127.0.0.1:3271"
PROJECT_ROOT = Path(__file__).resolve().parent.parent.parent
RUNS_ROOT = PROJECT_ROOT / "test-results" / "eval-runs"

def parse_case(test_id: str) -> dict:
    """Extract metadata from test ID (e.g. bb-q1-employee)."""
    parts = test_id.split("-")
    mode = "BB" if parts[0] == "bb" else "CT" if parts[0] == "ct" else "unknown"
    return {"id": test_id, "mode": mode}

def score_and_build_md(test_id: str, merged: dict, git_head: str) -> tuple[str, dict]:
    """Return (markdown_report, summary_row)."""
    hl = merged.get("hop_log") or []
    sm = merged.get("sm_state") or {}
    rg = merged.get("result_graph") or {}
    case = parse_case(test_id)

    submits = [h for h in hl if h.get("tool") == "submit_findings"]
    presents = [h for h in hl if h.get("tool") == "present_result"]
    present_input = presents[0].get("input", {}) if presents else {}

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

    # Result Graph metrics
    node_count = len(rg.get("fullNodes", []))
    edge_count = len(rg.get("edges", []))
    origin = rg.get("originNodeId")

    lines = []
    def A(s): lines.append(s)

    A(f"# Eval Report: {test_id}")
    A(f"**Date:** {datetime.now().strftime('%Y-%m-%d %H:%M')}")
    A(f"**GIT_HEAD:** `{git_head}`")
    A("")
    A("## 1. Summary Metrics")
    A("")
    A("| Metric | Value | Notes |")
    A("| :--- | :--- | :--- |")
    A(f"| mode | {case['mode']} | |")
    A(f"| total_hops | {len(submits)} | |")
    A(f"| verdict_split | analyze={verdicts.get('analyze', 0)} | pass={verdicts.get('pass', 0)} | prune={verdicts.get('prune', 0)} |")
    A(f"| avg_detail_len | {sum(det_lens)//len(det_lens) if det_lens else 0} chars | |")
    A(f"| avg_summary_len | {sum(summary_lens)//len(summary_lens) if summary_lens else 0} chars | |")
    A(f"| sql_coverage | {sql_hops}/{len(submits)} hops | {int(sql_hops*100/len(submits)) if submits else 0}% |")
    A(f"| latex_coverage | {latex_hops}/{len(submits)} hops | |")
    A(f"| table_coverage | {table_hops}/{len(submits)} hops | |")
    A(f"| final_nodes | {node_count} | |")
    A(f"| final_edges | {edge_count} | |")
    A("")

    A("## 2. Answer (present_result rendering)")
    A("")
    if not present_input:
        A("_Classic discovery answer (no present_result):_")
        A("")
        # Fallback to chat prose
        chat_resp = merged.get("response") or "(empty)"
        A(chat_resp)
    else:
        A(f"### {present_input.get('name', 'Untitled View')}")
        A(f"> {present_input.get('summary', '')}")
        A("")
        if present_input.get("description"):
            A(present_input.get("description"))
        
        for sec in present_input.get("sections", []):
            label = sec.get("label", "Untitled")
            A(f"#### {label}")
            A(sec.get("text", ""))
            A("")

    A("---")
    A("## 3. Hop Trace")
    A("")
    for i, s in enumerate(submits):
        inp = s.get("input", {})
        A(f"### Hop {i+1}: {inp.get('focus_node_id')}")
        A(f"**Verdict:** `{inp.get('verdict')}` | **Badge:** `{inp.get('badge_label')}`")
        A("")
        A(inp.get("detail_analysis", ""))
        A("")
        A(f"> **Summary:** {inp.get('summary')}")
        A("")

    summary_row = {
        "id": test_id,
        "mode": case["mode"],
        "hops": len(submits),
        "nodes": node_count,
        "edges": edge_count,
        "analyze": verdicts.get("analyze", 0),
        "pass": verdicts.get("pass", 0),
        "prune": verdicts.get("prune", 0),
        "avg_det": sum(det_lens)//len(det_lens) if det_lens else 0,
        "sql_pct": int(sql_hops*100/len(submits)) if submits else 0,
        "present_result_called": bool(presents),
    }

    return "\n".join(lines), summary_row

def _fetch_sm_state(session_id: str) -> dict:
    url = f"{PROXY}/session/{session_id}/state"
    try:
        with urlopen(url, timeout=10) as resp:
            return json.loads(resp.read().decode("utf-8"))
    except URLError as e:
        print(
            f"[extract] ERROR: cannot reach proxy at {url}: {e}\n"
            f"[extract] Hint: start the eval proxy with 'npm run test:eval' and keep it running.",
            file=sys.stderr,
        )
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
    print(
        f"[extract] ERROR: no run-dir found for test_id={test_id} session_id={session_id}.\n"
        f"[extract] Set $EVAL_RUN_ID or ensure {test_id}.agent.json exists under {RUNS_ROOT}.",
        file=sys.stderr,
    )
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
    (snap_dir / "sm-state-trimmed.json").write_text(
        json.dumps(trimmed, indent=2, ensure_ascii=False), encoding="utf-8"
    )

    hl = state.get("hop_log") or []
    hop_timing = [
        {
            "hop": i + 1,
            "tool": h.get("tool"),
            "focus_node_id": (h.get("input") or {}).get("focus_node_id"),
            "duration_ms": (h.get("_meta") or {}).get("durationMs"),
        }
        for i, h in enumerate(hl)
    ]
    (snap_dir / "hop-timing.json").write_text(
        json.dumps(hop_timing, indent=2, ensure_ascii=False), encoding="utf-8"
    )

    errors = [
        {
            "hop": i + 1,
            "tool": h.get("tool"),
            "error": (h.get("result") or {}).get("error"),
        }
        for i, h in enumerate(hl)
        if isinstance(h.get("result"), dict) and h["result"].get("error")
    ]
    (snap_dir / "errors.json").write_text(
        json.dumps(errors, indent=2, ensure_ascii=False), encoding="utf-8"
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
    (snap_dir / "enrich-view-audit.json").write_text(
        json.dumps(enrich_audit, indent=2, ensure_ascii=False), encoding="utf-8"
    )


if __name__ == "__main__":
    if len(sys.argv) < 3:
        print("Usage: python extract.py <test-id> <session-id>", file=sys.stderr)
        sys.exit(1)

    test_id = sys.argv[1]
    session_id = sys.argv[2]
    run_dir = _resolve_run_dir(test_id, session_id)

    state = _fetch_sm_state(session_id)

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
    }

    (run_dir / f"{test_id}.json").write_text(
        json.dumps(merged, indent=2, ensure_ascii=False), encoding="utf-8"
    )

    report, _ = score_and_build_md(test_id, merged, _git_head())
    (run_dir / f"{test_id}.md").write_text(report, encoding="utf-8")

    _write_snapshots(run_dir, test_id, state)

    print(f"[extract] wrote {test_id}.md + snapshots under {run_dir}")
