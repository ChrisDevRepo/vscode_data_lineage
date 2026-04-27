"""Track-B feature E2E suite — iterate all feat-*.py sequentially.

Sequential is mandatory (AiSession singleton). Each test resets via
POST /session before running. The runner captures pass/fail/error,
writes summary.json and appends to test-results/eval-runs/eval-runs-index.json
(track="track_b").

Usage:
    python tests/e2e/feature/run_all.py [--run-id <id>]

Env: EVAL_RUN_ID overrides --run-id and propagates to per-test scripts.
"""
from __future__ import annotations

import json
import os
import subprocess
import sys
from datetime import datetime
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parent.parent.parent.parent
FEATURE_DIR = Path(__file__).resolve().parent
RUNS_ROOT = PROJECT_ROOT / "test-results" / "eval-runs"
FEAT_RUNS_ROOT = PROJECT_ROOT / "test-results" / "feature-runs"


def _resolve_run_id() -> str:
    if "--run-id" in sys.argv:
        i = sys.argv.index("--run-id")
        if i + 1 < len(sys.argv):
            return sys.argv[i + 1]
    return os.environ.get("EVAL_RUN_ID") or f"feat-{datetime.now().strftime('%Y-%m-%dT%H-%M')}"


def _discover_tests() -> list[Path]:
    return sorted(FEATURE_DIR.glob("feat-*.py"))


def _append_index(run_id: str, payload: dict) -> None:
    """Append one row per feature test to eval-runs-index.json (track=track_b)."""
    idx_path = RUNS_ROOT / "eval-runs-index.json"
    rows: list[dict] = []
    if idx_path.exists():
        try:
            rows = json.loads(idx_path.read_text(encoding="utf-8"))
        except json.JSONDecodeError:
            rows = []
    test_id = payload["test_id"]
    rows = [r for r in rows if not (r.get("run_id") == run_id and r.get("test_id") == test_id and r.get("track") == "track_b")]
    rows.append({
        "run_id": run_id,
        "test_id": test_id,
        "track": "track_b",
        "git_sha": _git_sha(),
        "ts": payload.get("ts"),
        "status": payload.get("status"),
        "error": payload.get("error"),
        "assertion_count": len(payload.get("assertions") or []),
        "assertion_pass": sum(1 for a in (payload.get("assertions") or []) if a.get("ok")),
    })
    idx_path.parent.mkdir(parents=True, exist_ok=True)
    idx_path.write_text(json.dumps(rows, indent=2, ensure_ascii=False), encoding="utf-8")


def _git_sha() -> str:
    try:
        r = subprocess.run(
            ["git", "rev-parse", "--short", "HEAD"],
            capture_output=True, text=True, timeout=5, cwd=str(PROJECT_ROOT),
        )
        if r.returncode == 0:
            return r.stdout.strip()
    except (OSError, subprocess.TimeoutExpired):
        pass
    return ""


def _state_log(line: str) -> None:
    """Best-effort append to test-results/iteration-log.md via state.py."""
    try:
        subprocess.run(
            [sys.executable, str(PROJECT_ROOT / "tests" / "eval" / "state.py"), "log", line],
            capture_output=True, text=True, timeout=5, cwd=str(PROJECT_ROOT),
        )
    except Exception:
        pass


def main() -> int:
    run_id = _resolve_run_id()
    feat_run_dir = FEAT_RUNS_ROOT / run_id
    feat_run_dir.mkdir(parents=True, exist_ok=True)
    print(f"[feat-suite] run_id={run_id}")
    print(f"[feat-suite] artifacts -> {feat_run_dir.relative_to(PROJECT_ROOT)}")

    tests = _discover_tests()
    if not tests:
        print("[feat-suite] no feat-*.py tests found", file=sys.stderr)
        return 1

    summary: dict = {
        "run_id": run_id,
        "git_sha": _git_sha(),
        "ts_start": datetime.now().isoformat(),
        "results": [],
    }

    pass_count = 0
    fail_count = 0
    error_count = 0

    env = os.environ.copy()
    env["EVAL_RUN_ID"] = run_id

    for tpath in tests:
        test_id = tpath.stem
        print(f"[feat-suite] running {test_id} …")
        proc = subprocess.run(
            [sys.executable, str(tpath)],
            capture_output=True, text=True, timeout=60, cwd=str(PROJECT_ROOT), env=env,
        )
        # The test script writes its own JSON via common.write_result.
        result_path = feat_run_dir / f"{test_id}.json"
        if result_path.exists():
            try:
                payload = json.loads(result_path.read_text(encoding="utf-8"))
            except json.JSONDecodeError:
                payload = {"test_id": test_id, "status": "ERROR", "error": "result.json unparseable"}
        else:
            payload = {
                "test_id": test_id,
                "status": "ERROR",
                "error": "no result.json produced (script may have crashed before write)",
                "stderr_tail": (proc.stderr or "")[-400:],
            }
        summary["results"].append(payload)
        _append_index(run_id, payload)

        st = payload.get("status") or "ERROR"
        if st == "PASS":
            pass_count += 1
        elif st == "FAIL":
            fail_count += 1
        else:
            error_count += 1

        _state_log(f"track_b/{test_id}: {st}" + (f" — {payload.get('error')}" if payload.get('error') else ""))

    summary["ts_end"] = datetime.now().isoformat()
    summary["counts"] = {"pass": pass_count, "fail": fail_count, "error": error_count, "total": len(tests)}
    (feat_run_dir / "summary.json").write_text(json.dumps(summary, indent=2, ensure_ascii=False), encoding="utf-8")

    print(f"[feat-suite] {pass_count} pass / {fail_count} fail / {error_count} error / {len(tests)} total")
    return 0 if (fail_count == 0 and error_count == 0) else 1


if __name__ == "__main__":
    sys.exit(main())
