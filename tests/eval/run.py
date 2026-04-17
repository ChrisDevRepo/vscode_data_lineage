"""
Structural eval runner — THE ONLY entry point for eval-agent execution.

Enforces .claude/rules/eval-validity.md (the Eval Integrity Hard Rule):
the agent receives ZERO behavior instructions from the harness. System
prompt, nav prompt, and tool descriptions come VERBATIM from GET /prompts
(the same surface VS Code's vscode.lm injects into the language model).
The only harness-authored text is transport plumbing (POST URL + payload
shape) and the post-run extraction command.

Workflow per test:
    1. Parse tests/cases/<test-id>.md  →  question + follow-ups + filter (optional)
    2. POST /session                    →  sessionId
    3. POST /filter                     →  if the case has one
    4. GET /prompts?sessionId=<id>      →  system + bb_mode / ct_mode_columns + tool_descriptions
    5. Load agent-prompt.template.txt   →  substitute 7 placeholders
    6. python tests/eval/validate.py    →  fails-closed on any forbidden pattern
    7. Emit the populated prompt        →  so the orchestrator (human or Claude Code)
                                            can hand it to an Agent(model="haiku") spawn
    8. After the agent finishes, the template instructs it to run:
           python tests/eval/extract.py <test-id> <session-id>
       which scores + writes the MD report + snapshot bundle.

Usage:
    python tests/eval/run.py <test-id> [run-id]

If run-id is omitted, uses $EVAL_RUN_ID env var, else a timestamp.

The runner DOES NOT spawn the Agent itself — `Agent(model: "haiku")` lives
in the Claude Code orchestration layer. This script prepares + validates
the populated prompt, then prints the prompt to stdout for the orchestrator
to pick up (and saves it under test-results/eval-runs/<run-id>/<test-id>.prompt.txt
for audit). A future revision can add a --spawn flag if it gains access to
the Agent SDK directly.
"""
from __future__ import annotations

import json
import os
import subprocess
import sys
from datetime import datetime
from pathlib import Path
from urllib.error import URLError
from urllib.request import Request, urlopen

PROXY = "http://127.0.0.1:3271"
PROJECT_ROOT = Path(__file__).resolve().parent.parent.parent
CASES_DIR = PROJECT_ROOT / "tests" / "cases"
EVAL_DIR = PROJECT_ROOT / "tests" / "eval"
RUNS_ROOT = PROJECT_ROOT / "test-results" / "eval-runs"
TEMPLATE_PATH = EVAL_DIR / "agent-prompt.template.txt"
VALIDATE_PY = EVAL_DIR / "validate.py"


# ---------------------------------------------------------------------------
# Test-case parsing — ONLY the user-question and follow-ups are used.
# Expected Outcome / Required / Forbidden sections are extract.py's concern.
# ---------------------------------------------------------------------------


def parse_case(test_id: str) -> dict:
    path = CASES_DIR / f"{test_id}.md"
    if not path.exists():
        raise FileNotFoundError(f"Test case not found: {path}")
    text = path.read_text(encoding="utf-8", errors="replace")
    question = ""
    followups: list[str] = []
    filter_schemas: list[str] = []
    filter_types: list[str] = []
    use_columns = False
    saw_main_question = False
    in_filter = False
    in_classification = False
    for line in text.split("\n"):
        stripped = line.strip()
        if stripped.startswith("## "):
            section = stripped[3:].strip().lower()
            in_filter = "filter" in section
            in_classification = "classification" in section
            continue
        if stripped.startswith("> "):
            body = stripped[2:].strip()
            if body.lower().startswith("question:"):
                question = body.split(":", 1)[1].strip()
                saw_main_question = True
            elif body.lower().startswith("follow-up"):
                followups.append(body.split(":", 1)[1].strip() if ":" in body else body)
            elif not saw_main_question and not question:
                question = body
                saw_main_question = True
        if in_filter and stripped.startswith("- schemas:"):
            val = stripped.split(":", 1)[1].strip()
            filter_schemas = [s.strip() for s in val.strip("[]").split(",") if s.strip()]
        if in_filter and stripped.startswith("- types:"):
            val = stripped.split(":", 1)[1].strip()
            filter_types = [s.strip() for s in val.strip("[]").split(",") if s.strip()]
        if in_classification and "column" in stripped.lower() and "trace" in stripped.lower():
            use_columns = True
    if test_id.startswith("ct-"):
        use_columns = True
    return {
        "question": question,
        "followups": followups,
        "filter_schemas": filter_schemas,
        "filter_types": filter_types,
        "use_columns": use_columns,
    }


# ---------------------------------------------------------------------------
# Proxy HTTP helpers — urllib, no external deps.
# ---------------------------------------------------------------------------


def http(method: str, path: str, body: dict | None = None, timeout: int = 15) -> dict:
    url = f"{PROXY}{path}"
    data = json.dumps(body).encode("utf-8") if body is not None else None
    headers = {"Content-Type": "application/json"} if body is not None else {}
    req = Request(url, data=data, method=method, headers=headers)
    with urlopen(req, timeout=timeout) as r:
        raw = r.read().decode("utf-8", errors="replace")
        return json.loads(raw) if raw else {}


def proxy_up() -> bool:
    try:
        http("GET", "/health", timeout=3)
        return True
    except (URLError, OSError, ValueError):
        return False


# ---------------------------------------------------------------------------
# Template substitution + validation
# ---------------------------------------------------------------------------


def build_prompt(template: str, mapping: dict[str, str]) -> str:
    out = template
    for key, val in mapping.items():
        out = out.replace("{{" + key + "}}", val)
    return out


def validate_template() -> None:
    """Lint agent-prompt.template.txt for harness contamination.

    The validator strips {{PLACEHOLDER}} tokens before scanning, so it sees
    only the harness-authored text (the 4 transport / extraction / User: /
    blank lines). Production content injected via /prompts is trusted and
    is never scanned — it lives inside the placeholders.
    """
    result = subprocess.run(
        [sys.executable, str(VALIDATE_PY), str(TEMPLATE_PATH)],
        capture_output=True,
        text=True,
        cwd=PROJECT_ROOT,
    )
    if result.returncode != 0:
        sys.stderr.write(result.stderr)
        sys.stderr.write(result.stdout)
        raise SystemExit(
            "run.py: validate.py rejected the TEMPLATE. Harness has been "
            "contaminated with behavior scaffolding. Restore the canonical "
            "template from .claude/rules/eval-validity.md."
        )


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------


def main() -> int:
    if len(sys.argv) < 2:
        print("Usage: python tests/eval/run.py <test-id> [run-id]", file=sys.stderr)
        return 2
    test_id = sys.argv[1]
    run_id = sys.argv[2] if len(sys.argv) > 2 else os.environ.get(
        "EVAL_RUN_ID", datetime.now().strftime("run-%Y-%m-%dT%H-%M")
    )

    if not proxy_up():
        print("run.py: proxy not reachable on http://127.0.0.1:3271", file=sys.stderr)
        print("Start it with: npm run test:eval (or the EVAL_WAIT incantation in SKILL.md)", file=sys.stderr)
        return 3

    case = parse_case(test_id)
    if not case["question"]:
        print(f"run.py: no '> Question:' line in tests/cases/{test_id}.md", file=sys.stderr)
        return 4

    # Create run dir
    run_dir = RUNS_ROOT / run_id
    run_dir.mkdir(parents=True, exist_ok=True)

    # 1) POST /session
    sess = http("POST", "/session", body={})
    session_id = sess.get("sessionId")
    if not session_id:
        print(f"run.py: POST /session returned no sessionId: {sess}", file=sys.stderr)
        return 5
    print(f"[run] {test_id}  session={session_id}  run_id={run_id}")

    # 2) POST /filter (optional)
    if case["filter_schemas"] or case["filter_types"]:
        filt = {}
        if case["filter_schemas"]:
            filt["schemas"] = case["filter_schemas"]
        if case["filter_types"]:
            filt["types"] = case["filter_types"]
        filt["sessionId"] = session_id
        http("POST", "/filter", body=filt)
        print(f"[run] filter applied: {filt}")

    # 3) GET /prompts?sessionId=
    prompts = http("GET", f"/prompts?sessionId={session_id}")
    system_prompt = prompts.get("system", "")
    nav_key = "ct_mode_columns" if case["use_columns"] else "bb_mode"
    nav_prompt = prompts.get(nav_key, "")
    tool_descs = prompts.get("tool_descriptions", "")
    if not system_prompt or not nav_prompt or not tool_descs:
        print(
            f"run.py: /prompts missing fields — system={bool(system_prompt)} "
            f"{nav_key}={bool(nav_prompt)} tool_descriptions={bool(tool_descs)}",
            file=sys.stderr,
        )
        return 6

    # If tool_descriptions is structured (dict/list), serialize it here.
    # Keep whatever the proxy returns — this is production-identical.
    if isinstance(tool_descs, (dict, list)):
        tool_descs = json.dumps(tool_descs, indent=2, ensure_ascii=False)

    # 4) Load template + substitute
    template = TEMPLATE_PATH.read_text(encoding="utf-8")
    followups_block = (
        "\n".join(f"Then the user asks: {q}" for q in case["followups"])
        if case["followups"]
        else ""
    )
    populated = build_prompt(
        template,
        {
            "SYSTEM_PROMPT": system_prompt,
            "NAV_PROMPT": nav_prompt,
            "TOOL_DESCRIPTIONS": tool_descs,
            "SESSION_ID": session_id,
            "QUESTION": case["question"],
            "FOLLOWUPS": followups_block,
            "TEST_ID": test_id,
        },
    )
    prompt_path = run_dir / f"{test_id}.prompt.txt"
    prompt_path.write_text(populated, encoding="utf-8")

    # 5) Validate the TEMPLATE (the only harness-controlled surface)
    validate_template()
    print(f"[run] template validated; populated prompt at {prompt_path.relative_to(PROJECT_ROOT)}")

    # 6) Record session metadata for extract.py
    meta = {
        "test_id": test_id,
        "session_id": session_id,
        "run_id": run_id,
        "started_at": datetime.now().isoformat(),
        "nav_mode": nav_key,
        "filter_schemas": case["filter_schemas"],
        "filter_types": case["filter_types"],
        "question": case["question"],
        "followup_count": len(case["followups"]),
    }
    (run_dir / f"{test_id}.agent.json").write_text(
        json.dumps(meta, indent=2, ensure_ascii=False), encoding="utf-8"
    )

    # 7) The orchestrator (Claude Code or human) reads the saved prompt file
    # and hands it to Agent(model: "haiku"). Avoid printing the populated
    # prompt to stdout (Unicode characters break on Windows cp1252 locales
    # and the full text would flood the terminal anyway).
    print(f"[run] populated prompt saved ({len(populated)} chars)")
    print(f"[run] -> read from: {prompt_path.relative_to(PROJECT_ROOT)}")
    print(f"[run] -> session_id: {session_id}")
    print(f"[run] -> run_id:     {run_id}")
    print(f"[run] -> feed to:    Agent(model: 'haiku', subagent_type: 'general-purpose')")
    print(
        f"[run] -> after Agent completes, verify report at: "
        f"{(run_dir / f'{test_id}.md').relative_to(PROJECT_ROOT)}"
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
