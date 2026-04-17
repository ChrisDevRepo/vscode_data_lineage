"""
Forbidden-token lint for the populated eval-agent prompt.

Enforces .claude/rules/eval-validity.md: the harness must inject only
production prompts (system + nav + tool_descriptions) plus transport plumbing.
Any behavior scaffolding, structural template, density target, terminology
hint, error-recovery coaching, or framing preamble added BY THE HARNESS is
a contamination event (L003) that invalidates the run.

Usage:
    python tests/eval/validate.py <path-to-populated-prompt.txt>

Exits non-zero on any forbidden substring match. Called by tests/eval/run.py
before spawning the agent; fails-closed.

To add a pattern: append one line to FORBIDDEN_SUBSTRINGS with a short
provenance comment (L-id from knowledge.json).
"""
import sys
from pathlib import Path

# Seeded from L003 harness-contamination patterns + .claude/rules/eval-validity.md.
# Case-insensitive substring match on the populated agent prompt.
FORBIDDEN_SUBSTRINGS = [
    # Behavior coaching (L003)
    "call submit_findings repeatedly",
    "keep calling submit_findings",
    "never set complete:true",
    "never set complete: true",
    "call start_exploration once",
    "do not retry",
    "fix only those fields",
    "read errors[]",
    "read the errors array",
    # Structural templates / density targets (L003)
    "5-block",
    "200-400 char",
    ">= 400 char",
    ">=400 char",
    "density target",
    "target length",
    "business purpose / transforms",
    "business purpose | transforms",
    # Terminology coaching (harness-side)
    "use source/target",
    "use source and target",
    "avoid writer/reader",
    "prefer source/target",
    # Framing preamble (harness-side role statement)
    "you are a language model",
    "you are an ai assistant",
    "you are an autonomous ai",
    "act as an ai",
    # Inline JSON schema / agent self-serialization hints
    '"type": "object"',
    '"properties":',
    '"required": [',
    # Meta-coaching about the eval itself
    "this is an eval",
    "this is a test",
    "score well",
    "rubric",
]


def lint(text: str) -> list[tuple[str, int]]:
    """Return list of (matched_substring, line_number_1indexed)."""
    lower = text.lower()
    hits: list[tuple[str, int]] = []
    for needle in FORBIDDEN_SUBSTRINGS:
        idx = lower.find(needle.lower())
        if idx >= 0:
            line_no = text.count("\n", 0, idx) + 1
            hits.append((needle, line_no))
    return hits


def main() -> int:
    if len(sys.argv) < 2:
        print("Usage: python tests/eval/validate.py <populated-prompt-file>", file=sys.stderr)
        return 2
    path = Path(sys.argv[1])
    if not path.exists():
        print(f"validate: file not found: {path}", file=sys.stderr)
        return 2
    text = path.read_text(encoding="utf-8", errors="replace")
    hits = lint(text)
    if hits:
        print(f"validate: FAIL — {len(hits)} forbidden pattern(s) in {path}", file=sys.stderr)
        for needle, line_no in hits:
            print(f"  line {line_no}: {needle!r}", file=sys.stderr)
        print("", file=sys.stderr)
        print("Harness contamination detected. See .claude/rules/eval-validity.md.", file=sys.stderr)
        print("Fix the template (tests/eval/agent-prompt.template.txt) or the", file=sys.stderr)
        print("prompts returned by GET /prompts — NOT the blocklist.", file=sys.stderr)
        return 1
    print(f"validate: OK — {path} clean ({len(FORBIDDEN_SUBSTRINGS)} patterns checked)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
