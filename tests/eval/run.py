"""Eval orchestrator — bridge architecture.

The bridge (`src/ai/evalLmProvider.ts`) registers a `LanguageModelChatProvider`
that forwards `messages[]` from the production `@lineage` participant to a
configurable Haiku endpoint. This script is the thin orchestrator that drives
one case end-to-end.

Workflow per case:
  1. Read the case's question + optional pre-flight context from
     `tests/cases/<case-id>.md`.
  2. Set env vars EVAL_BRIDGE_HAIKU_URL + EVAL_AUTONOMOUS_QUESTION.
  3. Invoke `npm run test:eval` — the autonomous mocha test inside the
     extension host calls `LineageParticipant.handleChatRequest` with a
     synthetic ChatRequest pointing at the bridge model.
  4. (Handshake mode only) The orchestrator polls the handshake dir,
     dispatches a Haiku Task per pending request, writes the response.
     This part is interactive and must be driven from the Claude Code
     session that owns this run.
  5. After the conversation completes, extract.py reads
     `test-results/eval-bridge/autonomous-snapshot.json` + the bridge JSONL
     and produces the per-case report.

Run:
  python tests/eval/run.py <case-id>           # handshake mode, manual orchestration
  ANTHROPIC_API_KEY=... python tests/eval/run.py <case-id>   # direct mode, fully autonomous

Env override:
  EVAL_BRIDGE_PORT     — default 4271
  EVAL_BRIDGE_LOG_PATH — JSONL path for the bridge log
"""
import os
import re
import subprocess
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent.parent
CASES_DIR = ROOT / "tests" / "cases"
EVAL_BRIDGE_PORT = int(os.environ.get("EVAL_BRIDGE_PORT", "4271"))
EVAL_BRIDGE_HAIKU_URL = f"http://127.0.0.1:{EVAL_BRIDGE_PORT}"


def _load_question(case_id: str) -> str:
    path = CASES_DIR / f"{case_id}.md"
    if not path.exists():
        raise SystemExit(f"case file not found: {path}")
    text = path.read_text(encoding="utf-8")
    # Question is the first blockquote under "## Question".
    m = re.search(r"^##\s+Question\s*\n+>\s*(.+?)(?=\n##|\Z)", text, flags=re.MULTILINE | re.DOTALL)
    if not m:
        raise SystemExit(f"no '## Question' blockquote in {path}")
    return " ".join(line.strip().lstrip(">").strip() for line in m.group(1).splitlines() if line.strip())


def _ensure_haiku_server_running() -> None:
    """Probe :EVAL_BRIDGE_PORT — if not listening, instruct user to start it."""
    import urllib.request
    try:
        urllib.request.urlopen(f"{EVAL_BRIDGE_HAIKU_URL}/", timeout=1)
    except Exception:
        # Not strictly an error — the server may simply not respond to GET.
        # Just log a hint; the actual POST in the test will fail clearly if down.
        print(f"[run] Note: probe of {EVAL_BRIDGE_HAIKU_URL} returned no response.", file=sys.stderr)
        print(f"[run] If the bridge test fails with ECONNREFUSED, start the haiku-server first:", file=sys.stderr)
        print(f"[run]   python tests/eval/haiku-server.py {EVAL_BRIDGE_PORT}", file=sys.stderr)


def main():
    if len(sys.argv) < 2:
        raise SystemExit("usage: run.py <case-id>")
    case_id = sys.argv[1]
    question = _load_question(case_id)
    print(f"[run] case: {case_id}")
    print(f"[run] question: {question}")
    _ensure_haiku_server_running()

    env = os.environ.copy()
    env["EVAL_BRIDGE_HAIKU_URL"] = EVAL_BRIDGE_HAIKU_URL
    env["EVAL_AUTONOMOUS_QUESTION"] = question
    if "ANTHROPIC_API_KEY" in env:
        print("[run] mode: DIRECT (haiku-server.py will call Anthropic API)")
    else:
        print("[run] mode: HANDSHAKE (orchestrator must dispatch Haiku Tasks per pending req-*.json)")
        print(f"[run] watch: {ROOT}/test-results/eval-bridge/handshake/")

    start = time.time()
    try:
        subprocess.run(["npm", "run", "test:eval"], cwd=str(ROOT), env=env, check=False, shell=True)
    except KeyboardInterrupt:
        print("[run] interrupted by user", file=sys.stderr)

    duration = time.time() - start
    snapshot = ROOT / "test-results" / "eval-bridge" / "autonomous-snapshot.json"
    print(f"[run] duration: {duration:.1f}s")
    if snapshot.exists():
        print(f"[run] snapshot: {snapshot}")
        print(f"[run] next: python tests/eval/extract.py {case_id} <session-id-from-snapshot>")
    else:
        print(f"[run] snapshot NOT FOUND — run did not complete")


if __name__ == "__main__":
    main()
