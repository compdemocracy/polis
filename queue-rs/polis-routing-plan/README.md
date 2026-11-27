# polis-routing-plan: reading a stored math result into the routing equation's frames

## 1. What this is

The routing equation (`queue-rs/polis-routing-equation`) holds the rules that
weigh the comments a participant has not voted on, and the draw that picks
one. Its rules take typed inputs, called frames: each comment's extremity,
each opinion group's counts, the meta comments, the math engine's stored
weights. It does not say where those frames come from.

This crate is where they come from. It takes the parts of one conversation's
stored math result (the `data` of its `math_main` row) that comment routing
reads, handed to it as bytes, and turns them into those frames. Every frame of
one read carries the same source id, made from the row and a SHA-256 of the
bytes. What it cannot read exactly, it refuses; it never repairs.

It is a pure library, and nothing in Polis calls it yet. It opens no file,
reaches no database or network, reads no clock and keeps no state; it reads
the bytes it is handed. It is the one crate the routing equation allows to
depend on it, and assumptions about the shape of the stored math result live
here, never in the equation crate.

## 2. What it reads

A **projection** is one JSON object holding some of the math result's keys,
spelled and nested as the math result spells them:

```json
{
  "tids": [1, 2, 3],
  "pca": {"comment-extremity": [0.5, 1.25, 0.0]},
  "meta-tids": [3],
  "comment-priorities": {"1": 2.5, "2": null, "3": false},
  "group-votes": {
    "0": {"n-members": 3, "votes": {"1": {"A": 1, "D": 0, "S": 1}}}
  },
  "group-clusters": [{"id": 0, "members": [100]}],
  "base-clusters": {"id": [100], "members": [[7, 8, 9]]}
}
```

A whole math result is a projection too: every other key is walked (for its
depth and its repeated keys, section 5) and then left unread. In particular
the legacy `group_clusters` key and the `math_tick` written inside the JSON
are never read.

Beside the bytes, the caller gives the row's identity (`RowIdentity`): the
conversation (`zid`), the row's `math_env` and `math_tick` columns, the row's
`last_vote_timestamp`, and the database's `now()` from the same read.

Reading happens in two steps:

1. `Projection::parse(bytes, row, limits)` checks the bytes and sets each key
   it reads apart as its own text. It decodes nothing.
2. `Projection::frames(needs)` decodes only the keys of the frames the rule
   needs (`FrameNeeds`: stored weights, extremity, groups, meta) and builds
   those frames. A frame that is not needed is not made, so a malformed key
   that only it would read cannot refuse the read, and is never turned into
   data. A uniform draw needs no frame at all.

## 3. Where each frame comes from in the math result

Line numbers are in `delphi/polismath/conversation/conversation.py`.

- **Extremity** (`ExtremityFrame`): `tids` zipped by position with
  `pca.comment-extremity`. The engine permutes the two together into arrival
  order (`:1755-1769`), so position `i` of one is position `i` of the other.
  The value is the stored `pca.comment-extremity`, exactly as written, bit for
  bit; it is never recomputed from the served centre or the comment
  projection, whose axes are flipped on the way out. Refused: a length
  mismatch, a repeated tid, a negative value.
- **Each group's counts** (`CurrentGroupFrame`): `group-votes`, an object keyed
  by group id, each entry `{"n-members", "votes": {tid: {"A", "D", "S"}}}`
  (`:2296-2351`). For each cell:
  - `agreed` is the cell's `A`,
  - `disagreed` is the cell's `D`,
  - `passed` is `S - A - D`, since `S` counts every vote the group's members
    cast on the comment, passes included,
  - the group's members are its `n-members`.

  These are counts. The engine makes them from its own vote matrix
  (`:2324-2341`); this crate reads three non-negative integers per cell by
  their names and never sees a vote value or interprets a sign. A cell with
  `S` 0 is kept, as present with zero counts; a comment with no cell for a
  group is absent for that group, and an absent cell is not a zero cell. The
  tallies come from the raw matrix, so moderated-out comments keep their real
  counts (`:2296-2299`); which comments may be shown is never decided here.
- **The membership check**: the groups' frame is made only after
  `group-clusters` and `base-clusters` agree with `group-votes`. The engine's
  legacy shape writes `group-clusters` members as base-cluster ids
  (`:1780-1787`), and `base-clusters` is columnar: `id[i]` holds the
  participants `members[i]` (`:2226`). So each group's participants are
  counted through its base clusters, and that count must be the group's
  `n-members`. Refused: a base cluster named by two groups (or twice by one), a
  base cluster that does not exist, columns of different lengths, and a count
  that differs. A group in `group-clusters` with no entry in `group-votes` is
  allowed: the engine leaves out a group none of whose members is in its
  matrix (`:2318-2319`). Nothing about any participant is kept: the first
  policy is that every participant's group is unknown.
- **Meta comments** (`MetaComments`): `meta-tids`, as of the math update.
- **Stored weights** (`StoredWeights`): `comment-priorities`, read exactly as
  the equation crate's `StoredWeights::from_json` reads it: an object of
  comment ids, each a number, `null` or `false`. An array is refused, as
  today's read route refuses it. When the key is absent or `null` there is no
  map, and every candidate weighs 1, as today.

**A comment no one has voted on** is in no frame. Both `tids` and
`group-votes` are built from the vote matrix's columns, so a newly approved
comment with no votes is absent from both: not a zero, absent. What a rule
does with an absent comment is the rule's.

**Not here**: the previous update's counts, which today's equation reads.
`math_main` holds only the latest update, and this crate never synthesizes a
previous-count frame. Everyone's counts (people in no group included), a
participant's group, importance marks and topics are not in the math result
either.

## 4. The source id

Every frame of one read carries one `SourceId`: `plan-source/1:` followed by
64 hex characters, 78 printable bytes, inside the equation crate's limit of
128. The hex is a SHA-256 over these fields, each preceded by its length, in
this order:

1. a fixed domain tag,
2. the conversation (`zid`),
3. the row's `math_env`,
4. the row's `math_tick` column, never the `math_tick` inside the JSON (that
   one is made from the engine's wall clock),
5. the content identity (`ContentId`): SHA-256 over the projection's bytes
   exactly as fetched,
6. the row's `last_vote_timestamp`, or a tag saying it was absent.

The database's `now()` is not one of them: it says when the row was read, not
what was read, and the same row read twice must have one id.

## 5. The bounds, before anything is expanded

Everything is checked on the original bytes, or on counts taken from them,
before any frame is allocated:

1. **The length** (`max_bytes`), before anything else. A source over it is
   refused having allocated nothing.
2. **One walk over the bytes.** It builds no value. It refuses anything that
   is not one JSON object, any nesting deeper than `max_depth`, and any object
   that gives a key twice, including a key written once plainly and once with
   escapes. Repeated keys are found here, on the bytes, before any decoder
   could keep one and drop the other. The walk keeps the first eight keys of
   each open object on the stack, so each cell and each group allocates
   nothing; past eight, it keeps each key as one 64-bit value (a decimal id as
   itself, any other key as a hash). Two different keys with the same hash
   would refuse the object, which is safe: the read is refused, never misread.
3. **The counts**, each checked as it grows, so a source over a limit stops
   being walked at the first entry over it: comments (`tids`, `meta-tids`,
   `pca.comment-extremity`, `comment-priorities`, each up to `max_comments`,
   40,000 by default), groups (`max_groups`, 64), cells (`max_cells`, every group's
   votes summed), memberships (`max_memberships`, every entry of the
   membership keys).
4. **The union of comment ids**: the distinct ids of `tids` and `meta-tids`
   together are at most `max_comments`, checked here, whatever frames a rule
   needs later and before any is made. When the two counts together are
   within the limit nothing is read; otherwise both arrays are read into one
   vector given room for exactly their elements. An array that is not one of
   integers adds no id, so a malformed unused key cannot refuse another rule.
5. **The reservation**: `Projection::reservation(needs)` is an upper bound, in
   bytes, on everything `frames(needs)` allocates, computed from the walk's
   counts alone, never from the source's length. It is conservative on
   purpose: it assumes every vector doubled its way to its length and every
   ordered map node holds one entry. It is meant to be charged against a
   budget before the frames are built.

Before any of this, `Projection::parse_reservation(len, limits)` is an upper
bound on everything `parse` holds at any one time for a source of `len`
bytes, whether it then refuses or not, known before `parse` is called: the
walk's reader scratch, the escaped keys it keeps decoded, its spill of key
values (grown by exact doubling), the text kept of each read key, and the
union's vector, the largest phase counted, a reallocation counted as holding
the old room and the new. It is made from lengths alone, so it is loose: on
the constructed refused cases in the tests it is between about four and fifty times
what was held. Once `parse` returns, `held()` bounds what the projection
keeps (the read keys' text, the row's environment name, the source id).

Count arithmetic is checked: a cell whose passes do not fit in 32 bits, or a
reservation that does not fit in 64, is refused.

## 6. What it refuses

`SourceRefusal` is a closed list, and no refusal carries a comment id.

| Refusal | When |
|---|---|
| `TooLarge { what }` | a limit is exceeded: bytes, depth, comments, groups, cells, memberships, or the reservation |
| `Malformed { key }` | not JSON, not the key's shape, an id that is negative or not written as a decimal id, a number too large for a double |
| `DuplicateKey { key }` | an object gives a key twice |
| `Missing { key }` | a key a needed frame is made from is absent or `null` |
| `SeenBelowVotes` | a cell with A + D > S |
| `SeenAboveMembers` | a cell's S above its group's `n-members` |
| `CountOverflow` | a cell's passes above 2^32 - 1, or a sum that overflows |
| `EmptyGroup` | a group with `n-members` 0 |
| `ExtremityLengthMismatch` | `tids` and `pca.comment-extremity` of different lengths |
| `DuplicateComment { key }` | a tid repeated in `tids` or `meta-tids` |
| `InvalidExtremity` | a negative extremity (JSON cannot hold a non-finite one) |
| `UnknownBaseCluster` | a group names a base cluster that does not exist |
| `BaseClusterInTwoGroups` | a base cluster named twice |
| `MembersMismatch` | a group's participants through its base clusters are not its `n-members`, or it is missing from `group-clusters` |
| `ArrayPriorities` | `comment-priorities` is an array |

A refusal ends the read. Whoever called it keeps today's draw.

## 7. The vote sign

In storage, a vote of agree is −1; in exports, public datasets and people's
heads, agree is +1. This crate is on neither side of that boundary: it reads
no vote. It reads counts the math engine has already made, by their names
(`A`, `D`, `S`), and writes them into fields named `agreed`, `disagreed` and
`passed`. There is no vote value, no sign and no comparison with −1 or +1
anywhere in it. The test `agree_lands_in_agreed` holds the names in place: a
group that agrees with one comment and disagrees with another reads as
exactly that.

## 8. What is proven, and how

The tests are in `tests/frames.rs` and `tests/allocation.rs`, on constructed
projections only.

- Where each count lands: `agree_lands_in_agreed`,
  `pass_lands_only_in_passed`, `present_zero_stays_present`,
  `zero_vote_comment_absent`.
- Where each frame comes from: `extremity_is_the_stored_value` (bit for bit,
  beside a centre and a projection that are not read),
  `group_clusters_are_base_cluster_ids` (base-cluster ids that differ from
  participant ids; the legacy key never read),
  `stored_weights_read_as_the_equation_crate_reads_them` (equal to the
  equation crate's own reading; absent and `null` give no map).
- The source id: `row_tick_not_blob_tick`, `source_id_fits_and_is_shared` (at
  the largest conversation id and a long environment the id is 78 printable
  bytes, the same on every frame, unchanged by when the row was read).
- Needs: `unneeded_frames_are_not_made`, `unused_malformed_field_does_not_refuse`.
- One test per refusal, each from a constructed bad projection.
- `comment_id_union_refused_at_parse`: four distinct comments over a limit of
  three are refused at parse; an overlap counts once; an unused malformed
  `meta-tids` refuses no other rule.
- `refused_parse_holds_no_more_than_was_charged` (wide numeric keys refused
  by count, an unread object spilled and refused at its end for a repeated
  key, a long escaped string, eight long escaped keys, nesting past the
  limit), `union_refused_at_parse_within_its_charge`, and
  `accepted_parse_within_its_charge_and_keeps_no_more_than_held`: what
  `parse` held at its peak is within `parse_reservation`, and what an
  accepted projection keeps is within `held()`.
- `limits_refuse_before_allocation`: a source over its length allocates
  nothing; on one constructed source, refusals by count hold no more than its
  own size (not true of every source: the general bound is
  `parse_reservation`). `expansion_reservation_is_upper_bound`: on constructed worst cases
  up to 64 groups and 20,000 cells, with escaped keys, everything `frames`
  asks the allocator for is within the reservation. Both count with a
  counting allocator, per thread.

## 9. What it does not do

It builds no plan and draws nothing: the plan build and the one-call draw are
the next piece. It reads no database and decides nothing about which comments
may be shown (that is the live candidate query's). It makes no previous-count
frame, no participant facts and no importance or topic frames. Nothing calls
it.

## 10. How to run the checks

```sh
make check-polis-routing-plan
```

runs `ci/local/polis-routing-plan.sh`: `cargo fmt --check`, clippy with
warnings denied, the tests, a source scan of `src/` (the routing equation
crate's list: no files, network, clock, environment, threads, processes,
output, global state or `unsafe`), and the dependency rule (exactly
`polis-routing-equation`, `serde`, `serde_json` and `sha2`). Hosted CI runs
the same command. `make check-polis-routing-equation` then sees this crate as
the equation crate's one dependent, which its own rule allows.
