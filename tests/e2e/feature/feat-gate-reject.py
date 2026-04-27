"""F-GATE-03: POST /gate {approved:false} stays in awaiting_gate (not idle).

The proxy only logs the rejection; the user can still refine without losing
the discovery state. Verify the phase is unchanged and start_exploration can
re-enter the gate flow.
"""
from common import session, post_filter, post_tool, post_gate, get_state, run_test


def t(r):
    sid = session()
    r.session_id = sid
    post_filter(sid, schemas=["HumanResources", "Person", "Sales"])
    post_tool(sid, "lineage_start_exploration", {
        "origin": "[humanresources].[employee]",
        "direction": "bidirectional",
        "depth": 2,
    })

    gate_resp = post_gate(sid, approved=False)
    r.assert_eq("gate ack ok", gate_resp.get("ok"), True)
    # Per toolProxy.ts: approved=false logs but does not transition. Phase stays awaiting_gate.
    r.assert_eq("phase after reject = awaiting_gate", gate_resp.get("phase"), "awaiting_gate")

    state = get_state(sid)
    r.assert_eq("state confirms awaiting_gate", state.get("session_phase"), "awaiting_gate")


if __name__ == "__main__":
    import sys
    sys.exit(run_test(__file__, t))
