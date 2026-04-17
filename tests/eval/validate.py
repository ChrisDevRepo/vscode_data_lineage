"""
Forbidden-token lint for the eval-agent TEMPLATE.

Enforces .claude/rules/eval-validity.md: the harness must inject only
production prompts (system + nav + tool_descriptions) plus transport
plumbing. Any behavior scaffolding, structural template, density target,
terminology hint, error-recovery coaching, or framing preamble added BY
THE HARNESS is a contamination event (L003) that invalidates the run.

Invariant being enforced: agent-prompt.template.txt contains only the
4 transport/extraction/user-label lines and the 7 placeholders. Any
other content is harness contamination.

IMPORTANT: This validator lints the TEMPLATE (pre-substitution), not the
populated prompt. The populated prompt embeds production content from
GET /prompts verbatim — legitimately-overlapping strings there (e.g.
"5-block" if the production nav prompt mentions it) are NOT contamination,
they are production choices. Linting the populated prompt would false-
positive on every such overlap.

Usage:
    python tests/eval/validate.py <path-to-template-or-populated>

Exits non-zero on any forbidden substring match outside of placeholder
tokens. Called by tests/eval/run.py before substitution; fails-closed.

To add a pattern: append one line to FORBIDDEN_SUBSTRINGS with a short
provenance comment (L-id from knowledge.json).
"""
import re
import sys
from pathlib import Path

# Patterns the HARNESS might add but production prompts never would.
# Case-insensitive. Exclusively targets harness-authored scaffolding.
# Production-side coaching (5-block structure, >=400 char density target,
# continuation contract, etc.) lives in src/ai/smPrompts.ts and is
# delivered to the LM by real VS Code chat too — that's NOT contamination.
FORBIDDEN_SUBSTRINGS = [
    # Framing preamble — production system prompt provides the role; the
    # harness must not prepend its own "You are..." preamble.
    "you are a language model",
    "you are an ai assistant",
    "you are an autonomous ai",
    "act as an ai",
    "your task is to",
    # Meta-coaching about the eval itself — production prompts never
    # mention that the model is being tested.
    "this is an eval",
    "this is a test",
    "score well",
    "scoring rubric",
    "being evaluated",
    "we are testing",
    # Corrected-example injection — harness must not paraphrase or "fix"
    # production tool-description examples.
    "correct example:",
    "fixed example:",
    "improved example:",
    # Retry / error-recovery coaching the harness adds on top of production.
    "if success:false",
    "on tool error",
    "fix only those fields",
    "do not retry the same call",
    # Agent self-serialization hints — extract.py reads the SM state;
    # the agent is not asked to emit JSON for scoring.
    "emit a json",
    "return json with fields",
    "write a json file",
]


PLACEHOLDER_RE = re.compile(r"\{\{[A-Z_]+\}\}")


def lint(text: str) -> list[tuple[str, int]]:
    """Return list of (matched_substring, line_number_1indexed).

    Placeholders like {{SYSTEM_PROMPT}} are replaced with an empty string
    before matching so that substituted content (production-verbatim) isn't
    scanned. When called on a pre-substitution template, the placeholders
    are removed — only harness-authored text remains. When called on a
    populated prompt, we scan the full text: this mode is opt-in via the
    caller, and is primarily useful as a belt-and-braces check when you
    want to catch contamination that somehow landed in /prompts itself.
    """
    scan = PLACEHOLDER_RE.sub("", text)
    lower = scan.lower()
    hits: list[tuple[str, int]] = []
    for needle in FORBIDDEN_SUBSTRINGS:
        idx = lower.find(needle.lower())
        if idx >= 0:
            line_no = scan.count("\n", 0, idx) + 1
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
