# Daily shadow evidence primitives

This directory is an incomplete production integration, not an activated runner.
`daily.py` provides immutable cut-file binding, private pair/route admission,
exact decompressed body comparison, closed receipt validation, and create-only
publication with lost-acknowledgement reconciliation. `receipt.schema.json`
checks shape; the Python validator additionally checks counts and verdicts.
Private bodies/cut hashes/route parameters never enter the exported receipt.

No Clojure source, serving namespace, database schema or application startup is
changed. The production recorder, actual child-provenance collector, consumed-cut
adapter and daily scheduler are not wired. Do not deploy this as a daily runner.
Its input bindings are obligations for a trusted collector, not proof that a
caller-supplied claim is true. The existing characterization entry point creates
fixture authentication and instrumentation and must not be run against production.

A current publication's lastVoteTimestamp/lastModTimestamp cannot identify the
exact consumed history. The public counterexample in test_daily.py gives two
visibility histories with the same final votes and cursor but different consumed
inputs. The unchanged writer does not retain that historical visibility/order.
Missing consumed-cut evidence remains INCOMPLETE. An order-only response residual
requires complete identical raw rows with multiplicities and separator spelling
preserved; it does not excuse unknown engine inputs or a changed value.

Publication cannot put its own future acknowledgement inside the immutable
object. The exported first object is PENDING; the publisher returns a separate
local CONFIRMED/FAILED/UNCERTAIN result. A complete scheduler must retain and
reconcile that delivery observation before any daily window earns PASS. No
uncertain write is overwritten. Cloud calls in tests use local fakes only.

Operator drill before activation: kill collector and observer separately; verify
missing evidence becomes INCOMPLETE and the existing D06 missing-data alarm is
observed at the real destination. Block bucket delivery and simulate a lost ACK;
retain unresolved state without a fresh publication key. Preserve the existing
Clojure writer and all public serving bindings throughout. No alarm destination
or service unit is installed by these primitives.

Run: `python3 -B -m unittest discover -s coordinator-rs/tools/shadow -v`.

Unknown late-row history is now the distinct closed residual
`cut-unbound-late-row`. The window closes INCOMPLETE even if unadmitted diagnostic
bodies differ. Receipts count bound and incomplete cuts; summarize_windows counts
INCOMPLETE daily windows without giving them acceptance credit. This is separate
from the observed order-only row classification. The production integrations
listed above remain open; these accounting changes do not create a capture source.
