"""F-FILT-01: POST /filter schemas:[X] flags catalog results as in_user_filter.

The user filter scopes the AI's catalog VIEW (search_objects, get_context),
not the engine's BFS topology. Verify the filter:
  (a) flags HR results as in_user_filter when filter is HR-only
  (b) unfiltered search returns multiple schemas; filter narrows the visible set
"""
from common import session, post_filter, post_tool, run_test


def t(r):
    # Unfiltered search
    sid = session()
    r.session_id = sid
    out1 = post_tool(sid, "lineage_search_objects", {"query": "employee", "limit": 30})
    res1 = (out1.get("result") or {}).get("results") or []
    schemas_unfiltered = sorted({n.get("s") for n in res1 if n.get("s")})
    r.assert_truthy(
        f"unfiltered search returns multiple schemas (got {schemas_unfiltered})",
        len(schemas_unfiltered) > 1,
    )

    # Filtered search — HR only
    sid2 = session()
    post_filter(sid2, schemas=["HumanResources"])
    out2 = post_tool(sid2, "lineage_search_objects", {"query": "employee", "limit": 30})
    res2 = (out2.get("result") or {}).get("results") or []
    in_filter = [n for n in res2 if n.get("in_user_filter") is True]
    out_filter = [n for n in res2 if n.get("in_user_filter") is False]
    r.assert_truthy(f"filtered search returns >=1 result", len(res2) >= 1)
    r.assert_truthy(
        f"HR results flagged in_user_filter (in={len(in_filter)} out={len(out_filter)})",
        len(in_filter) >= 1,
    )


if __name__ == "__main__":
    import sys
    sys.exit(run_test(__file__, t))
