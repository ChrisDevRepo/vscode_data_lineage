"""F-GATE-01: start_exploration on a wide scope must emit confirm_sm_start.

Verifies the gate envelope is structurally correct (action_required + gate
field) and the SM transitions to awaiting_gate.
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
    })
    result = out.get("result") or {}
    r.assert_eq("response is action_required", result.get("error"), "action_required")
    r.assert_eq("gate kind = confirm_sm_start", result.get("gate"), "confirm_sm_start")
    r.assert_truthy("gate carries detail markdown", result.get("detail"))
    state = get_state(sid)
    r.assert_eq("phase = awaiting_gate", state.get("session_phase"), "awaiting_gate")


if __name__ == "__main__":
    import sys
    sys.exit(run_test(__file__, t))
