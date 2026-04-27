"""Track-B feature E2E — shared helpers.

Track B is the deterministic, no-LLM half of the eval-loop. Each test:
  1. POST /session                          (or reuses an existing session)
  2. POST /filter (optional)
  3. POST /tool with a *fixed* input        (no Haiku decision)
  4. Assert on response shape, scope, phase, gate envelope
  5. Optionally POST /gate {approved}
  6. Assert phase transition

Each test is a single Python script. The runner (`run_all.py`) iterates them,
captures pass/fail per assertion, writes one .json per test under
test-results/feature-runs/<run-id>/, and a summary.json + index entries
into test-results/eval-runs/eval-runs-index.json (track="track_b").

Hard rules:
- Sequential only — AiSession is a singleton in the extension host.
- No LLM coaching anywhere. These tests are pure protocol verification.
"""
from __future__ import annotations

import json
import os
import sys
import time
from datetime import datetime
from pathlib import Path
from urllib.error import URLError, HTTPError
from urllib.request import Request, urlopen

PROXY = "http://127.0.0.1:3271"
PROJECT_ROOT = Path(__file__).resolve().parent.parent.parent.parent


# ---------------------------------------------------------------------------
# HTTP — urllib only, no external deps.
# ---------------------------------------------------------------------------

def _request(method: str, path: str, body: dict | None = None, timeout: int = 10) -> tuple[int, dict]:
    url = f"{PROXY}{path}"
    data = json.dumps(body).encode("utf-8") if body is not None else None
    headers = {"Content-Type": "application/json"} if body is not None else {}
    req = Request(url, data=data, method=method, headers=headers)
    try:
        with urlopen(req, timeout=timeout) as r:
            raw = r.read().decode("utf-8", errors="replace")
            return r.status, (json.loads(raw) if raw else {})
    except HTTPError as e:
        # 4xx/5xx still carry a JSON body in our proxy
        raw = e.read().decode("utf-8", errors="replace") if hasattr(e, "read") else ""
        try:
            return e.code, json.loads(raw)
        except json.JSONDecodeError:
            return e.code, {"_raw": raw}


def health() -> dict:
    _, j = _request("GET", "/health")
    return j


def session() -> str:
    """POST /session — reset and return new session id."""
    status, j = _request("POST", "/session", {})
    if status not in (200, 201) or not j.get("sessionId"):
        raise RuntimeError(f"POST /session failed: status={status} body={j}")
    return j["sessionId"]


def post_filter(sid: str, schemas: list[str] | None = None, types: list[str] | None = None) -> dict:
    body = {"sessionId": sid}
    if schemas is not None:
        body["schemas"] = schemas
    if types is not None:
        body["types"] = types
    _, j = _request("POST", "/filter", body)
    return j


def post_tool(sid: str, tool: str, input_payload: dict) -> dict:
    """POST /tool — returns the result envelope (.result + ._meta)."""
    _, j = _request("POST", "/tool", {"tool": tool, "input": input_payload, "sessionId": sid})
    return j


def post_gate(sid: str, approved: bool) -> dict:
    _, j = _request("POST", "/gate", {"sessionId": sid, "approved": approved})
    return j


def get_state(sid: str) -> dict:
    _, j = _request("GET", f"/session/{sid}/state")
    return j


def get_gates(sid: str) -> list[dict]:
    _, j = _request("GET", f"/session/{sid}/gates")
    if isinstance(j, dict) and isinstance(j.get("gates"), list):
        return j["gates"]
    return []


def get_prompts(sid: str | None = None) -> dict:
    suffix = f"?sessionId={sid}" if sid else ""
    _, j = _request("GET", f"/prompts{suffix}")
    return j


# ---------------------------------------------------------------------------
# Assertions — collect into a per-test list, fail fast.
# ---------------------------------------------------------------------------

class TestResult:
    def __init__(self, test_id: str):
        self.test_id = test_id
        self.assertions: list[dict] = []
        self.session_id: str | None = None

    def assert_eq(self, label: str, actual, expected) -> None:
        ok = actual == expected
        self.assertions.append({"label": label, "ok": ok, "expected": expected, "actual": actual})
        if not ok:
            raise AssertionError(f"{label}: expected {expected!r}, got {actual!r}")

    def assert_in(self, label: str, needle, haystack) -> None:
        ok = needle in haystack
        self.assertions.append({"label": label, "ok": ok, "needle": needle, "haystack_preview": str(haystack)[:200]})
        if not ok:
            raise AssertionError(f"{label}: {needle!r} not in {str(haystack)[:200]}")

    def assert_truthy(self, label: str, value) -> None:
        ok = bool(value)
        self.assertions.append({"label": label, "ok": ok, "value_preview": str(value)[:200]})
        if not ok:
            raise AssertionError(f"{label}: value is falsy ({value!r})")

    def to_dict(self, status: str, error: str | None = None) -> dict:
        return {
            "test_id": self.test_id,
            "session_id": self.session_id,
            "status": status,
            "error": error,
            "ts": datetime.now().isoformat(),
            "assertions": self.assertions,
        }


def write_result(test_file: str, result: TestResult, status: str, error: str | None = None) -> None:
    """Write per-test JSON under test-results/feature-runs/<run-id>/."""
    test_id = Path(test_file).stem
    run_id = os.environ.get("EVAL_RUN_ID") or f"feat-{datetime.now().strftime('%Y-%m-%dT%H-%M')}"
    out_dir = PROJECT_ROOT / "test-results" / "feature-runs" / run_id
    out_dir.mkdir(parents=True, exist_ok=True)
    payload = result.to_dict(status=status, error=error)
    payload["test_id"] = test_id  # canonical from filename
    (out_dir / f"{test_id}.json").write_text(json.dumps(payload, indent=2, ensure_ascii=False), encoding="utf-8")
    print(f"[feat] {test_id}: {status}" + (f" — {error}" if error else ""))


def run_test(test_file: str, fn) -> int:
    """Top-level wrapper: catch AssertionError + Exception, write result, return exit code."""
    test_id = Path(test_file).stem
    result = TestResult(test_id)
    try:
        fn(result)
    except AssertionError as e:
        write_result(test_file, result, status="FAIL", error=str(e))
        return 1
    except Exception as e:
        write_result(test_file, result, status="ERROR", error=f"{type(e).__name__}: {e}")
        return 2
    write_result(test_file, result, status="PASS")
    return 0


# ---------------------------------------------------------------------------
# Convenience: well-known node IDs in tests/fixtures/AdventureWorks2025_AI.dacpac
# ---------------------------------------------------------------------------

KNOWN_NODES = {
    "employee_table": "[humanresources].[employee]",
    "vproduct": "[production].[vproductanddescription]",
    "vemployee": "[humanresources].[vemployee]",
    "factreport": "[ai].[factsalesreport]",
    "errorlog": "[dbo].[errorlog]",
    "usp_update_emp": "[humanresources].[uspupdateemployeehireinfo]",
}
