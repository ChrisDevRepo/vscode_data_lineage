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
    """Infer mode from test ID — recognizes bb/ct anywhere in the id so ad-hoc
    probes (`adhoc-bb-*`, `adhoc-ct-*`) and plain baseline ids (`bb-*`, `ct-*`)
    both resolve. Fallbacks look at the session's columnAspect at render time."""
    parts = test_id.lower().split("-")
    if "bb" in parts:
        mode = "BB"
    elif "ct" in parts:
        mode = "CT"
    else:
        mode = "infer"  # resolved from sm_state.columnAspect in score_and_build_md
    return {"id": test_id, "mode": mode}

def score_and_build_md(test_id: str, merged: dict, git_head: str, chat_text: str | None = None, host_log_name: str | None = None) -> tuple[str, dict]:
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

    # Result Graph metrics — proxy returns `nodeIds`, legacy dumps used `fullNodes`.
    # Check both keys so the count is accurate regardless of source.
    node_count = len(rg.get("nodeIds") or rg.get("fullNodes") or [])
    edge_count = len(rg.get("edges") or [])
    origin = rg.get("originNodeId")

    # Mode inference fallback — if parse_case couldn't decide from the id,
    # use sm_state.columnAspect: set → CT, null → BB.
    resolved_mode = case["mode"]
    if resolved_mode == "infer":
        resolved_mode = "CT" if sm.get("columnAspect") else "BB"
    case = {**case, "mode": resolved_mode}

    # Inline vs sliding-memory execution — SM emits `working_memory` in each
    # submit output; inline mode does not. Controls how §4 renders post-hop state.
    inline_mode = bool(sm.get("inlineMode"))

    # User question + target columns — pulled from session working memory (survives every hop)
    mem = sm.get("memory") or {}
    user_question = mem.get("userQuestion") or ""
    if not user_question and submits:
        wm = (submits[0].get("output") or {}).get("working_memory") or {}
        user_question = wm.get("user_question", "")
    column_aspect = sm.get("columnAspect")

    # Build a {nodeId → reason_for_visit} map from route_requests across all submits.
    # The reason_for_visit is the question the AI posed when routing a neighbor;
    # it's the "per-hop question" the user wants surfaced next to each detail memory.
    reasons: dict[str, str] = {}
    for s in submits:
        for rr in (s.get("input") or {}).get("route_requests") or []:
            nid = (rr.get("nodeId") or "").lower()
            q = rr.get("question") or ""
            if nid and q and nid not in reasons:
                reasons[nid] = q
    # Persisted detail slots — the ground-truth memory at end of session
    detail_slots = mem.get("detailSlots") or {}

    lines = []
    def A(s): lines.append(s)

    A(f"# Eval Report: {test_id}")
    A(f"**Date:** {datetime.now().strftime('%Y-%m-%d %H:%M')}")
    A(f"**GIT_HEAD:** `{git_head}`")
    if host_log_name:
        A(f"**Host log:** [`{host_log_name}`](./{host_log_name}) (full vscode-tester extension-host trace)")
    else:
        A("**Host log:** _not captured — set `$EVAL_HOST_LOG` or ensure `%TEMP%/test-eval.log` exists at extract time._")
    A("")
    A("## 1. User Question")
    A("")
    A(f"> {user_question or '(not captured)'}")
    if column_aspect:
        A("")
        A(f"**Target columns (CT mode):** `{', '.join(column_aspect) if isinstance(column_aspect, list) else column_aspect}`")
    A("")

    A("## 2. Summary Metrics")
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
    A(f"| detail_slot_count | {len(detail_slots)} | persisted after all hops |")
    A(f"| final_nodes | {node_count} | |")
    A(f"| final_edges | {edge_count} | |")
    A(f"| present_result_called | {bool(presents)} | final description rendered? |")
    A("")

    A("---")
    A("## Output stage map")
    A("")
    A("The agent's work surfaces in FOUR distinguishable stages. Each section below labels which stage it reflects.")
    A("")
    stage_c = "✅" if chat_text else "❌ (no `<test-id>.chat.txt` found)"
    stage_d = "✅" if present_input else "❌ (tool never called)"
    A("| Stage | Where it lives | Captured here in | Present in this run |")
    A("| :--- | :--- | :--- | :--- |")
    A("| **A. SM phase trace** | `proxyLog` on the HTTP bridge (timing, gates, errors per tool call) | §3 | ✅ always |")
    A("| **B. Per-hop authored memory** | `submit_findings.input.{detail_analysis, summary}` → `sm_state.memory.detailSlots` | §4 + §6 | ✅ always |")
    A(f"| **C. User chat response** | Final text the Haiku agent wrote back after all tool calls | §5 | {stage_c} |")
    A(f"| **D. React AI-preview payload** | `present_result.input` (name/summary/description/sections) — the webview card | §7 | {stage_d} |")
    A("")

    A("---")
    A("## 3. Stage A — SM phase trace (tool-call sequence)")
    A("")
    A("_Each row = one POST /tool call. Errors, gates, and durations shown. This is what the state machine recorded._")
    A("")
    A("| # | tool | focus / op | duration ms | in/out bytes | error |")
    A("| :--- | :--- | :--- | ---: | ---: | :--- |")
    for i, h in enumerate(hl):
        tool = h.get("tool") or "?"
        inp = h.get("input") or {}
        meta = h.get("_meta") or {}
        # Each tool uses a different primary input key — show whichever is set
        # so rows for search/ddl/neighborhood aren't blank.
        focus = (
            inp.get("focus_node_id")
            or inp.get("origin")
            or inp.get("nodeId")
            or inp.get("query")
            or inp.get("name")
            or ""
        )
        dur = meta.get("durationMs", "?")
        ib = meta.get("inputBytes", "?")
        ob = meta.get("outputBytes", "?")
        out = h.get("output") or {}
        err = ""
        if meta.get("isError"):
            err = f"`{meta.get('errorType')}`"
            gate = (out.get("gate") if isinstance(out, dict) else None)
            if gate:
                err += f" gate=`{gate}`"
        A(f"| {i+1} | `{tool}` | `{focus}` | {dur} | {ib} / {ob} | {err or '—'} |")
    A("")

    A("---")
    A("## 4. Stage B — Per-hop authored memory (live)")
    A("")
    # Build a per-submit node-meta map from the inline `result.fullNodes`
    # (inline mode) OR the top-level `output.focus_node` (SM mode).
    for i, s in enumerate(submits):
        inp = s.get("input", {})
        out = s.get("output", {}) or {}
        wm = out.get("working_memory", {}) or {}
        fnode = inp.get("focus_node_id") or ""
        # Node metadata: prefer SM-mode focus_node; fall back to result.fullNodes[0]
        # or result.detail_slots[0] (inline true-done mode).
        node_meta = out.get("focus_node") or {}
        if not node_meta:
            nested = (out.get("result") or {}) if isinstance(out.get("result"), dict) else {}
            fn = nested.get("fullNodes") or []
            if fn:
                # fullNodes entries use s/n/t keys
                node_meta = fn[0]
            else:
                ds = nested.get("detail_slots") or []
                if ds:
                    ds0 = ds[0]
                    node_meta = {"s": ds0.get("schema"), "n": ds0.get("name"), "t": ds0.get("type")}
        reason = reasons.get(fnode.lower()) or ""

        A(f"### Hop {i+1}: `{fnode}`")
        if node_meta and (node_meta.get("s") or node_meta.get("n")):
            A(f"_{node_meta.get('s','?')}.{node_meta.get('n','?')} ({node_meta.get('t','?')})_")
        A("")
        A(f"**Routed because (question posed at routing):** {reason or '_initial origin — no routing question_'}")
        A("")
        A(
            f"**Verdict:** `{inp.get('verdict')}`  |  "
            f"**Badge:** `{inp.get('badge_label') or '—'}`  |  "
            f"**Note:** {inp.get('note_caption') or '—'}"
        )
        A("")
        A("#### Detail memory (authored `detail_analysis`)")
        A("")
        detail = inp.get("detail_analysis", "") or "_(empty)_"
        A(detail)
        A("")
        A("#### Summary memory (authored `summary`)")
        A(f"> {inp.get('summary') or '_(empty)_'}")
        A("")
        if inline_mode:
            A("#### Post-hop state")
            A("_Inline mode — no `working_memory` envelope is emitted (checklist / agenda / depth tracking is SM-only)._ ")
            nested = (out.get("result") or {}) if isinstance(out.get("result"), dict) else {}
            if nested:
                A(
                    f"- result.status = `{nested.get('status','?')}`  "
                    f"nodes={len(nested.get('fullNodes') or [])}  "
                    f"edges={len(nested.get('edges') or [])}  "
                    f"detail_slots={len(nested.get('detail_slots') or [])}"
                )
            if out.get("done") is True:
                A("- `done: true` — agent terminated the inline exploration.")
        else:
            A("#### Post-hop state (from `working_memory` delivered after this hop)")
            cl = wm.get("checklist") or {}
            A(f"- Checklist: hop={cl.get('current_hop','?')}  rounds_used={cl.get('rounds_used','?')}  noted={cl.get('noted','?')}/{cl.get('total','?')}  coverage={cl.get('coveragePct','?')}%  open={cl.get('open','?')}")
            A(f"- Agenda remaining: {out.get('agenda_remaining','?')}")
            A(f"- Depth: budget={wm.get('depth_budget','?')} cap={wm.get('depth_cap','?')} enforcement=`{wm.get('depth_enforcement','?')}`")
            recent_rej = wm.get("recent_rejections") or []
            if recent_rej:
                A(f"- Recent rejections: {len(recent_rej)} — {', '.join(str(r) for r in recent_rej[:3])}")
        A("")

    A("---")
    A("## 5. Stage C — User chat response (final text streamed back to the user)")
    A("")
    if chat_text:
        A("_Captured from `<test-id>.chat.txt` — what the Haiku agent wrote after tool calls completed. This is what a real user would see as the chat answer._")
        A("")
        A("```text")
        A(chat_text.strip())
        A("```")
    else:
        A("_No `<test-id>.chat.txt` found in the run folder. The proxy does not observe the Haiku agent's final text response — the orchestrator (this Claude Code session) must save the agent's final reply to `<test-id>.chat.txt` after the agent completes._")
    A("")

    A("---")
    A("## 6. Stage B (continued) — Persisted Detail Memory archive")
    A("")
    A(f"_{len(detail_slots)} slot(s) survived — these are the final archive the AI would dump at synthesis. Each slot is the end-state of one `detailSlots[nodeId]` in the memory store._")
    A("")
    # Engine-bug detection — slot is blank but the matching submit input WAS authored.
    blank_but_authored = []
    for slot_id, slot in detail_slots.items():
        if not isinstance(slot, dict):
            continue
        if not (slot.get("summary") or "").strip() and not (slot.get("analysis") or "").strip():
            # find matching submit
            for s in submits:
                if (s.get("input", {}).get("focus_node_id", "") or "").lower() == slot_id.lower():
                    inp = s.get("input", {})
                    if (inp.get("summary") or "").strip() or (inp.get("detail_analysis") or "").strip():
                        blank_but_authored.append(slot_id)
                    break
    if blank_but_authored:
        A("> ⚠ **Engine anomaly detected.** The following slot(s) were persisted with empty `summary` AND `analysis` even though the agent's `submit_findings` input contained authored text for both fields. The inline-mode memory write-back path is dropping the authored text.")
        A(">")
        for nid in blank_but_authored:
            A(f"> - `{nid}`")
        A("")
    for slot_id, slot in detail_slots.items():
        if not isinstance(slot, dict):
            continue
        A(f"### `{slot.get('nodeId', slot_id)}` — {slot.get('schema','?')}.{slot.get('name','?')} ({slot.get('type','?')})")
        A("")
        if slot.get("reason_for_visit"):
            A(f"**Reason for visit:** {slot.get('reason_for_visit')}")
            A("")
        if slot.get("badge_label"):
            A(f"**Badge:** `{slot.get('badge_label')}`  **Note:** {slot.get('note_caption') or '—'}")
            A("")
        A("**Summary:**")
        A(f"> {slot.get('summary') or '_(empty)_'}")
        A("")
        A("**Analysis:**")
        A("")
        A(slot.get("analysis") or "_(empty)_")
        A("")
        A("")

    A("---")
    A("## 7. Stage D — React AI-preview payload (`present_result` → webview card)")
    A("")
    if not present_input:
        A("> _The agent did not call `lineage_present_result` (or `lineage_enrich_view`)._")
        A("> _Without this tool call, the React webview shows no preview card — the user would see only the chat text from Stage C._")
    else:
        A("_This is the exact JSON the extension handed to the React preview component. The card the user actually sees is rendered from these fields._")
        A("")
        A(f"**View name:** `{present_input.get('name', '(unnamed)')}`")
        A("")
        summ = present_input.get('summary', '')
        if summ:
            A(f"**Summary:** {summ}")
            A("")
        if present_input.get("description"):
            A("**Description (markdown as sent to webview):**")
            A("")
            A("```markdown")
            A(present_input.get("description"))
            A("```")
            A("")
        secs = present_input.get("sections", []) or []
        A(f"**Sections ({len(secs)}):**")
        A("")
        for sec in secs:
            label = sec.get("label", "Untitled")
            A(f"#### {label}")
            A("")
            A(sec.get("text", "") or "_(empty)_")
            A("")
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

def _fetch_sm_state(session_id: str, offline_fallback: Path | None = None) -> dict:
    """Fetch SM state from proxy. If proxy is down and offline_fallback is a
    saved <test_id>.json dump, re-use its sm_state/hop_log/result_graph blocks
    (lets us regenerate MD reports from historical runs)."""
    url = f"{PROXY}/session/{session_id}/state"
    try:
        with urlopen(url, timeout=10) as resp:
            return json.loads(resp.read().decode("utf-8"))
    except URLError as e:
        if offline_fallback and offline_fallback.exists():
            print(
                f"[extract] proxy unreachable ({e}); using offline dump {offline_fallback.name}",
                file=sys.stderr,
            )
            dump = json.loads(offline_fallback.read_text(encoding="utf-8"))
            return {
                "sm_state": dump.get("sm_state") or {},
                "hop_log": dump.get("hop_log") or [],
                "session_hop_log": dump.get("session_hop_log") or [],
                "result_graph": dump.get("result_graph") or {},
            }
        print(
            f"[extract] ERROR: cannot reach proxy at {url}: {e}\n"
            f"[extract] Hint: start the eval proxy with 'npm run test:eval' and keep it running,\n"
            f"[extract]       or re-run with a saved <test_id>.json present in the run-dir.",
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


def _copy_host_log(run_dir: Path, test_id: str) -> Path | None:
    """Copy the vscode-tester extension-host log into the run dir so each test
    retains the full bridge-side trace (startup, tool calls, gates, errors).

    Source precedence:
      1. $EVAL_HOST_LOG env var (explicit)
      2. /tmp/test-eval.log (canonical location per .claude/skills/eval-loop/SKILL.md)
    """
    candidates: list[Path] = []
    env_log = os.environ.get("EVAL_HOST_LOG")
    if env_log:
        candidates.append(Path(env_log))
    # Unix: /tmp. Windows (bash "/tmp" aliases to %TEMP%): also try tempfile path.
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
    """Pick up the orchestrator-supplied agent-final-response text if present."""
    path = run_dir / f"{test_id}.chat.txt"
    if path.exists():
        return path.read_text(encoding="utf-8", errors="replace")
    return None


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
    }

    (run_dir / f"{test_id}.json").write_text(
        json.dumps(merged, indent=2, ensure_ascii=False), encoding="utf-8"
    )

    host_log_path = _copy_host_log(run_dir, test_id)
    chat_text = _read_chat_text(run_dir, test_id)

    report, _ = score_and_build_md(
        test_id, merged, _git_head(),
        chat_text=chat_text,
        host_log_name=host_log_path.name if host_log_path else None,
    )
    (run_dir / f"{test_id}.md").write_text(report, encoding="utf-8")

    _write_snapshots(run_dir, test_id, state)

    print(f"[extract] wrote {test_id}.md + snapshots under {run_dir}")
    if host_log_path:
        print(f"[extract] host log copied -> {host_log_path.name}")
    if chat_text:
        print(f"[extract] chat text captured ({len(chat_text)} chars)")
