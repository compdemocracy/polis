# Private read-only daily capture

This is an opt-in integration, with no production activation or production
history source installed. Run `collector.py --profile PRIVATE --request PRIVATE
--output PRIVATE` only under the scheduler with `SHADOW_COLLECTOR_ENABLE=1`.
The collector receives no bridge writer or cloud credentials. The bridge is a
separate, already-authorized custody process; its actual retained result and
computing-child event are checked by `bridge_adapter.admit_result` before use.
No fixture authentication, clock substitution, response normalization or main
application startup is used. The reader imports the original compiled app.

An unavailable actual consumed legacy history is an ordinary closed result:
set the scheduled cut's `custody_file` to null. The collector immediately writes
an INCOMPLETE receipt with `cut-unbound-late-row`, zero equality credit and its
actual elapsed duration. It does not query current rows to reconstruct history,
launch either reader, or run a bridge attempt. A current vote timestamp, tick or
database snapshot is never sufficient custody. The unchanged Clojure oracle
has no new history recorder in this change.

## Private profile and custody protocol

The scheduler freezes the collector profile bytes. The profile has exactly:

- `schema`: `polis-shadow-collector/1`.
- `expected_cuts`, `expected_routes` (all five route classes), and
  `observer_expected` (1440). Counts must equal the frozen cut/request inventory;
  every required route class has a positive expected count.
- `cuts`: ordered records with `offset` (seconds from start, 0–86399), `zid`,
  `requests` and `custody_file`. Each request has `route`, `headers` and
  `full_request`. The route is the exact six-field primitive route record.
  Its request SHA binds method, exact URL/query and admitted auth/conditional
  headers. Its query SHA is the independently reviewed SQL contract, not an
  HTTP query hash. `full_request` is null or the preceding full request digest.
- `readers`: `node`, `node_sha256`, `bootstrap`, `bootstrap_sha256`,
  `pool_sha256`, `clojure_namespace`, `python_namespace`, and `common`.
  `common` has `app_root`, `app_entry`, `build_manifest`, `dependency_manifest`,
  `node_build`, `node_dependencies`, `settings`, `node_settings`, `requests`.
  `build_manifest` covers every file under `dist`, `package.json`,
  `package-lock.json`, and exactly the two eager runtime data assets
  `src/prompts/moderation/script.xml` and
  `src/prompts/report_experimental/system.xml`. Their exact bytes contribute to
  `node_build`; missing entries, changed bytes, writable ancestors, symlinks or
  assets over 1 MiB refuse startup. The reader copies admitted asset bytes into
  its private working directory as mode-0400 regular files before app import.
  It exposes no source-tree link or ambient `.env`; `HOME` is that private
  directory. Other source data files are not projected. The supervisor must
  still isolate the filesystem and network; this module is not a sandbox for
  arbitrary application code.
  The request gate is derived from the frozen inventory for each cut.
- `database`: password-free `url`, exact `host`, `password_file`, `ca_file`.
  CA verification is mandatory. The login must be separately provisioned for
  read-only access; the collector never grants privileges or runs migrations.
  It also needs the existing coordinator observer RLS visibility, normally
  through `polis_coordinator_observer`, for retained generation metadata.
  Table-level SELECT alone does not bypass those policies. The original Node
  routes additionally need their separately reviewed read-only table access.
- `private_directory`, `observer_file`, `environment`. All private files and
  scratch must be on the operator-admitted encrypted same-host mount.

The request file has exactly `run`, `window`, `start`, `end`, `build`, `policy`.
`end-start` is 86400. The collector must start in the 60 seconds before the
window and wait on a wall/monotonic anchor. Even a fractional late start earns
no missing-time credit. Both wall
and monotonic time are checked; tests with an accelerated clock are accounting
controls and are not live observation windows.

A non-null custody path requires a separately reviewed **trusted same-host
custodian**, not arbitrary user JSON. Its closed `polis-shadow-custody/1` object
has `expected`, `legacy`, `legacy_view`, `cut_file`, `replay_request`,
`replay_result`, `replay_log`, `runtime_profile`. The primitive `expected`
bindings and `legacy` admission record must come from actual retained warm
legacy history and computing-process evidence. Ownership/mode/hash checks
protect file custody; they cannot establish that historical evidence exists.
Production scope stays INCOMPLETE until that source is independently admitted.

`expected.host` is SHA256 of Linux `/etc/machine-id`, a newline and
`/proc/sys/kernel/random/boot_id`, with surrounding whitespace removed.
Both writer bindings must identify this actual instance/boot. Private replay
request/result/log files carry the adapter's existing closed formats. The exact
cut file must match `expected.cut`; the history must match both engines.
Clojure is labeled `warm-continuation/1`; Python is accurately labeled
`poller-rebuild-prefix/1`. An identical label is not manufactured.

`legacy_view` maps exactly `math_main`, `math_bidtopid`, `math_ptptstats`,
`math_ticks` to SHA256 of each selected full row's `row_to_json(t)::text` UTF-8
bytes. `legacy.bundle` is SHA256 of the canonical `legacy_view` map. This is a
private database-view identity, not a replacement math comparison. The keeper
checks all four rows in one REPEATABLE READ READ ONLY transaction. It separately
checks Python payloads, ticks, caching tick, checkpoint, epoch and operation
against the actual retained bridge result. A moved or missing generation
refuses; retaining an old generation does not make it the current reader view.

Both private Node processes import that same exported snapshot, including all
non-math reader tables. They use the identical immutable build, dependencies,
settings, auth context, serializers and clock behavior, with only namespace
different. Each gets a fresh cache. Readiness is bound to the actual spawned
PID; every Unix HTTP connection checks both peer UID and PID on Linux. A lost
keeper or child invalidates the capture. No later current-row fallback exists.
The keeper and children are closed after the cut. Temporary private profiles
and sockets are removed; no raw HTTP bodies are exported or written to disk.
Externally retained cut/replay evidence has a separate approved lifetime.

## Observation, stop and delivery

`observer_file` is the private JSONL EMF output of the independently running D06
observer, including four warm-up minutes before the window. Environment/namespace,
actual timestamps, duplicate minute records, health values and dropped metrics
are checked. Missing data retains the existing health alarm arithmetic (3 of
5 one-minute periods; missing health is breaching, missing lag is not). Lag
greater than 600 seconds is breaching; unresolved operations stop the window.
The file must be privately owned and bounded to 8 MiB. Collector process death
cannot certify silence. The scheduler independently closes a missing or invalid
collector result as INCOMPLETE. This file transport does not prove notification
delivery at an external alarm destination.

The collector stops scheduling new captures on a byte difference, invalid
binding, observer alarm or unresolved operation. It never issues a new replay
write. A separate writer supervisor must perform the reviewed admission/drain
stop for a running shadow writer; read-only capture has no authority to revoke
it. Clojure's writer and public serving namespace remain untouched. A repeated
`(zid, cut, history)` cannot count as another source cut in one window. Separate
daily stable-state observations remain possible; they are not changing-input
coverage or seven-window acceptance by themselves.

Receipts are closed `polis-shadow-receipt/1` objects. Comparison uses the exact
decompressed original HTTP bytes; full conditional bodies remain bound to the
same URL/auth/snapshot. A 304 pair without an admitted preceding full body is
INCOMPLETE. A one-byte change is not normalized. Only the already-admitted
comment query may classify a complete order-only residual. The uploaded receipt
is PENDING; only a separately confirmed local delivery observation can supply a
local PASS verdict. See the scheduler documentation for immutable publication,
lost acknowledgement, shutdown and the dormant job definition.

This inventory currently admits JSON reads only. Equal HTML fallbacks, invalid
JSON and equal non-success responses do not fill successful math coverage.
JSON parsing only checks syntax; parsed values never replace compared bytes.
Binary/CSV routes remain uncovered until a distinct route rule is reviewed.
One failed or missing D06 sample prevents complete observation credit even when
the unchanged 3-of-5 alarm threshold has not yet been reached.

Activation still requires the actual same-host legacy history/runtime source,
immutable build and route review, DB capacity and authority admission, private
storage, egress restrictions, supervisor stop/drain and real alarm-destination
drills. None is inferred from a public control or a source file's presence.

Observer selection is a separate mandatory operator admission: the frozen D06
profile's shard count must match the publisher, and its allowlist must include
every captured zid (an empty D06 allowlist means the whole namespace). The
operator must independently bind that reviewed profile to the actual observer
launch and private output file. Existing D06 EMF records carry environment and
namespace but do not carry the shard/allowlist digest. This collector therefore
does **not** enforce or prove that selection from EMF alone. A healthy observer
watching other conversations is insufficient. Do not activate or claim scope
acceptance without that independent launch custody; no public control below
closes this operational requirement.
