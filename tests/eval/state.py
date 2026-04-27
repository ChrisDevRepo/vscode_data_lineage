"""Resumable iteration state — atomic load/advance/log helpers.

Two files act as the iteration's memory:
  - test-results/iteration-state.json (machine-readable; phase tracker)
  - test-results/iteration-log.md     (append-only narrative)

Any new Claude Code session can resume by reading state.json's `next_action`
and tailing the log. Every meaningful action calls advance() or log(), which
write atomically (tmpfile + rename).

CLI usage (the eval-loop shell glue calls these):
    python tests/eval/state.py advance <phase> <action_description>
    python tests/eval/state.py log <message>
    python tests/eval/state.py mark_case_done <case_id> <track>   # track: track_a | track_b
    python tests/eval/state.py mark_artifact <path>
    python tests/eval/state.py mark_frame_fix <symptom> <file_line> <fix_summary>
    python tests/eval/state.py show

Library usage:
    from state import state_load, state_advance, state_log
"""
from __future__ import annotations

import json
import os
import sys
import tempfile
from datetime import datetime, timezone
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parent.parent.parent
STATE_PATH = PROJECT_ROOT / "test-results" / "iteration-state.json"
LOG_PATH = PROJECT_ROOT / "test-results" / "iteration-log.md"


def _now_iso() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def _atomic_write(path: Path, content: str) -> None:
    # Atomic via tmpfile + rename so a crashed process can't leave a half-written file.
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp = tempfile.mkstemp(prefix=path.name + ".", dir=str(path.parent), text=True)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            f.write(content)
        os.replace(tmp, path)
    except Exception:
        if os.path.exists(tmp):
            os.unlink(tmp)
        raise


def state_load() -> dict:
    if not STATE_PATH.exists():
        raise FileNotFoundError(
            f"iteration-state.json missing at {STATE_PATH}. "
            "Bootstrap a new iteration or restore from prior run."
        )
    return json.loads(STATE_PATH.read_text(encoding="utf-8"))


def state_save(state: dict) -> None:
    _atomic_write(STATE_PATH, json.dumps(state, indent=2) + "\n")


def state_log(line: str, phase: str = "log", action: str = "note") -> None:
    # Append one line; never rewrites prior content.
    LOG_PATH.parent.mkdir(parents=True, exist_ok=True)
    formatted = f"[{_now_iso()}] [{phase}] [{action}] {line}\n"
    with open(LOG_PATH, "a", encoding="utf-8") as f:
        f.write(formatted)


def state_advance(phase: str, action: str, files: list[str] | None = None) -> None:
    """Update state.json's last_completed_action + log a line."""
    state = state_load()
    state["last_completed_action"] = {
        "phase": phase,
        "action": action,
        "files": files or [],
        "ts": _now_iso(),
    }
    state_save(state)
    files_suffix = f" — {', '.join(files)}" if files else ""
    state_log(f"{action}{files_suffix}", phase=phase, action="advance")


def mark_case_done(case_id: str, track: str) -> None:
    """Move case from track_x_remaining → track_x_completed."""
    state = state_load()
    f_run = state["phase_status"]["F_run"]
    rem_key = f"{track}_remaining"
    done_key = f"{track}_completed"
    if rem_key not in f_run:
        raise ValueError(f"unknown track: {track}; expected track_a or track_b")
    if case_id in f_run[rem_key]:
        f_run[rem_key].remove(case_id)
    if case_id not in f_run[done_key]:
        f_run[done_key].append(case_id)
    state_save(state)
    state_log(f"{case_id} → {done_key}", phase="F_run", action="mark_done")


def mark_artifact(path: str) -> None:
    state = state_load()
    if path not in state["artifacts_written"]:
        state["artifacts_written"].append(path)
        state_save(state)


def mark_frame_fix(symptom: str, file_line: str, fix_summary: str) -> None:
    state = state_load()
    state["frame_fixes_applied"].append(
        {
            "ts": _now_iso(),
            "symptom": symptom,
            "file_line": file_line,
            "fix": fix_summary,
        }
    )
    state_save(state)
    state_log(f"{symptom} | {file_line} | {fix_summary}", phase="frame_fix", action="apply")


def set_next_action(action: str) -> None:
    state = state_load()
    state["next_action"] = action
    state_save(state)


def set_phase_status(phase_key: str, status: str) -> None:
    state = state_load()
    if phase_key not in state["phase_status"]:
        raise KeyError(f"unknown phase: {phase_key}")
    state["phase_status"][phase_key]["status"] = status
    if status == "in_progress":
        state["current_phase"] = phase_key
    state_save(state)
    state_log(f"{phase_key} → {status}", phase=phase_key, action="status")


def _cmd_show() -> None:
    state = state_load()
    print(json.dumps(state, indent=2))


def _render_entrypoint() -> None:
    """Render STATUS + TASK LIST sections of tmp/SELF-IMPROVEMENT-ENTRYPOINT.md
    from iteration-state.json. Preserves manually-curated sections (JOURNAL,
    REFERENCE, HOW TO CONTINUE) by editing only between markers.
    """
    state = state_load()
    entry_path = PROJECT_ROOT / "tmp" / "SELF-IMPROVEMENT-ENTRYPOINT.md"
    entry_path.parent.mkdir(parents=True, exist_ok=True)

    # STATUS block
    status_lines = [
        "<!-- STATUS:BEGIN (auto-rendered by state.py render-entrypoint — do not edit by hand) -->",
        f"**Iteration:** {state.get('iteration_number')} · **Label:** `{state.get('iteration_label')}` · **Branch:** `{state.get('branch')}`",
        f"**Current phase:** `{state.get('current_phase')}`",
        f"**NEXT_ACTION:** {state.get('next_action')}",
        "",
        "**Health:**",
    ]
    for k, v in (state.get("health_summary") or {}).items():
        status_lines.append(f"- {k}: {v}")
    status_lines.append(f"- frame_fixes_applied: {len(state.get('frame_fixes_applied') or [])}")
    status_lines.append(f"- artifacts_written: {len(state.get('artifacts_written') or [])}")
    status_lines.append("<!-- STATUS:END -->")
    status_block = "\n".join(status_lines)

    # TASK LIST block
    task_lines = ["<!-- TASKS:BEGIN (auto-rendered by state.py render-entrypoint — do not edit by hand) -->"]
    tl = state.get("task_list") or {}
    for round_key, round_def in tl.items():
        rs = round_def.get("status", "pending")
        marker = {"completed": "✅", "in_progress": "🔄", "pending": "⏳"}.get(rs, "•")
        task_lines.append(f"\n### {marker} {round_key}  _(status: {rs})_")
        for t in round_def.get("tasks", []):
            tmarker = {"completed": "[x]", "in_progress": "[~]", "pending": "[ ]"}.get(t.get("status", "pending"), "[ ]")
            files = ", ".join(t.get("files") or []) or "—"
            line = f"- {tmarker} **{t.get('id')}** — {t.get('desc')}"
            task_lines.append(line)
            task_lines.append(f"  - files: `{files}`")
            if t.get("validation"):
                task_lines.append(f"  - validation: {t['validation']}")
    task_lines.append("\n<!-- TASKS:END -->")
    task_block = "\n".join(task_lines)

    # If file exists, surgically replace blocks; else write template
    if entry_path.exists():
        text = entry_path.read_text(encoding="utf-8")
        text = _replace_block(text, "STATUS", status_block)
        text = _replace_block(text, "TASKS", task_block)
        _atomic_write(entry_path, text)
    else:
        # Initial template — manual sections will be filled in once
        template = f"""# Self-Improvement Entry Point — `@lineage`

**Read this first.** This is the canonical dashboard for the @lineage iteration cycle. Any new Claude Code session opens this file to know exactly where to pick up.

Source of truth for state: `test-results/iteration-state.json` (machine-readable).
Append-only narrative: `test-results/iteration-log.md`.

---

## 1. STATUS

{status_block}

---

## 2. TASK LIST

{task_block}

---

## 3. JOURNAL

<!-- JOURNAL:BEGIN — append-only; never delete entries -->

### iter-1 baseline (2026-04-27)
- All 12 Track-A cases ran; 5/12 critical-pair PASS. Telemetry pipeline (Phase A1-A8) produced 11 artifacts per case.
- Track-B 7/8 PASS; the 1 fail (`feat-filter-overgeneralized`) is a captured doctrine drift.
- Headline finding: business-mode output 7× thinner vs `tmp/baseline/b1` reference.
- Diagnosed: regression is prompt/template contraction across commits 88141b7, 5519e28, 9912411, 144c6ea — not a model issue.
- Final report: `tmp/eval-iteration-1-baseline-2026-04-27-bugs-and-CR.md`.

### iter-2 round 1a (date pending) — bugs + telemetry
- _populate after round runs_

<!-- JOURNAL:END -->

---

## 4. REFERENCE

**Reports**
- `tmp/eval-iteration-1-baseline-2026-04-27-bugs-and-CR.md` — iter-1 final report (12 sections)
- `tmp/eval-frame-fixes-*.md` — per-iteration frame-fix audit log

**Telemetry per case** (under `test-results/eval-runs/<run-id>/`)
- `<id>.md` — scored report
- `<id>.json` — merged SM state + hop_log + result_graph
- `<id>.inputs.json` — sha256 fingerprint (system/nav/tool_descs/question + git_sha)
- `<id>.decision-trace.json` — `[AI] [...]` events + `missing_log_emitters`
- `<id>.tool-io.json` — every tool call full I/O
- `<id>.errors-detailed.json` — error message bodies (post-A4)
- `<id>.gate.md` — gate envelope detail markdown
- `<id>.perf.json` — per-round latency + tokens
- `<id>.chat.txt` — final reply (atomic-captured pre-extract.py)
- `<id>.host.log` — extension log copy
- `<id>.length-vs-reference.json` — char/line counts vs `tmp/baseline/b1` (added in iter-2 T-1)

**Cross-run / cross-iteration**
- `test-results/eval-runs/eval-runs-index.json` — append-on-extract trend index
- `test-results/iteration-state.json` — phase tracker
- `test-results/iteration-log.md` — append-only narrative

**Reference outputs (gold standard)**
- `tmp/baseline/b1/enrich-view_description.md` — 27,878 chars CadenceWorker business analysis
- `tmp/baseline/b1/chat_output.md` — 5,263 chars
- `tmp/baseline/output_main/enrich-view_description.md` — 13,467 chars
- `tmp/baseline/output_main/chat_output.md` — 70,374 chars

**Curated 12-case suite** (Track A)
- `tests/cases/*.md` — locked baseline (6 cases)
- `test-results/cases/iteration-1-baseline-2026-04-27/*.md` — staged archive (6 cases via `run.py` ad-hoc fallback)

**Track B** — `tests/e2e/feature/feat-*.py` (8 deterministic tests, no LLM)

**Hard rules**
- No harness coaching (`tests/eval/validate.py` fails-closed)
- No rubric loosening; mode-gating allowed (T-2)
- No case-file score-chasing (B-2 fix is a correctness fix, exempt)
- Sequential only (AiSession is singleton); Haiku-only for Track-A
- No `src/ai/**`, `assets/**`, prompts edits except via this flow

**Run commands**
```
# Pre-flight (only if proxy stale)
curl -X POST http://127.0.0.1:3271/shutdown
rm -rf out/test                                                    # rebuild fresh
EVAL_WAIT=1 EVAL_SIGNAL_DIR=$PWD/test-results npm run test:eval > /tmp/test-eval.log 2>&1 &
until curl -s http://127.0.0.1:3271/health > /dev/null; do sleep 4; done

# Track-B (~5 min)
EVAL_RUN_ID=$RUN_ID python tests/e2e/feature/run_all.py --run-id $RUN_ID

# Track-A per case
EVAL_RUN_ID=$RUN_ID python tests/eval/run.py <case> $RUN_ID
# orchestrator spawns Agent(model:"haiku", subagent_type:"general-purpose") with the populated prompt
SID=$(jq -r .session_id test-results/eval-runs/$RUN_ID/<case>.agent.json)
test -f test-results/eval-runs/$RUN_ID/<case>.md || \
  EVAL_RUN_ID=$RUN_ID python tests/eval/extract.py <case> $SID
python tests/eval/state.py mark_case_done <case> track_a

# Cross-run diff
EVAL_RUN_ID=$RUN_ID python tests/eval/extract.py --compare iteration-1-baseline-2026-04-27
```

---

## 5. HOW TO CONTINUE (vibe-code prompt for any new session)

```
You are continuing the @lineage self-improvement loop. Read tmp/SELF-IMPROVEMENT-ENTRYPOINT.md
first — the STATUS block tells you the iteration + next_action. Then:

1. cat test-results/iteration-state.json | jq .next_action
2. tail -30 test-results/iteration-log.md
3. Identify the next pending task in TASK LIST (status [ ]).
4. Apply ONE change. Verify per the task's validation step.
5. Append to JOURNAL with date + outcome + delta vs prior.
6. Update iteration-state.json via:
     python tests/eval/state.py advance <phase> <action> [files...]
     python tests/eval/state.py mark_frame_fix <symptom> <file:line> <fix>
7. Re-render STATUS+TASKS:
     python tests/eval/state.py render-entrypoint
8. Stop and report — do not chain into the next task without confirmation.

Hard rules: no harness coaching (validate.py fails-closed), no rubric loosening,
no case-file score chasing, no `src/ai/**` edits beyond the next pending task,
sequential only, Haiku-only for Track-A, deterministic urllib for Track-B.
```
"""
        _atomic_write(entry_path, template)


def _replace_block(text: str, marker: str, replacement: str) -> str:
    """Replace text between <!-- MARKER:BEGIN ... --> and <!-- MARKER:END --> markers."""
    import re as _re
    pattern = _re.compile(rf"<!-- {marker}:BEGIN.*?<!-- {marker}:END -->", _re.DOTALL)
    if pattern.search(text):
        return pattern.sub(replacement, text)
    return text + "\n\n" + replacement


def _main(argv: list[str]) -> int:
    if len(argv) < 2:
        print("usage: state.py {advance|log|mark_case_done|mark_artifact|mark_frame_fix|set_next|set_status|show} ...")
        return 2
    cmd = argv[1]
    args = argv[2:]
    if cmd == "advance":
        if len(args) < 2:
            print("usage: advance <phase> <action> [file1 file2 ...]")
            return 2
        state_advance(args[0], args[1], files=args[2:] or None)
    elif cmd == "log":
        if not args:
            print("usage: log <message>")
            return 2
        state_log(" ".join(args))
    elif cmd == "mark_case_done":
        if len(args) != 2:
            print("usage: mark_case_done <case_id> <track_a|track_b>")
            return 2
        mark_case_done(args[0], args[1])
    elif cmd == "mark_artifact":
        if len(args) != 1:
            print("usage: mark_artifact <path>")
            return 2
        mark_artifact(args[0])
    elif cmd == "mark_frame_fix":
        if len(args) != 3:
            print("usage: mark_frame_fix <symptom> <file:line> <fix_summary>")
            return 2
        mark_frame_fix(args[0], args[1], args[2])
    elif cmd == "set_next":
        if not args:
            print("usage: set_next <action>")
            return 2
        set_next_action(" ".join(args))
    elif cmd == "set_status":
        if len(args) != 2:
            print("usage: set_status <phase_key> <status>")
            return 2
        set_phase_status(args[0], args[1])
    elif cmd == "show":
        _cmd_show()
    elif cmd == "render-entrypoint":
        _render_entrypoint()
        print(f"rendered: {(PROJECT_ROOT / 'tmp' / 'SELF-IMPROVEMENT-ENTRYPOINT.md').relative_to(PROJECT_ROOT)}")
    else:
        print(f"unknown command: {cmd}")
        return 2
    return 0


if __name__ == "__main__":
    sys.exit(_main(sys.argv))
