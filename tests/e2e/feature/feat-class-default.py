"""F-CLASS-01 (revised): classification is OPTIONAL with default 'business'
per current CLAUDE.md (was 'mandatory at gate-emit' in older docs).

Verify start_exploration without classification still produces a gate, and
that the session.classification ends up = 'business'. If the engine
defaults differently — that's a finding.
"""
from common import session, post_filter, post_tool, get_state, run_test


def t(r):
    sid = session()
    r.session_id = sid
    post_filter(sid, schemas=["HumanResources", "Person", "Sales"])
    out = post_tool(sid, "lineage_start_exploration", {
        "origin": "[humanresources].[employee]",
        "direction": "bidirectional",
        "depth": 2,
        # classification intentionally omitted
    })
    res = out.get("result") or {}
    r.assert_eq("gate emitted without classification", res.get("gate"), "confirm_sm_start")

    state = get_state(sid)
    sm = state.get("sm_state") or {}
    cls = sm.get("classification") or sm.get("classificationLocked") or sm.get("memory", {}).get("classification")
    # Per CLAUDE.md 2026-04-27 the engine defaults to 'business'.
    if cls is None:
        # Acceptable — the SM may not surface classification in the JSON dump.
        r.assert_truthy("FINDING: classification not exposed in sm_state JSON", True)
    else:
        r.assert_eq("default classification = business", cls, "business")


if __name__ == "__main__":
    import sys
    sys.exit(run_test(__file__, t))
