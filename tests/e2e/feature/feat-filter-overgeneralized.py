"""F-FILT-04: NL-named exclusions + AI passes excludeTypes → reject.

Note: the current Zod schema accepts both excludeNodeIds and excludeTypes.
Per CLAUDE.md (2026-04-27), the doctrine for the model lives in the
discovery prompt — the schema does NOT mechanically reject excludeTypes.

This test EXPECTS the historical mechanical rejection (`nl_filter_overgeneralized`)
that the plan referenced. If it does NOT fire, the test FAILS — and the
failure IS the finding (mechanical guard removed; plan-doc references stale).
"""
from common import session, post_filter, post_tool, run_test


def t(r):
    sid = session()
    r.session_id = sid
    post_filter(sid, schemas=["HumanResources", "Person", "Sales"])
    out = post_tool(sid, "lineage_start_exploration", {
        "origin": "[humanresources].[employee]",
        "direction": "bidirectional",
        "depth": 2,
        # User said: "ignore SPs uspUpdateEmployeeHireInfo, uspUpdateEmployeeLogin"
        # AI translated to type-blanket — should be rejected per logging.md spec.
        "excludeTypes": ["procedure"],
    })
    result = out.get("result") or {}
    err = result.get("error")
    if err == "nl_filter_overgeneralized":
        r.assert_eq("rejection fired", err, "nl_filter_overgeneralized")
    else:
        # Expectation: per current code (CLAUDE.md 2026-04-27) the schema accepts
        # both — no mechanical reject. This is itself a CR finding to flag.
        r.assert_eq(
            "FINDING: nl_filter_overgeneralized guard absent (was specified in older plan)",
            err,
            "nl_filter_overgeneralized",
        )


if __name__ == "__main__":
    import sys
    sys.exit(run_test(__file__, t))
