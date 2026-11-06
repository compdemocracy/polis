# Report statement list

`GET` and `HEAD /api/v3/comments/report` return the report page's statement
projection. The route is off by default. It requires
`POLIS_API_REPORT_COMMENTS_READS=1` and
`POLIS_API_REPORT_COMMENTS_DATABASE_URL`; selecting `reportComments` in
`RUST_API_ROUTES` is separately required to send public requests to it. No client
or deployment selection is changed here. Node has no handler for the new path:
a Rust handback reaches Node's existing response for that path, not a projection
of the legacy comments endpoint.

The typed request has `conversation_id`, `report_id`, and `mod_gt` (default `-2`;
report levels `-2`, `-1`, `0`). It fixes the legacy route's `moderation=true` and
`include_voting_patterns=true`. Node's integer-prefix parsing is preserved for
`mod_gt`; malformed scalar types answer the existing parameter error, and
out-of-domain levels or other query keys hand back. Report and conversation must
match. Unknown report identifiers answer the same parameter error as Node.
Cookies, unsupported identities, request bodies and other methods hand back.

The schema is `polis-contracts/src/report_comments.rs`, compiled by both
workspaces. The array projects eight fields, retaining Node's row/property order:

| Fields | Report consumer |
| --- | --- |
| `txt`, `tid` | `client-report/src/components/lists/commentList.jsx` and `util/graphUtil.js` |
| `is_meta` | `client-report/src/components/lists/metadata.jsx` and `components/commentsGraph/comments.jsx` |
| `pid` | Unique author count in `client-report/src/components/app.jsx` |
| `agree_count`, `disagree_count`, `pass_count`, `count` | `components/barChart.jsx`; uncertainty in `components/app.jsx` |

`components/app.jsx` supplies the report's `mod_level`. No report list caller
sends `translate` or `lang`; those options stay outside this route. The report
computes other display fields from math separately. It does not read the legacy
list's selection, moderation, activity, velocity, timestamps or language fields.

Visibility follows Node's caller identity: anonymous callers, participants and
foreign owners see active statements with positive velocity and the conversation's
moderation filter. Owners, same-site moderators and configured admins can see
the wider moderation list. The report level narrows either set. Vote buckets
pass through `StorageConvention::CURRENT`; no vote is written. A conversation
with no math still returns its statement list and counts.

The route has two independent one-connection read-only pools: identity on the
configured primary, report lookup/statements on `READ_ONLY_DATABASE_URL` when
set. Acquisition is bounded at 15 ms, statements at 50 ms, and the request at
75 ms. No connection is held across a provider call; the route calls no provider
or math service. It shares no pool, lock, queue or budget with participation.
Startup wiring tests include both pools in the next-statement isolation check.

`conformance/report-comments-run.sh` compares fresh Node responses with the typed
route across the generated statement corpus, all six caller identities, all
three levels, HEAD, malformed inputs and unknown reports. Raw responses and
projected bytes are retained. Only Date is excluded from header comparisons;
Content-Length and ETag are recomputed for the Node projection. Fixtures have
no math rows. Separate boundary checks record explicit handbacks. Run with a
unique Compose project and three distinct loopback ports below 49152.
