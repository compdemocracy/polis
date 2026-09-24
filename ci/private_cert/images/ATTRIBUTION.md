# Receipt /5 attribution

Producer and verifier images, the worker AMI, and the operator must roll out
together. The shared stdlib-only `ci/probe_box/receipt.py` decoder accepts
receipt /1 through /5; /5 requires the new fields. The image recipe and CI copy
list include the verifier module. No acceptance policy, tolerance, start vector,
iteration budget, science module, or fallback-start contract changes here.

Both real replay drivers opt into `--attribution-json`. Each checkpoint captures
actual folded raw/moderated matrices as SHA-256 fingerprints, actual incoming
PCA components as closed start kinds, fitted center/components, per-person
projections and base memberships. Only fingerprints, compact geometry and
identities stay in private sidecars; full matrices are not serialized. These
sidecars are part of the producer file inventory and remain inside the box.
The verifier expects one sidecar per admitted checkpoint per engine. Capture,
read, inventory or schema failures become closed `unavailable` rows; they never
abort an otherwise completed science replay or change its verdict. A missing or
malformed checkpoint degrades that row, while an extra inventory item degrades
the entry. The gate also catches unexpected measurement exceptions. Capture
can be disabled and the exporter still emits unavailable rows.
Default replay output is unchanged when the option is absent.

Fingerprint alignment sorts typed, base64-encoded participant/comment names.
Matrix values use fixed-width raw-DB polarity tokens: `-`, `0`, `+`, `n` (null).
Header and row separators bind identities and shape. Null differs from pass.
Python flips its input convention; Clojure keeps its native convention.

Every exported attribution row has exactly:

- `checkpoint`: a bounded index in the existing admitted schedule.
- `folded_matrix`, `moderated_matrix`: `equal`, `different`, or `unavailable`.
- `legacy_starts`, `python_starts`: two tokens each: `nonzero-warm`,
  `padded-warm`, `zero-fallback`, `missing-fallback`, `not-computed`, or `unavailable`.
  These describe incoming per-component power-iteration state; they do not
  export a seed or change fallback behavior. Small/empty special paths use
  `not-computed`.
- `person_projection`: `pass`, `fail`, or `unavailable`. This compares actual
  participant coordinates before clustering, including participants below the
  eligibility threshold. It does not compare base centers keyed by cluster ID.
- `base_partition`: `same-ids`, `different-ids`, `different`, or `unavailable`. Memberships
  are compared as sets independently of cluster identity.
- `comment_center_swap`, `comment_components_swap`, `comment_joint_swap`:
  `reproduced`, `not-reproduced`, `not-applicable`, or `unavailable`.
  Both local formula reconstructions must first agree with the actual captured
  comment coordinates. For a real comment-coordinate failure, replace only
  the other engine's center, only its components, or both, and compare the
  result with its captured coordinates using symmetric G12. This is a local
  input-substitution measurement, not proof of the upstream cause. Joint
  replacement is the reconstruction control. No observed failure means
  `not-applicable`; missing/rank-incompatible evidence or a formula mismatch
  means `unavailable`.

One shared component-sign alignment is used for all geometry. No rotations,
cluster-ID remapping in the gate, per-field fitted signs, or tolerance changes.
These observations never change the existing strict/G12 verdict. An orphan
participant in a legacy partition makes the checkpoint observation unavailable,
not fatal. A mismatch in captured participant identities is a projection `fail`
even if components are absent, provided the sidecar itself is valid.

The export boundary independently checks every key, token, type, index, order,
list length and truncation flag. At most eight rows per entry and 64 globally;
reserve one row per entry (failed entries first), then spend the remaining
budget on failed entries/checkpoints. The existing 131072-byte wire ceiling
remains. The strict comparison's checkpoint count drives both entry `checks` and
observation filling/truncation; unavailable rows count as present observations.
`attribution_truncated` explicitly marks rows omitted only by the export caps. Raw
matrices, paths, identities, coordinates, scores and eigenvalues are rejected
at the receipt boundary, including as additional fields.
