"""F-MULTI-03: start_exploration while session is in `exploring` phase
should reject (active-SM warning) — per CLAUDE.md "Refine = full reset"
and "follow-up reuses archive": a brand-new question mid-exploration must
not silently start fresh.
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
    post_gate(sid, approved=True)
    state = get_state(sid)
    r.assert_eq("setup: phase=exploring", state.get("session_phase"), "exploring")

    # Now issue a fresh start_exploration with a different origin while exploring.
    out = post_tool(sid, "lineage_start_exploration", {
        "origin": "[ai].[factsalesreport]",
        "direction": "upstream",
    })
    res = out.get("result") or {}
    err = res.get("error")
    # Either an error envelope or the call should be silently ignored / reset
    # to gate (refine). We assert that the call did NOT silently take the
    # session into a new exploring phase without user gate.
    r.assert_truthy(
        f"start_exploration mid-exploring did not silently reset (err={err!r}, gate={res.get('gate')!r})",
        bool(err) or res.get("gate") == "confirm_sm_start",
    )


if __name__ == "__main__":
    import sys
    sys.exit(run_test(__file__, t))
