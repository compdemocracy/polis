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
   it reads apart as its own text. It decodes no frame; when necessary it
   reads the two id arrays to check their union's size.
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
bound on the additional heap allocation held by `parse` at any one time
for a source of `len` bytes, whether it then refuses or not, known before
`parse` is called: the
walk's reader scratch, the escaped keys it keeps decoded, its spill of key
values (grown by exact doubling), the text kept of each read key, and the
union's vector, the largest phase counted, a reallocation counted as holding
the old room and the new. It is made from lengths alone, so it is loose: on
constructed inputs it deliberately overcharges; it is not a measured memory
requirement. The allocation tests force reallocations to move, counting old
and new buffers together. Compact repeated keys exercise the spill term even
at the default limits.

The caller must separately charge the capacity of the input byte buffer and
`row.math_env` before calling parse: those allocations already exist and are
not bounded by the source length. Inline values, stack space and allocator
metadata are outside these heap-payload bounds. Once `parse` returns,
`held()` bounds the projection's retained heap payload (the read keys' text,
the row's environment capacity, the source id). Transfer the row's charge
into that retained charge without an uncharged ownership gap; do not charge
the same row twice. Keep charging the original byte buffer until it is freed,
and reserve `reservation(needs)` separately while building frames. A caller
whose budget cannot cover the parse charge must refuse before parsing (or
use a lower `max_bytes`); the default size limit is not an admission promise.

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

It reads no database and decides nothing about which comments may be shown
(that is the live candidate query's); its draw only chooses among the ids it
is handed. It keeps no cache, holds no budget, runs no thread and has no
switch: those belong to the server. It makes no previous-count
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

## 11. The plan and the one-call draw

`src/plan.rs`. A plan is one conversation's routing weights for one
configured rule, built once from one read's frames; a draw chooses the next
comment from the candidates today's query returned.

**The configuration.** `RuleConfig::parse(plain, count_policy)` takes the
equation crate's canonical plain form of a rule and its parameters, exactly as
`ParamSet::to_plain` writes it (any other spelling is refused, so a
configuration has one text), and the count policy it names, checked with the
equation crate's `resolve`. Three pairs are built: `stored-weights/1` and
`uniform/1` (no policy), and `symmetric-gic-floor/2` over `symmetric-gic/2`
weights with the floor's base parameters (`base-counts:lag-0`). Every other
pair is `BuildRefusal::Unsupported`, every `/1` computed rule included: their
base counts need the previous update, which one stored math result does not
hold. `RuleConfig::needs()` names the frames to read, so a caller charges
`Projection::reservation` for exactly those.

**The build.** `Plan::build(&frames, &config)` makes one of three variants,
each drawn by its own library function and never through another's:
stored weights (`stored_weights_1`, over the stored map or no map), uniform
(`uniform_1`, no frame at all) and the floor (`FloorPlan::draw`). Frames read
without a frame the rule needs are refused (`MissingFrame`), so frames read
without the stored weights are never taken for "this conversation has no
map". A floor with `meta_policy = exclude` is refused
(`ExcludeMetaTooLarge`) for a conversation whose plan would know more than
10,000 comments (scored, unscored and excluded, meta comments in no other key
included). That number is an upper refusal bound while the cost of excluding
meta comments at the draw is open, not a measured serving envelope; a
conversation over it keeps today's draw. `BuildRefusal` is closed and carries
no comment id.

**The draw.** `Plan::draw(&sql_candidates, unit)`, in this order, with no
retry and no second rule:
1. more candidates than the plan's bound (10,000 for a floor with
   `meta_policy = exclude`, 40,000 otherwise) is `too_many_candidates`,
   before any copy or allocation;
2. each id is converted with a checked conversion (a negative id is
   `invalid_candidate_id`);
3. for a floor with `meta_policy = exclude` only, every id the plan's own
   `FloorPlan::excludes` names is left out, order kept: the meta set of the
   read the plan was built from, never a newer one; if that leaves nothing,
   `all_excluded`, never reported as the query running dry (`empty`);
4. the library's `Candidates` (duplicates refused) and `Unit`, then the
   variant's draw, once; `probabilities` is never called;
5. the comment to fetch is the receipt's comment id, converted back
   checked. The caller's list is never indexed with the receipt's index,
   which counts positions in the filtered list.

Every library refusal maps to a closed `Fallback` by a `match` with no
wildcard, so a refusal the library adds does not compile here until it has a
reason. None carries a comment id. Three are invariant failures
(`Fallback::is_invariant`), proved impossible on what the draw accepts and to
be counted and looked into: `no_interval`, `excluded_candidate` (impossible
after step 3) and `receipt_id_out_of_range`. A `Fallback` holds no receipt and
no probability: what the caller then serves is today's draw, with today's
chance, and is never reported as the plan's.

**Memory.** `Plan::charged_bytes()` is an upper bound on what a plan holds
for as long as it lives, with one `Arc` around it: the plan itself, every
source id at its longest (128 bytes), every ordered map and set at one node
per entry plus one, each scored comment's factors, the stored map's entries
and the meta set the floor keeps (their counts carried on `Frames`, since the
library's types do not expose them), and the terms. `Plan::draw_reservation(n)`
is an upper bound on everything one draw over `n` ids allocates, held all at
once until its result is dropped: the converted ids, the duplicate check, the
variant's scratch vectors, the receipt, and a fixed allowance per call. Both
are pure, allocation free and checked; an overflow charges `usize::MAX` or
gives `None`. On the constructed cases of `tests/plan_allocation.rs` both are
loose, about five times what was measured (a floor plan over 10,000 comments
and three groups held 2,035,552 bytes against a charge of 11,291,440). The
budget that charges them, the try-reservation before a draw, and holding a
draw's reservation until its computation has finished and released its
memory (also after a request's deadline has passed) are the server's, not this
crate's; so are the cache's own entries and bookkeeping.

**What is proven, and how** (`tests/plan.rs`, `tests/plan_allocation.rs`):
two builds from the same bytes give identical receipts for 10,000 units; each
variant's receipt equals a direct call of its library function; the floor's
draw equals filtering with `excludes` and then one direct draw; the fetched id
is the receipt's (with 10 excluded from `[10, 20, 30]`, filtered index 0 is
20); every input refusal is the same at units 0, 0.5 and 1 - 2^-53; no
invariant failure is reached over constructed accepted inputs; a negative
stored weight refuses at the draw (`unsupported_legacy_weight`); the exclusion
uses the plan's snapshot; the 10,000 rule builds at 10,000 and refuses at
10,001; `historical/1`'s weights, stored as the math engine stores them, draw
the same comment with the same reported chance as the library's own draw; a
list over the bound allocates nothing; a draw's peak and total allocation stay
within its reservation; a plan's retained bytes stay within its charge; and
the floor's draw makes the same allocations of its size as one direct draw,
so no `probabilities` call precedes it.

