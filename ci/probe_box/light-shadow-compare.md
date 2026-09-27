# Light-shadow comparison job

This implements the daily comparison of P-067 section 4 as a probe-box job,
`light-shadow-compare-v1`. It compares the math rows the production Clojure
service writes under `math_env = 'prod'` with the rows the Python `math-python`
compose service writes under its own label (`MATH_PYTHON_ENV`, default
`python`). It adds no migration, grant, network policy, launch-template change,
Lambda or new AWS service, and it exports no row payload or conversation id.

**The result is operational only and cannot count toward cutover on its own.**
The comparison classifies differences by field name and structure; it does
not run the certified decision-trace gate (`gate.py`, `near_ties.py`), and a
digest naming policy `3dfbdedd…` does not supply that policy's evidence. Every
receipt says so in a fixed `acceptance` field. The certified verdict for a
flagged conversation comes only from the named-conversation triage run of
`sampled-paired-battery-v1` under that policy (see Triage below).

## Job

`polis-probe-job/2` with `kind: light-shadow-compare`, the three-image shape of
the roles census (`reader`/`read`, `producer`/`produce`, `verifier`/`verify`,
three distinct manifest references) plus one closed field, `run_spec`:

| Field | Meaning |
| --- | --- |
| `shadow_env` | the shadow's label; `[a-z][a-z0-9_-]{0,31}`, never `prod` |
| `shadow_started_ms` | when the shadow started; dates "created after start" |
| `window_seconds` | 3600 to 604800; the window ends at the snapshot's own clock |
| `engine_commit`, `engine_image` | what the shadow runs, as the operator states it |

The registry entry is a template: its image digests and `engine_*` values are
all zeros, `contracts.refuse_placeholder` stops the operator from launching an
all-zero image digest, engine commit or engine image, and the operator replaces
`run_id` and `run_spec` per run. `engine_*` and `shadow_started_ms` remain the
operator's assertions, not measured provenance.
`validate_job` refuses a `prod` label, so the job cannot be admitted with one.

The supervisor passes `run_spec` to the reader and producer in the selection
context (`/selection/context.json`); the verifier reads it from `/job`.

## Reader

The reader uses only the existing `polis_probe_reader` login. Its grants
(`provision_login.TABLES`) are `conversations`, `votes`, `comments`,
`participants`, `math_main` and `math_ticks`. The job reads `math_main`,
`math_ticks` and `conversations.created`. **`math_bidtopid` and
`math_ptptstats` are not granted and are not read**; the receipt lists them as
uncovered. Their content (bid-to-pid, base clusters) is also inside the
`math_main` blob, which is compared. Covering them would need a one-line grant
ruling; this job does not ask for one.

Fixed SQL (`light_shadow_queries.py`, bound into the policy digest) runs in one
read-only repeatable-read transaction that checks the session user, read-only
state and isolation. The two labels and the window are bound driver
parameters, never spliced. A conversation is active when either label's
`math_main` row was written (`modified`) inside the window. The reader takes a
catalog of counts (rows per table and label, active conversations) and both
labels' `math_main` blobs for the active conversations, capped at 250. It
proves the snapshot wrote nothing (`pg_current_xact_id_if_assigned()` is null)
and, in a second read-only transaction, re-counts the prod rows. That is all
the live checks observe: they cannot see another writer overwrite a prod row at
an unchanged count. Shadow writer isolation is the separate effective-
environment gate, not this job. A missing
grant, a failed query or the cap gives an INCOMPLETE projection with no rows,
never an empty PASS. The projection never leaves the box.

## Pairing and classes

Two rows are compared only when both describe the same inputs: equal
`lastVoteTimestamp` and `lastModTimestamp`, and equal totals (`n`, the sum of
`user-vote-counts`, `n-cmts`). All five must be present and typed on both rows
(`lastModTimestamp` may be null); an absent field is never evidence, and such a
pair FAILs. Pairing is a necessary heuristic, not proof of identical input
streams: equal maxima and counts can hide opposing revotes or same-count
substitutions. `math_tick` and `caching_tick` are independent
per-writer counters and never pair or compare. Anything else is **UNPAIRED**,
with one reason: `NO-PROD-ROW`, `NO-SHADOW-ROW`, `TIMESTAMPS` (in flight) or
`TOTALS` (same timestamps, different totals: the late-commit watermark
behaviour). Unpaired conversations are counted, not compared. Only the named
legacy empty row may omit totals, and only when the shadow row is the declared
empty conversation.

Before any class, structure is checked; any failure is named `row-schema` and
is a FAIL, never a triage class:

- the certified raw validation with its required keys (without them only for
  the declared empty conversation, whose shadow row must carry every declared
  empty value exactly);
- the complete acceptance inventory on both rows, after the named legacy-empty
  restoration;
- each row admitted alone by the certified field contract;
- no shape fault outside cluster cardinality (so a missing or truncated PCA,
  or a missing `group-clusters` or `repness`, fails; a different number of
  clusters does not);
- at least one compared leaf.

A **PAIRED** conversation is validated and projected with the certified
`certify.validate_checkpoint_blob` and `certify.project_acceptance`, then each
acceptance key is walked with the certified `g12` walk: continuous values
within G12 (`|a-b| <= 1e-6 + 1e-4*max(|a|,|b|)`), discrete values exact, PCA
axis sign aligned from the components as in certification. The class depends
only on which acceptance keys differ:

| Outcome | Differing keys |
| --- | --- |
| `PASS` | none (the empty-conversation legacy defect is restored first and named) |
| `NEAR-TIE-CANDIDATE` | only clustering and its downstream (`base-clusters`, `group-clusters`, `votes-base`, `group-votes`, `repness`, `group-aware-consensus`, `comment-priorities`), with PCA equal: the shape the accepted-tie names of policy `3dfbdedd…` cover |
| `HISTORY-DIVERGENCE` | PCA plus, at most, that closure: the warm-start or tick-schedule difference |
| `FAIL` | any history-free key (counts, tids, moderation lists, in-conv, consensus, timestamps), or `row-schema` |

NEAR-TIE-CANDIDATE and HISTORY-DIVERGENCE are unresolved, not accepted: no
tie margin or historical cause is established. A corrupted count in
`votes-base` or an absurd PCA mean lands in these classes too. They make the
run OPERATIONAL-ATTENTION and go to triage.

## Receipt

Receipt/3, `kind: light-shadow-compare`, closed at every level
(`light_shadow.validate_receipt`), at most 131072 bytes:

- `bindings`: source commit, the three image digests, query-policy digest,
  certification policy `3dfbdedd…`, server version;
- `run_spec` (equal to the job's) and `window` (start and end in ms);
- `coverage`: status, covered tables, the uncovered tables, the excluded fields;
- `rows`: prod and shadow row counts in `math_main` and `math_ticks`, active
  conversations, prod counts after the snapshot, and prod rows that carry the
  Python-only `group_clusters` twin;
- `totals`: PAIRED, UNPAIRED and each reason, each outcome, the empty legacy
  defect, created after start, and `triage_required` (NEAR-TIE-CANDIDATE plus
  HISTORY-DIVERGENCE);
- `worst`: the largest absolute and relative delta over all paired conversations;
- `triage`: the count of candidate conversations, `sha256` of the box-local
  triage set (sorted `[zid, lastVoteTimestamp, lastModTimestamp]`), and
  `ids: ON-BOX-ONLY`;
- `acceptance`: `operational-only; not certification or cutover evidence`;
- `conversations`: one entry per active conversation, sorted by content (not
  by zid) and carrying no zid: pairing, reason, outcome, legacy defect, the
  names of the differing acceptance keys, leaf counts (float, G12 outliers,
  exact, exact mismatches, shape faults, nonfinite), worst absolute and
  relative delta (four significant digits), created after start;
- `controls`: the live checks and fixed self-tests below.

The verdict is one of:

- `INCOMPLETE`: coverage not complete; or no conversation paired; or fewer
  than half of the active conversations paired (one pair among 249 missing
  shadows is INCOMPLETE);
- `OPERATIONAL-FAIL`: any control false or any conversation FAIL;
- `OPERATIONAL-ATTENTION`: any triage candidate;
- `OPERATIONAL-PASS`: otherwise. Only this sets the public bit to PASS. When the entries do not fit the limit, the
verifier emits an INCOMPLETE receipt without entries rather than a truncated one.

## Producer and verifier

The producer classifies the reader's projection and writes box-local evidence
(`/output/evidence.json`, with zids). The verifier does not import producer
code: it re-validates the projection against the job's run-spec, re-runs the
certified comparison in its own image, requires the producer's evidence to be
exactly equal, drops the zids, and alone writes `/verdict/receipt.json`.

Controls, all required for a PASS:

- live: `reader-no-write` (the snapshot was assigned no transaction id),
  `prod-count-not-decreased` (prod row counts afterwards are at least those in
  the snapshot; growth is Clojure's own writes) and `shadow-label-not-prod`
  (the label is not `prod`, it equals the job's, and no active prod row
  carries the Python-only twin). None of them proves that prod rows are
  unchanged;
- refusals: empty result, low coverage, forged producer evidence, forged projection (wrong
  policy, duplicate conversation, `prod` label), `prod` label in the job,
  identifier and content fields, wrong kind, image, policy, false PASS, count
  mismatch;
- classification vectors: the two data-driven unpaired reasons (timestamps,
  totals) and each outcome, including the named empty-conversation legacy
  defect; and structural FAILs: missing pairing metadata, two empty objects,
  a missing `pca`, `group-clusters` or `repness`, and truncated PCA components.

## Triage

`light_shadow.triage_spec(receipt, job)` builds the operator's handoff,
`polis-light-shadow-triage/1`: source run id, job and receipt digests, the
triage-set digest, the count, the window and policy `3dfbdedd…`. It names the
set only by digest. Consuming it (a named-conversation selection in
`sampled-paired-battery-v1` whose box recovers the set without the ids passing
through the operator) is not built here: it changes the certified battery's
selection and closure and needs a ruling on how the set reaches the next box.
Until then a flagged conversation has no certified verdict.

## Scope limits

The comparison is meaningful only before the `MATH_ENV` flip, while both
engines write. `math_ticks` is counted, not compared per conversation.
`math_bidtopid` and `math_ptptstats` are uncovered; similar data inside
`math_main` does not prove those stored rows. The 250-conversation cap and the
coverage floor are initial bounds with no production capacity claim.

## Local validation

Public fixtures only; no runtime or cloud build:

```sh
python3 -B -m unittest discover -s ci/probe_box -p 'test_*.py'
python3 -B -m unittest discover -s ci/private_cert -p 'test_light_shadow_images.py'   # needs the delphi dependencies
```

`test_light_shadow_images.py` also runs each role's recipe closure under
`python -I` with only its own files, the import view the image gets.

## Release boundary

Nothing here is built, published, baked or deployed. The release needs, in
order: review of this source; three recipes from the merged commit with
`light_shadow_recipe.py`; staging and export through the existing offline
workflow; independent review of the verifier; `light_shadow_registry.py` to
admit the three archives and emit the concrete entry for
`jobs.light-shadow-compare-v1` (replacing the zero digests); publishing the
archives to the assets bucket; and a rebake, because the worker must carry
`light_shadow.py`, `light_shadow_queries.py`, the job/2 kind in `contracts.py`,
the receipt dispatch in `receipt.py` and the run-spec in the selection context
(`worker.py`). Publishing archives alone cannot make an older AMI admit this
kind. Keep receipts private under the existing operator encryption and
retention boundary; public output carries only the run id and PASS/FAIL.
