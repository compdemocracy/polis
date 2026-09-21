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
