# Observed legacy PCA random restart

Original v13 policy SHA-256: `9a26a056d1b80ff10705e19e2e3fda137a59b6d24ece27cdc3b06cd4acbc4272`.
The current combined policy is documented in NEAR_TIE_POLICY.md.
This original rule deliberately changed acceptance. The policy object in `gate.py` binds the
rule, start tokens, forward scope, field paths and admission behavior; the
policy-pin test binds its canonical digest. Image recipes and run inputs must
derive this new digest. Existing release artifacts retain their historical
bindings; they must not be relabeled as this policy.

The legacy engine can restart a zero or missing incoming PCA component from an
unseeded random vector. That reference is not reproducible. Per the 2026-09-24
ruling, accept Python's deterministic output for this named defect instead of
changing either replay driver's start vectors or either engine's arithmetic.

## Trigger and lifetime

The verifier reads the complete, independently admitted private observation
inventory. BOTH legacy and Python sidecars must pass admission at the onset;
a missing or malformed Python sidecar cancels even a real legacy onset.
The earliest checkpoint `k` whose `legacy_starts` contains
`zero-fallback` or `missing-fallback` establishes
`legacy-defect-pca-random-restart`. Either component suffices: subsequent
components depend on earlier deflation. Only that entry, from `k` inclusive to
its last checkpoint, receives the exception. Later nonzero warm starts retain
state derived from the random restart, so they do not clear it. Nothing before
`k` or in a neighboring entry is covered. Python start kinds do not trigger it.

Every claimed restart component must also be corroborated by the preceding
admitted legacy blob: `zero-fallback` requires that exact component row to
contain only numeric zeros; `missing-fallback` requires its absence. A zero in
the other component does not suffice. Uncorroborated claims become unavailable
and cannot establish an onset. Checkpoint zero uses the replay driver's pinned
all-ones seed: the absence of a previous file is NOT missing-component evidence,
and no checkpoint-zero claim is admitted. Missing/unreadable prior evidence
also cannot grant the exception. This corroborates observations against recorded
engine state; it does not authenticate an untrusted engine's output.

Malformed, missing, orphan or disabled observations cannot establish an onset;
measurement exceptions degrade to unavailable rows. A later unavailable row
does not erase an already observed onset. An unavailable onset therefore leaves
the ordinary strict/G12 verdict in force. The observer itself still cannot
abort a replay. Full private rows determine acceptance before receipt caps.
The exporter reserves the onset row first within each affected entry.

## Exact field closure

The shared comparison reconciliation covers these ten paths only:

| Paths | Dependency that prevents a reproducible comparison |
| --- | --- |
| `pca.comps` | Random restart changes components, including later deflated components. |
| `pca.comment-projection`, `pca.comment-extremity` | Coordinates use those components; extremity is their norm. |
| `base-clusters`, `group-clusters` | Participant projections feed clustering, centers, IDs, memberships and group selection. |
| `votes-base`, `group-votes` | Aggregations are indexed by the affected cluster memberships. |
| `repness`, `group-aware-consensus` | These statistics use group membership and per-group votes. |
| `comment-priorities` | The priority formula consumes PCA extremity and group votes. |

The dependency graph is explicit in `math/src/polismath/math/conversation.clj`:
PCA/projection/base clustering at lines 381–426; group clustering and smoothing
at 431–515; vote aggregation at 594–631; group-aware consensus and priorities
at 633–690; repness at 691–712. `math/src/polismath/math/pca.clj` computes the
center from the data mean before power iteration (lines 90–96).

`pca.center` is unaffected by the random start and remains enforced.
Overall `consensus` uses the moderated vote matrix (conversation.clj:714 onward), so it also
remains enforced. Counts, participant/comment identity lists, moderation,
timestamps, user vote counts, unknown PCA leaves and all other acceptance
fields keep their existing comparisons. This is a field dependency exception,
not permission to ignore an entire diagnostic family or entry.

Raw file/cursor/schema/type/finiteness validation precedes reconciliation.
G12 additionally admits each original field against itself using its typed
schema before applying the exception. Invalid shapes/types remain failures.
Only fields present on both sides are reconciled: missing top-level/PCA keys
remain failures. PCA geometric dimensions must agree. Downstream cluster
cardinality and cluster-key inventories may differ because membership itself
is affected. Both strict and symmetric G12 use the same field reconciliation;
the reported G12 metrics and failure diagnostics describe the remaining
reproducible comparison. Raw recordings and attribution stay unchanged.
Strict verdict hashes are computed from the reconciled projections; a cached
exception verdict cannot be reused when the onset is absent or later.

An entry passes only if both comparisons pass on the remaining fields and all
ordinary controls pass. A covered restart is recorded even if its components
happen to reconverge. An unrelated failure still yields FAIL with the observed
defect recorded alongside it. Stage comparisons remain diagnostic only.

## Receipt and rollout

Receipt /5 already carries two start-kind tokens per engine and checkpoint.
No schema version or key-set change is needed. Its optional `legacy_defects`
array now permits `{"name":"legacy-defect-pca-random-restart"}`, alone or
with the existing empty-omission observation. Names must be unique, the list
has at most two items, and arbitrary keys/values are refused. Receipts /1–/4
retain their previous vocabulary. Both worker and operator use the shared
`ci/probe_box/receipt.py` decoder. Deploy the new decoder with both v13 images;
the older /5 decoder rejects the new name.

`ci/private_cert/public_legacy_restart.py --out <fresh-directory>` generates
the exact public zero7 stream (pinned event hash), runs both real drivers,
demonstrates unclassified FAIL → classified PASS with the name in /5, and
exercises both decoders. A fresh nonrestart stream passes before a deliberate
projection mutation and fails afterward. This is a public replay/decoder
witness, not a private fixture admission or serving certificate.
