# Daily shadow evidence

This opt-in integration collects private read-only responses from two instances
of the original Node app, validates retained bridge replay and legacy custody,
and publishes a closed daily receipt. It is dormant: no production reads,
history source, service activation, or alarm destination are installed.

- [CAPTURE.md](CAPTURE.md) describes `collector.py`, private inputs, identical
  reader closure, common exported snapshot, actual peer process checks, and
  the external legacy-history and observer-launch custody obligations.
- [SCHEDULER.md](SCHEDULER.md) describes the daily job, immutable local records,
  private publication, lost-acknowledgement reconciliation and shutdown.
- `bridge_adapter.py` admits the actual output of the opt-in
  `examples/shadow_replay.rs` adapter. Replay requires a separate already
  authorized shadow writer; the read-only collector receives no writer keys.
- `daily.py` supplies cut/route admission, exact decompressed body comparison,
  closed receipt validation and create-only publication. `receipt.schema.json`
  checks shape; the Python validator also checks counts and verdicts.

A current publication's vote/modification cursors cannot prove the exact
consumed history. An unavailable legacy custody source closes INCOMPLETE with
`cut-unbound-late-row`, without querying rows to invent history or earning
comparison credit. An order-only residual requires complete identical raw rows
with multiplicities and separator spelling preserved; it cannot excuse unknown
inputs, changed values, or error responses. Equal HTML/error responses also
cannot fill successful JSON route coverage. Bodies, cut hashes and route
parameters never enter the exported receipt.

Each cut imports one common read-only database snapshot into two fresh original
Node processes, including non-math tables. Current views must match retained
legacy/Python generations. This validates reader custody, not a historical
Clojure input source. The characterization entry installs fixture authentication
and must not be used as a production collector.

The immutable uploaded object is PENDING: its own future acknowledgement cannot
be embedded in it. A separately retained CONFIRMED local delivery observation
can earn PASS only when every admission, route and observation requirement is
complete. Lost acknowledgements reconcile the exact existing object; uncertain
writes never receive a replacement key. A late start earns no missing-time
credit. Controlled-clock tests are accounting controls, not live daily windows.

Before activation, independently admit actual same-host legacy history, reader
build and route scope, observer shard/allowlist launch custody, authority and
capacity, private storage, egress restrictions and writer stop/drain. Perform
real collector/observer kill and alarm-destination drills. The public controls
use local fixtures or explicitly labeled external doubles and do not establish
those deployment obligations. Clojure source and public serving bindings remain
unchanged.

Run the Python controls on Linux (Unix peer PID admission is mandatory):

```sh
python3 -B -m unittest discover -s coordinator-rs/tools/shadow -v
node --test server/shadow/reader.test.cjs
```

The PostgreSQL snapshot control additionally needs an owned isolated local
stack; see its test file and the capture handoff. Neither command activates a
service or publishes to a real evidence bucket.

Empty conversations have one additional named observation: `LEGACY_EMPTY_DEFECT`.
After the existing history, bridge publication and database-view admission, the
collector checks that the captured vote list is empty and the complete Python
row conforms to `delphi/scripts/schedules/pc-zerovote-01-empty.json`. Only that
binding enables the classification for full/subset PCA responses. The comparison
permits the schedule's declared missing legacy fields with Python's exact values;
it does not permit different present values, timestamps, missing PCA parents,
changed components, header differences or differences on other routes. JSON key
order is immaterial only inside this named omission comparison; byte differences
without a declared omission keep their original classification. Bound 304s carry
the full response's finding through unchanged.

Each observation is counted separately from `EXACT` and `ENGINE_DIFFERENCE`.
A receipt with a nonzero count must carry `empty_contract`, the SHA-256 of the
canonical JSON object containing the committed schedule's `empty_output` and
`legacy_absent_keys`. Daily summaries expose the total defect observations.
Incomplete custody, observer alarms and other engine differences still dominate
the daily verdict. Existing receipts without this optional vocabulary remain
readable; exporters and receipt validators must be upgraded together. There is
no database migration. The standalone collector now also needs the Delphi
`polismath/empty_output.py` loader and committed schedule in its checkout.

This rule covers declared engine omissions, not every served-byte discrepancy on
an empty conversation. The server's comment presentation/backfill can introduce
additional present-value differences; those remain visible for the separate
consumer fixes in P-066.
