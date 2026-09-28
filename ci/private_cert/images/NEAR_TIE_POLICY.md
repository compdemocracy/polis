# Observed decision ties

Policy SHA-256: `3dfbdedd33d0c65f5708e4c1622a648abd8e3c89596d2818e6c5f6c4f5871aef`.
This changes acceptance deliberately. G12 remains `abs(a-b) <= 1e-6 +
1e-4 * max(abs(a),abs(b))`, with zero outliers. Existing release pins must not
be relabeled. Both worker and operator need the expanded receipt /5 vocabulary.

A close final PCA basis or final cluster center does not prove a tie. Assignment
uses pre-recentering centers; most-distal uses intermediate split candidates;
convergence uses both successive center lists. Final blobs and attribution /1
omit those decision-time quantities. Two different internal trajectories can
have the same final blob. Consequently this implementation adds private,
replay-only `clj-decisions/` and `py-decisions/` observations. They stay within
the existing producer evidence boundary. Only a closed name leaves in /5's
historically named `legacy_defects` union; no scores, identities, hashes or
trace rows are exported there.

## Admission and predicate

Both complete traces must name the checkpoint and SHA-256 of their exact raw
recording file. A missing, unsealed, stale, malformed, nonfinite or truncated
trace grants no exception. The normal original raw-file, checkpoint, cursor,
shape and finiteness admission runs first. Both existing attribution sidecars
must establish identical folded raw and moderated vote matrices and G12-close
participant projections under the one coupled axis transform.

Scan the paired decision prefix in execution order. Scope, call ordinal, row-capped requested cluster count,
subject, ordered candidate inventory, comparator and threshold must agree.
The cluster bound is `min(requested_k, number_of_input_rows)`: Clojure requests
100 base clusters while Python pre-caps that request at the participant count;
requests above the row count cannot produce extra distinct centers. This is
an exact algorithmic equivalence, not a numerical tolerance. Every paired
score in the prefix must be G12-close. Before the first different output-affecting
choice, all output-affecting choices must agree. Nearest-cluster identities in
most-distal are discarded by the engine: those rows compare scores only and
continue scanning; they can never authorize a tie. Unknown decision subjects
are unavailable. Each choice must independently be the actual
valid winner under its declared comparator, including the original exact
last-wins tie behavior. For the first different choice:

* Every corresponding score must be G12-close, not merely the winning pair.
* For min/max selection, the two selected candidates' scores must be mutually
  G12-close in EACH engine. Both winners must be valid for their own scores.
* For a threshold predicate, both scores must be G12-close to the SAME exact
  threshold, as well as to each other. The booleans must equal their predicates.

Tolerance applies in the units of the decision quantities, not to a normalized
residual or an invented relative tolerance on a difference. For example,
assignment quantities are distances, convergence uses radius 0.01, and split
continuation uses radius zero. Same quantities with an incorrect last-wins
choice are an algorithm defect, not a floating-point tie. Different candidate
identities/order, non-close prefixes, unsupported decisions or unknown evidence
remain ordinary failures.

The first version observes assignment, most-distal nearest/farthest selection
and its positive-radius split predicate, and the short-circuited convergence
comparisons. Clojure-only subgroup calculations absent from the served Python
algorithm are excluded: primary group inputs must contain the full base-cluster
ID set. The Clojure observer forces the already-computed prep-main view while
its wrappers are in scope because the graph is lazy/parallel. Per-call dynamic
scope prevents unrelated threads from borrowing a scope. Python records the
same vectorized distance columns used by its assignment. Observation errors
are caught; returned numerical results are preserved. At 100,000 observations
a checkpoint is marked incomplete and cannot grant an exception.

Repness selection and exact-coordinate distinctness/merge decisions are NOT
currently observed. The generic predicate supports their scalar comparison
forms, but that does not authorize an exception without paired, source-bound
observations and an explicit dependency scope. Their existing arithmetic stays.

## Names and downstream scope

The closed names are `accepted-tie-cluster-assignment`,
`accepted-tie-most-distal`, and `accepted-tie-cluster-convergence`.
A candidate is admitted only when its onset checkpoint FAILs the ordinary
strict/G12 gate without that tie and PASSes with only its declared closure
reconciled. The decision's own output field must also FAIL at onset: with
the closure reconciled except `base-clusters` (base tie) or `group-clusters`
(group tie; convergence and most-distal ties use their call's scope), the
checkpoint must still fail. Existing independently admitted restart handling
is identical in every check. An unchanged output, a failure only at another
checkpoint, any onset failure outside the closure, or a choice that
re-converged to the same root clustering while another closure field differs
grants no tie and records no tie name; that entry is judged normally.

Observers corroborate the selected farthest row, its nearest center and distance
against the engine's returned most-distal object, and the short-circuit
convergence aggregate against the engine's boolean result. Assignment rows
come from the actual cluster-step return. Separately captured kmeans returns
must agree with the final recorded base assignment and selected group assignment.
This checks contents in addition to raw-file hashes. A mismatch, absent return,
missing sidecar, or stale hash makes the observation unavailable.

The earliest admitted tie applies only to the same entry, at that checkpoint
and later checkpoints, because cluster lineage is warm-started.

For a base-clustering tie, the dependency closure is `base-clusters`,
`votes-base`, `group-clusters`, `group-votes`, `repness`,
`group-aware-consensus`, and `comment-priorities`.
For a group-clustering tie, exclude `base-clusters` and `votes-base`.
Both comparers use this identical closure, after original-field admission and
before cache hashes. Only shared fields are reconciled. Downstream cardinality
and group ID differences are allowed; missing top-level fields are not.

ALL PCA fields remain compared, including components, comment coordinates,
center and extremity. Overall vote/comment/participant counts and identities,
moderation, timestamps, global consensus and unknown fields remain compared.
The earlier named legacy random-restart rule remains a separate exception with
its own evidence and scope. A tie does not repair a continuous PCA failure.

A downstream value in the declared closure is no longer compared to the other
engine once lineage diverges. This is an explicit causal dependency exception,
as with the restart rule; it is not independent certification of each later
statistic. Source-bound replay observations establish the decision, not an
untrusted engine's signed proof. Raw/schema/finiteness validation remains in
force. Stale output mutation invalidates the trace binding at its onset.

## Rollout

`recipe.py` includes both observation modules, the Clojure replay helper and the
verifier classifier. The science hash includes Python replay modules. The /5
union allows at most five unique records (two existing defects plus three tie
names); /1–/4 reject the added names. The exported records contain only `name`.
Rebuild both images and roll out both decoders together after independent
review. Private run 21 and all historical policies remain separate.
