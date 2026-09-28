"""Fixed statements for the light-shadow comparison. No job-supplied SQL.

Every statement is a plain SELECT on the existing `polis_probe_reader` grants
(provision_login.TABLES): `math_main`, `math_ticks`, and one column
(`created`) of `conversations`. `math_bidtopid` and `math_ptptstats` are never
named: the login has no grant on them, and the receipt lists them as uncovered.
`math_tick` and `caching_tick` are never selected: they are independent
counters per writer and never pair two rows.

The only bound values are the two labels and the window, taken from the
admitted job's closed run-spec and passed as driver parameters, never spliced.
"""
from __future__ import annotations

PROD = 'prod'
# The `math-python` compose service writes MATH_PYTHON_ENV, default `python`.
DEFAULT_SHADOW = 'python'
MAX_CONVERSATIONS = 250

ENVS = "(%(prod)s,%(shadow)s)"
# A conversation is active when either label's math_main row was written in
# the window. Both writers set `modified = now_as_millis()` on every upsert.
ACTIVE = ("SELECT DISTINCT a.zid FROM public.math_main a WHERE a.math_env IN " + ENVS +
          " AND a.modified >= %(start)s AND a.modified < %(end)s")

QUERIES = {
    # The snapshot's own clock; the window ends here.
    'clock': "SELECT (pg_catalog.date_part('epoch',pg_catalog.transaction_timestamp())*1000)::bigint",
    # Row counts per table and label. Other labels are never read or counted.
    'counts': (
        "SELECT 'math_main', m.math_env, pg_catalog.count(*) FROM public.math_main m "
        "WHERE m.math_env IN " + ENVS + " GROUP BY m.math_env "
        "UNION ALL SELECT 'math_ticks', t.math_env, pg_catalog.count(*) FROM public.math_ticks t "
        "WHERE t.math_env IN " + ENVS + " GROUP BY t.math_env ORDER BY 1,2"),
    'active': ACTIVE + " ORDER BY 1",
    # Both labels' blobs for every active conversation.
    'rows': ("SELECT m.zid, m.math_env, m.data FROM public.math_main m WHERE m.math_env IN " + ENVS +
             " AND m.zid IN (" + ACTIVE + ") ORDER BY m.zid, m.math_env"),
    'created': ("SELECT c.zid, (c.created)::bigint FROM public.conversations c WHERE c.zid IN (" + ACTIVE +
                ") ORDER BY c.zid"),
    # Proof the snapshot wrote nothing: no transaction id was ever assigned.
    'no_write': "SELECT pg_catalog.pg_current_xact_id_if_assigned() IS NULL",
}

# One extra row proves the fixed cap was exceeded without unbounded fetching.
LIMITS = {'clock': 1, 'counts': 4, 'active': MAX_CONVERSATIONS, 'rows': 2 * MAX_CONVERSATIONS,
          'created': MAX_CONVERSATIONS, 'no_write': 1}
QUERIES = {name: sql + f' LIMIT {LIMITS[name] + 1}' for name, sql in QUERIES.items()}
