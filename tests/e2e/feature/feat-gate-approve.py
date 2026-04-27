"""F-GATE-02: POST /gate {approved:true} transitions awaiting_gate → exploring."""
from common import session, post_filter, post_tool, post_gate, get_state, run_test


def t(r):
    sid = session()
    r.session_id = sid
    post_filter(sid, schemas=["HumanResources", "Person", "Sales"])
    out = post_tool(sid, "lineage_start_exploration", {
        "origin": "[humanresources].[employee]",
        "direction": "bidirectional",
        "depth": 2,
    })
    r.assert_eq("gate emitted", (out.get("result") or {}).get("gate"), "confirm_sm_start")

    gate_resp = post_gate(sid, approved=True)
    r.assert_eq("gate ack ok", gate_resp.get("ok"), True)
    r.assert_eq("phase after approve = exploring", gate_resp.get("phase"), "exploring")

    state = get_state(sid)
    r.assert_eq("state confirms exploring", state.get("session_phase"), "exploring")


if __name__ == "__main__":
    import sys
    sys.exit(run_test(__file__, t))
