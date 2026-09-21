# Reproduce a recorded digest

From the repository root:

```sh
python3 coordinator-rs/ci/reproduce_pin.py <digest> --plan
```

The tool searches `replay-pins.json` and every `evidence/*.json`. It prints the
workflow/job, recorded source and platform attribution, locked inputs, command,
and the exact output file/JSON path or source-byte operation to compare. It never modifies a pin, learns
an expectation from current output, or selects a retired platform.

For a fresh replay, provision the existing campaign dependencies, choose a unique
`COMPOSE_PROJECT_NAME` and unused matching `POLIS_RECOVERY_PG_PORT` /
`RECOVERY_PG_PORT` (at least 55432), then supply a new directory outside the checkout:

```sh
python3 coordinator-rs/ci/reproduce_pin.py <digest> --output /absolute/new/reproduction
```

This invokes the existing `run.py` isolation, source reconciliation, TLS fixture,
exact inventory and fresh/historical comparisons. Use a reviewed clean checkout;
the utility does not bypass source admission to include its own uncommitted work.
No dependencies are automatically installed. A matching platform without an output
path reports `NOT_RUN`; a different or retired platform reports
`NOT_ON_THIS_PLATFORM`. The current keys are Darwin/arm64/not-forced and
Linux/x86_64/Haswell. The Linux numerical kernel must also be actually observed as
Haswell by both BLAS backends; matching key strings alone are insufficient.

A successful campaign is followed by `MATCH` or `MISMATCH` for the requested
recorded value at its exact fresh output path. Artifact bytes must match their
receipt hashes, the receipt must report candidate PASS, and runtime/pin identities
must agree. Failed campaign execution reports `CAMPAIGN_FAILED`, not a match.
`MISMATCH` and campaign failure exit 1; invalid input/receipt/path refuses with exit 2.
A plan, evidence-only value or unavailable platform can exit 0 without claiming
successful reproduction: inspect the explicit status.

```sh
python3 coordinator-rs/ci/reproduce_pin.py <digest> --campaign-dir /absolute/retained/campaign
```

This checks retained artifacts on the current platform and labels the scope
accordingly. It does not claim a new replay or authenticate an untrusted receipt;
use reviewed local campaign evidence. Symlinked/out-of-directory artifacts refuse.

Historical retrospective receipts, archive and dependency-review hashes are attribution,
not deterministic outputs of the current campaign. The existing nine-path
synthesized-empty observation boundary in `verify.empty_observations` is also
preserved: old request-clock JSON/gzip hashes are `EVIDENCE_ONLY`, never relabeled
as mandatory byte equality. This utility does not change admission validators.
Whole nonempty witness hashes and deterministic checkpoint/witness values have
explicit producer paths; whole empty-witness hashes cannot be reproduced by
pretending their clock-dependent fields are stable.

The P-061 Q appendix records commands for fixture hashes and other integrity pins
outside this utility's replay/evidence input scope. A located command is not a
claim that its remote dependency or historical platform was rerun.

Current-file SHA256 references, including every `verify.source_pins` closure
entry, run directly without Docker or `--output`. The tool hashes exact bytes
and reports MATCH/MISMATCH; changed source is historical drift, not permission
to repin. Both public input fixtures hash the raw checked-in votes CSV before
normalization. Missing or ambiguous preimages report BLOCKED. They do not use
ambient private fixture mappings. `--plan` still performs no comparison.

Fresh stage-inventory contexts have targets keyed by stage identity, not list
position. These comparisons are explicitly diagnostic: the existing stage gate
requires stage coverage and postconditions, not identical old checkpoint hashes.
A removed/changed historical context field reports MISMATCH with the missing path,
not a stage-gate failure. The tool leaves both validators and expected values
unchanged. Unknown future evidence paths are BLOCKED with a producer/preimage
prerequisite, never silently EVIDENCE_ONLY. Every evidence occurrence carries its
classification and reason in the report.

The required campaign is not run when `--output` is omitted: matching-platform
campaign values report NOT_RUN. Source-byte comparisons can run immediately.
`--campaign-dir` for a source value remains a current-file comparison and says so;
it cannot authenticate source bytes from a receipt whose workspace was deleted.

MATCH/MISMATCH applies only to the explicit `checks` in the result. The `coverage`
object lists remaining source targets, remaining campaign targets on the selected
platform, other-platform/retired targets, and blocked exact locations. A direct
source check can therefore MATCH while campaign checks remain pending; it does
not imply that every occurrence was reproduced. `complete_for_selected_platform`
reports whether those applicable targets and blocked locations were exhausted.
Evidence-to-registry mapping requires the exact file and JSON path; the only
normalization is checkpoint `python` to `rust`, whose equality the campaign checks.
