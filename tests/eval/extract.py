import json
import os
import sys
import re
from datetime import datetime
from collections import Counter

# Usage: python extract.py <test_merged.json> [output.md]
# Extracts per-hop metrics and builds a human-readable evaluation report.

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

if __name__ == "__main__":
    if len(sys.argv) < 2:
        print("Usage: python extract.py <merged_results.json> [output.md]")
        sys.exit(1)

    json_path = sys.argv[1]
    md_path = sys.argv[2] if len(sys.argv) > 2 else "eval_report.md"

    with open(json_path, "r", encoding="utf-8") as f:
        data = json.load(f)

    # If data is a list of results (many tests)
    if isinstance(data, list):
        full_report = []
        summary_rows = []
        for test_merged in data:
            tid = test_merged.get("test_id", "unknown")
            report, row = score_and_build_md(tid, test_merged, "HEAD")
            full_report.append(report)
            summary_rows.append(row)
        
        # Build summary table
        st = ["# Global Eval Summary", ""]
        st.append("| ID | Mode | Hops | Nodes | A/P/Pr | SQL% | Present |")
        st.append("| :--- | :--- | :--- | :--- | :--- | :--- | :--- |")
        for r in summary_rows:
            st.append(f"| {r['id']} | {r['mode']} | {r['hops']} | {r['nodes']} | {r['analyze']}/{r['pass']}/{r['prune']} | {r['sql_pct']}% | {r['present_result_called']} |")
        
        with open(md_path, "w", encoding="utf-8") as f:
            f.write("\n\n".join(st) + "\n\n" + "\n\n".join(full_report))
    else:
        tid = data.get("test_id", "unknown")
        report, _ = score_and_build_md(tid, data, "HEAD")
        with open(md_path, "w", encoding="utf-8") as f:
            f.write(report)
