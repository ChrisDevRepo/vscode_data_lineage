"""F-MULTI-01: start_exploration({supplement:{nodeIds}}) appends nodes
without re-emitting confirm_sm_start (per CLAUDE.md: "supplement bypasses
gate, forces inline").

Two-turn flow:
  1. Approve a regular gate to seed an exploration scope.
  2. Issue start_exploration with supplement.nodeIds → expect no gate, success path.
"""
from common import session, post_filter, post_tool, post_gate, get_state, run_test


def t(r):
    sid = session()
    r.session_id = sid
    post_filter(sid, schemas=["HumanResources", "Person", "Sales"])
    out1 = post_tool(sid, "lineage_start_exploration", {
        "origin": "[humanresources].[employee]",
        "direction": "bidirectional",
        "depth": 2,
    })
    r.assert_eq("turn 1: gate emitted", (out1.get("result") or {}).get("gate"), "confirm_sm_start")
    post_gate(sid, approved=True)

    # Turn 2 — supplement add. Per the rule this should bypass the gate.
    out2 = post_tool(sid, "lineage_start_exploration", {
        "origin": "[humanresources].[employee]",
        "direction": "bidirectional",
        "depth": 2,
        "supplement": {"nodeIds": ["[sales].[vsalesperson]"]},
    })
    res2 = out2.get("result") or {}
    # Allowed shapes: success-style payload (no error), OR gate==None.
    # Failure shape: error=action_required gate=confirm_sm_start (would be a regression).
    r.assert_eq("turn 2 did NOT re-gate", res2.get("gate"), None)


if __name__ == "__main__":
    import sys
    sys.exit(run_test(__file__, t))
