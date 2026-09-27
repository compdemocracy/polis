# Authoritative event ingress

`certify` and `replay_driver.py` prefer `events.jsonl` whenever it is present in
the selected fixture directory. Its sibling `events.meta.json` is required;
malformed/missing metadata fails instead of falling back to CSV. CSV-only public
fixtures retain the existing path. Both engines accept an explicit file:

```sh
# From delphi/
uv run python scripts/replay_driver.py run --schedule /private/schedule.json \
  --events /private/fixture/events.jsonl --out /private/replays
# From math/
clojure -M:replay --schedule /private/schedule.json \
  --events /private/fixture/events.jsonl --out /private/replays/dataset/schedule
```

For certification of opaque extracted directories, set `POLIS_REPLAY_INPUT_MAP`
to a JSON object mapping **every selected battery dataset alias** to one existing
absolute directory. A missing binding is an error; it cannot silently select a
public dataset or another private extraction. This local mapping is not an
admission: the private producer/verifier must derive it from the reviewed
manifest's role/directory binding and verify the manifest files before running.
Never commit a real mapping, private fixtures or results.

Ingress validates `certify-events/2`, the declared storage sign (integer -1 or
+1), strict integer types, ordinal/source-row continuity, vote-before-comment
ordering, monotone vote milliseconds, unique ascending comment IDs, counts and
the logical digest. Both engines preserve every vote slot, including duplicates,
revotes and NULLs. Equal-millisecond rows retain their frozen extraction order;
no new tie-break or deduplication is applied. Python retains the original event
rows (including current comment state and provenance) in `input_events`.

Only non-null votes undergo the declared storage-to-semantic sign mapping;
Clojure then maps semantic signs into its native raw convention. Null votes stay
null; zero weights stay zero and null weights stay null through the engine call
and restart. This is an ingress guarantee, not a new mathematical policy:
Python's existing update skips null votes, Clojure receives nil, and both current
engines ignore `weight_x_32767`. Their existing disagreement/failure is evidence,
not permission to turn null into pass, drop the event, or waive the gate. The
existing fixture admission's null policy still applies independently.

Current comment rows provide latest state and `modified`, not a historical
moderation log. Interleaving uses their integer-millisecond modification times
and counts absent `modified` values as unavailable. Moderation remains schedule
controlled; no initial participant/comment flags or historical actions are
invented. Full original events and metadata are hashed into both recording cache
keys; event metadata is also in the run's resolved schedules. Source is recorded
as `events-jsonl`. Changing convention, weight, null or comment state invalidates
the caches even when engine output happens to be unchanged.

## Historical schedules and CSV loss

A cut remains a **one-based vote slot**, not the mixed JSONL `ord` (which also
counts comment records). All vote events count, including NULLs. A historical
CSV cut after a dropped NULL addresses a different prefix. Even without drops,
subsecond timestamps change timestamp-based cuts and moderation weaving. Absolute
vote-count cuts are reusable only after proving identical vote identities/order
and the intended full-stream endpoint against the new manifest. Do not silently
reuse, truncate, rescale or repin historical private schedules. Freeze newly
reviewed recipe resolutions before inspecting candidate output.

`event_ingress.compatibility_accounting(events_path, csv_path)` emits exact
per-ordinal milliseconds lost, omitted NULLs, absent weights, old/new slot mapping
and whether the CSV equals the declared projection. It is a **private** diagnostic
and does not bless a lossy input. Missing original public facts are unavailable,
not evidence of zero loss.

## Reproducible public proof

```sh
PYTHONPATH=delphi python delphi/scripts/prove_event_ingress.py --out /private/fresh-proof
```

This enumerates public entries from the committed config and battery, lifts the
known CSV data into the authoritative format, runs both engines under both paths,
and compares SHA256s of every raw `step-*.json` file (including Clojure metadata).
It does not regenerate private inputs, rewrite schedules or compare provenance
files that intentionally record different inputs. The public export supplies no
original millisecond/weight/null-drop record; the lift cannot reconstruct one.

Two independent nondeterministic inputs are controlled **only by the proof**:
Python's output `math_tick` clock is fixed, and Clojure's `rand` is seeded 671.
The latter matters when a previously missing PCA axis is initialized on a later
every-vote tick: the normal cold-start pin alone does not cover that path. The
production engines and normal replay drivers keep their existing behavior.
An uncontrolled process-to-process axis sign change is not CSV information loss.
