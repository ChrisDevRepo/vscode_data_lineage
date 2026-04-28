"""Archive a single eval-case run into a per-iteration subfolder.

Usage:
    python tests/eval/archive_run.py <case-id> [--iter-id <id>] [--note "<text>"]

If --iter-id is omitted, derives one from the current branch + commit + timestamp.

Layout produced:

    test-results/eval-runs/<iter-id>/<case-id>/
        report.md              ← copied from test-results/eval-bridge/<case>.report.md
        prompts.md             ← extracted from the latest synthesis req payload
        snapshot.json          ← copied autonomous-snapshot.json
        synthesis-payload.json ← latest synthesis req payload (if found)
        synthesis-response.json ← latest synthesis resp (if found in handshake)
        depth-signals.json     ← measured signal counts
        orch.log               ← copied /tmp/orch-<case>.log
        eval.log               ← copied /tmp/eval-<case>.log
        bridge.jsonl           ← copied test-results/eval-bridge/haiku-server.log.jsonl tail
        meta.json              ← branch, commit, time, env, classification, mode

    test-results/eval-runs/<iter-id>/INDEX.md  ← updated with case row

Run this AFTER `report.py` for a case to capture everything in one folder.
"""
from __future__ import annotations

import argparse
import json
import os
import re
import shutil
import subprocess
import sys
from datetime import datetime
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent.parent
EVAL_BRIDGE = ROOT / "test-results" / "eval-bridge"
EVAL_RUNS = ROOT / "test-results" / "eval-runs"
HANDSHAKE = EVAL_BRIDGE / "handshake"


def _git(args: list[str]) -> str:
    try:
        return subprocess.check_output(["git", "-C", str(ROOT), *args], text=True, encoding="utf-8").strip()
    except Exception:
        return ""


def _derive_iter_id() -> str:
    branch = _git(["rev-parse", "--abbrev-ref", "HEAD"]) or "no-branch"
    sha = _git(["rev-parse", "--short", "HEAD"]) or "no-sha"
    ts = datetime.now().strftime("%Y%m%d-%H%M")
    return f"{branch}-{sha}-{ts}".replace("/", "-")


def _find_latest(glob: str, src: Path) -> Path | None:
    if not src.exists():
        return None
    files = sorted(src.glob(glob), key=lambda p: p.stat().st_mtime, reverse=True)
    return files[0] if files else None


def _copy_if_exists(src: Path | None, dst: Path) -> bool:
    if src and src.exists():
        shutil.copy2(src, dst)
        return True
    return False


def _measure_depth(snapshot: dict) -> dict:
    """Return depth-signal counts from snapshot's resultGraph."""
    def walk(o, depth=0):
        if depth > 8:
            return None
        if isinstance(o, dict):
            if "sections" in o and "description" in o:
                return o
            for v in o.values():
                r = walk(v, depth + 1)
                if r:
                    return r
        elif isinstance(o, list):
            for v in o:
                r = walk(v, depth + 1)
                if r:
                    return r
        return None

    rg = walk(snapshot) or {}
    desc = rg.get("description", "") or ""
    sections = rg.get("sections", []) or []
    return {
        "description_chars": len(desc),
        "sections_count": len(sections),
        "intro_chars": len(rg.get("intro", "") or ""),
        "closing_chars": len(rg.get("closing", "") or ""),
        "summary_chars": len(rg.get("summary", "") or ""),
        "title_chars": len(rg.get("title", "") or ""),
        "warning_count": desc.count("⚠️"),
        "pipe_table_separators": desc.count("---|"),
        "pipe_rows": len(re.findall(r"^\|.*\|$", desc, re.MULTILINE)),
        "sql_fences": desc.count("```sql"),
        "latex_inline": len(re.findall(r"\$[^$]+\$", desc)),
        "numbered_lines": len(re.findall(r"^\d+\. ", desc, re.MULTILINE)),
        "section_bodies": [
            {
                "label": s.get("label", ""),
                "chars": len(s.get("text", "") or ""),
                "warnings": (s.get("text", "") or "").count("⚠️"),
                "node_ids": len(s.get("node_ids") or []),
            }
            for s in sections
        ],
    }


def _extract_prompts_md(payload: dict, case_id: str) -> str:
    """Extract the system prompt + tool descriptions into a readable markdown."""
    msgs = payload.get("messages", []) or []
    sys_text = ""
    if msgs and msgs[0].get("role") == "user":
        for c in msgs[0].get("content", []) or []:
            if isinstance(c, dict) and c.get("type") == "text":
                sys_text = c.get("text", "")
                break

    tools = payload.get("tools", []) or []

    md = [
        f"# Prompts at synthesis time — {case_id}",
        "",
        "_Extracted from the synthesis-phase request payload (the system prompt + tool catalogue the model saw at the moment it produced `present_result`)._",
        "",
        f"Generated: {datetime.now().isoformat(timespec='seconds')}",
        "",
        "---",
        "",
        f"## System Prompt ({len(sys_text)} chars)",
        "",
        "```markdown",
        sys_text,
        "```",
        "",
        f"## Tool Catalogue ({len(tools)} tools)",
        "",
    ]
    for t in tools:
        name = t.get("name", "?")
        desc = t.get("description", "") or ""
        md.append(f"### `{name}`")
        md.append("")
        md.append(desc)
        md.append("")
    return "\n".join(md)


def _build_meta(case_id: str, iter_id: str, note: str) -> dict:
    return {
        "case_id": case_id,
        "iter_id": iter_id,
        "branch": _git(["rev-parse", "--abbrev-ref", "HEAD"]),
        "commit": _git(["rev-parse", "HEAD"]),
        "commit_short": _git(["rev-parse", "--short", "HEAD"]),
        "commit_subject": _git(["log", "-1", "--pretty=%s"]),
        "uncommitted_changes": _git(["status", "--porcelain"]) != "",
        "captured_at": datetime.now().isoformat(timespec="seconds"),
        "env_eval_real_haiku_synthesis": os.environ.get("ORCH_DEFER_SYNTHESIS", "0") == "1",
        "note": note,
    }


def _update_index(iter_dir: Path, case_id: str, depth: dict, meta: dict) -> None:
    idx = iter_dir / "INDEX.md"
    header = (
        f"# Eval iteration `{iter_dir.name}`\n\n"
        f"Branch: `{meta['branch']}` · commit `{meta['commit_short']}` · captured {meta['captured_at']}\n\n"
        f"## Cases\n\n"
        "| Case | Sections | Desc chars | ⚠️ | Tables | LaTeX | SQL fences |\n"
        "|---|---|---|---|---|---|---|\n"
    )
    row = (
        f"| `{case_id}` | {depth['sections_count']} | {depth['description_chars']} | "
        f"{depth['warning_count']} | {depth['pipe_table_separators']} | "
        f"{depth['latex_inline']} | {depth['sql_fences']} |\n"
    )
    if not idx.exists():
        idx.write_text(header + row, encoding="utf-8")
    else:
        existing = idx.read_text(encoding="utf-8")
        if f"| `{case_id}` |" in existing:
            existing = re.sub(rf"^\| `{re.escape(case_id)}` \|.*$", row.rstrip(), existing, count=1, flags=re.MULTILINE)
        else:
            existing = existing.rstrip() + "\n" + row
        idx.write_text(existing, encoding="utf-8")


def archive(case_id: str, iter_id: str, note: str = "") -> Path:
    iter_dir = EVAL_RUNS / iter_id
    case_dir = iter_dir / case_id
    case_dir.mkdir(parents=True, exist_ok=True)

    # 1. Copy report
    report_src = EVAL_BRIDGE / f"{case_id}.report.md"
    _copy_if_exists(report_src, case_dir / "report.md")

    # 2. Copy snapshot
    snap_src = EVAL_BRIDGE / "autonomous-snapshot.json"
    _copy_if_exists(snap_src, case_dir / "snapshot.json")

    # 3. Find + copy synthesis payload + response (if user persisted them under tmp/)
    for synth_payload in (ROOT / "tmp").glob(f"synth-*-payload.json"):
        # heuristic: most recent one matches this case
        if synth_payload.stat().st_mtime > snap_src.stat().st_mtime - 600 if snap_src.exists() else True:
            shutil.copy2(synth_payload, case_dir / "synthesis-payload.json")
            break

    # 4. Look for the most recent resp- file in handshake (or already deleted — try tmp)
    resp = _find_latest("resp-*.json", HANDSHAKE)
    if resp:
        _copy_if_exists(resp, case_dir / "synthesis-response.json")

    # 5. Logs
    _copy_if_exists(Path(f"/tmp/orch-{case_id}.log"), case_dir / "orch.log")
    _copy_if_exists(Path(f"/tmp/eval-{case_id}.log"), case_dir / "eval.log")

    # 6. Bridge JSONL tail (last ~500 lines)
    bridge_log = EVAL_BRIDGE / "haiku-server.log.jsonl"
    if bridge_log.exists():
        tail_lines = bridge_log.read_text(encoding="utf-8", errors="replace").splitlines()[-500:]
        (case_dir / "bridge.jsonl").write_text("\n".join(tail_lines), encoding="utf-8")

    # 7. Depth signals
    depth: dict = {}
    if (case_dir / "snapshot.json").exists():
        snap = json.loads((case_dir / "snapshot.json").read_text(encoding="utf-8"))
        depth = _measure_depth(snap)
        (case_dir / "depth-signals.json").write_text(json.dumps(depth, indent=2), encoding="utf-8")

    # 8. Prompts.md (from synthesis payload if available)
    payload_path = case_dir / "synthesis-payload.json"
    if payload_path.exists():
        payload = json.loads(payload_path.read_text(encoding="utf-8"))
        (case_dir / "prompts.md").write_text(_extract_prompts_md(payload, case_id), encoding="utf-8")

    # 9. Meta
    meta = _build_meta(case_id, iter_id, note)
    (case_dir / "meta.json").write_text(json.dumps(meta, indent=2), encoding="utf-8")

    # 10. Update INDEX.md
    if depth:
        _update_index(iter_dir, case_id, depth, meta)

    return case_dir


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("case_id")
    ap.add_argument("--iter-id", default=None, help="Iteration id (default: derived from branch+sha+ts)")
    ap.add_argument("--note", default="", help="Free-form annotation written to meta.json")
    args = ap.parse_args()

    iter_id = args.iter_id or _derive_iter_id()
    case_dir = archive(args.case_id, iter_id, args.note)
    print(f"[archive] {case_dir}")
    print(f"[archive] iter-id: {iter_id}")
    print(f"[archive] index:  {EVAL_RUNS / iter_id / 'INDEX.md'}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
