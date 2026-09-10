# Representative snapshot selection

The optional `representative_selection` config block selects up to 20 distinct
conversations and produces a numeric census report. This is a **selection-only
stage**: it does not extract extra sample payloads, add replay/schedule/battery
entries, or change payload admission. Existing coverage recipes remain intact.
A later reviewed extension must materialize and admit the sampled conversations
before a full representative private campaign can run.

The shipped `scripts/certify_datasets.json` and battery are unchanged. Make a
reviewed new config version before inspecting candidate outputs, adding:

```json
"representative_selection": {
  "algorithm": "representative-logpv/1",
  "target": 20,
  "seed": "0101010101010101010101010101010101010101010101010101010101010101"
}
```

The seed above is a synthetic example, not an operator's chosen production seed.
The schema requires exactly these three fields, this version/target and 64
lowercase hexadecimal seed characters. Absence disables this stage; null or
malformed declarations refuse. No activity, outcome, resource-fit or old-role
exclusion is applied. Changing the seed/config or snapshot changes the sample;
do not reroll after a failure.

## Allocation

Use the existing full snapshot metrics: P is distinct voting participants, V
counts all vote rows including revotes/null-valued votes, C is distinct voted
comments and U is distinct participant/comment cells. Registered participants
remain a separate count. Integer size data must be nonnegative and consistent;
unsupported/null identities are refused rather than silently excluded.

Both P and V use `[0]`, `[1,9]`, `[10,99]`, `[100,999]`, ... with bin index zero
for zero and `len(str(count))` for positive counts. No floating logarithms or
upper-tail clipping. Quotas cover lower/upper P and V tails first (most populous
cell, seeded tie-break, reusing a cell that already covers a tail), then the
largest unrepresented cells until up to eight cells are covered. Remaining slots
maximize the integer deficit `20*cell_population - total_population*cell_quota`,
with capacity limits and seeded ties. Within each cell, take the quota's first
HMAC-SHA256-ranked identities without replacement. Ranking messages are compact
UTF-8 JSON arrays `[version,"conversation",zid]` or
`[version,"cell",p_bin,v_bin]`; the seed bytes are the HMAC key. Private final
collision ties use zid/cell coordinates ascending. Neither identity nor rank is
part of the report.

For fewer than 20 conversations, select the complete census and report the
shortfall. Zero population is reported by the selection command with exit2 and
cannot admit a campaign; whole-config extraction refuses before generating any
payload. More than 20 occupied cells can leave cells uncovered: the report
explicitly counts them. A complete rectangle of bins includes zero-count gaps.
Independent cardinality/tail/coverage checks reject a defective allocator.
This deliberately stratified sample's unweighted failure fraction is not an
unbiased production failure-rate estimate.

## Run inside the private snapshot box

From `delphi/`, using the already authorized restored-clone connection and a
reviewed config. All real values, credentials, raw surveys and sidecars stay in
that box; the certification worker gets no database or snapshot permission.

```sh
uv run python scripts/prodclone_extract.py select-representative \
  --database-url "$PRIVATE_CLONE_DATABASE_URL" \
  --from-config "$PRIVATE_SELECTION_CONFIG" \
  --out "$PRIVATE_SELECTION_PROVENANCE" \
  --snapshot-id "$PRIVATE_SNAPSHOT_ID"
```

`--out` must be a box-only file below `real_data/.local/`, never inside a bundle
payload or an Actions artifact. The file is written mode0600 and contains the
report, private ordinal→zid map and transaction guarantee. The source metric rows,
topics and rank hashes are not copied into it. stdout is only the validated JSON
report; errors contain fixed codes, not database URLs, source values or private
paths. A successful nonempty census exits0 even when short; this is selection
completion, not a certificate. Missing/malformed config, invalid counts, unsafe
path or report fields fail. An empty census exits2 after writing/reporting zero
counts. No existing recipe is resolved by this command, so a small population can
be surveyed without pretending it satisfies every existing edge-role predicate.

Omit `--snapshot-id` for a new local snapshot. For repeat selections/extraction of
the same state, keep a `pg_export_snapshot()` exporter transaction open and supply
its ID to each command; reusing a seed on a new snapshot is insufficient. The
code begins read-only repeatable-read before querying the census. The optional
`--writers-disabled` records an independently established clone condition; it
does not disable writers or relax transaction isolation.

Alternatively, the existing `from-config` extraction command with that same
optional config performs selection over the **same fetched census and transaction**
as its unchanged old-role resolution/extraction. It writes
`representative_selection.private.json` beside the payload, under the existing
`.private` sidecar directory. `certify_extract.json` contains the safe report but
excludes the representative identity map. Existing survey/role provenance stays
in its own restricted sidecars. With selection enabled stdout contains only the
new report; without the block, original extraction behavior/output is retained.
Failures never substitute the sample for a missing old recipe.

## Report boundary and measurements

The report has exactly `seed`, `bucket_counts` and `chosen_entry_sizes`.
`bucket_counts` contains numeric population, target, selected, shortfall, occupied,
covered and uncovered counts, plus `cells`: P/V bin, population and selected count.
Each size row contains only P, V, C, U, matrix_area, registered_participants,
all_comments and P/V bins. All values except the seed are integer counts or lists
of such records. Size rows sort by numeric size only and do not expose a link to
the private ordinal. Duplicate sizes are legitimate. The validator rejects
extra fields at every level and checks totals, coverage, bin/grid consistency
and size census before publication.

No zid, report ID, role/alias, directory/path, snapshot/timestamp, rank/hash,
source text, outcome or raw exception belongs in this report. Sidecars remain
in the extraction box and are excluded from tar/log/public outputs. This stage
measures database cardinalities only. It does **not** claim extracted byte sizes,
RSS or scratch capacity for the sampled conversations. Those require the later
payload/capacity stage; unknown byte measurements are not reported as zero.
No change is made to the private box's independent public-summary policy.

The tests use synthetic populations, including a deliberately defective allocator,
small/empty/uncovered populations, reordered inputs, ignored outcome fields,
report leakage/tampering and whole-extraction/CLI wiring. Selection evidence
cannot replace actual private payload, replay, capacity or cleanup admission.
