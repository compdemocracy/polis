# polis-routing-equation: how Polis chooses the next comment

## 1. What this is

Comment routing is how Polis chooses which comment a participant sees next.
This crate holds that choice as named, versioned rules with typed inputs, so
the equation can be read, changed under a new version, and compared, without
touching the code that serves participants.

It holds two rules today:

- **`historical/1`**, today's equation: the weight the math engine (the Python
  `priority_metric` in `delphi/polismath/conversation/conversation.py`) gives
  each comment.
- **`stored-weights/1`**, today's draw: the weighted random pick the Node server
  (`selectProbabilistically` in `server/src/nextComment.ts`) and the Rust
  selector (`select` in `queue-rs/polis-api/src/next_comment.rs`) make from those
  weights.

**Nothing calls it.** It has no route, no database, no cache, no clock, no
logging, no switch and no randomness of its own: it is a library of pure
functions. No participant sees anything different because it exists.

## 2. How Polis chooses the next comment

1. Every comment the participant has not voted on (and may see) is a
   candidate, in the order the comments were created.
2. The math engine has already given each comment a **weight** (the
   `comment-priorities` of its stored result). A candidate with no stored
   weight, or a weight of 0, `null` or `false`, counts as 1.
3. One candidate is **drawn with a chance proportional to its weight**: the
   weights are added up in order (the running sums), a random number `unit` in
   [0, 1) is scaled to `random_n = unit x total`, and the chosen comment is the
   first whose running sum is greater than `random_n`.
4. With this crate, every draw also gives a **receipt**: which comment was
   chosen, at which position, the `random_n`, and the probability it had,
   `q = weight / total`. The receipt is true: `q` differs from the comment's
   real chance under the draw by at most 2^-50 (about 9e-16), whatever the
   number of candidates, whenever the total is at least 2^-1021.

The probability bound assumes the caller supplies a uniform random unit from
[0, 1), or uniformly from the 53-bit grid. `Unit` validates the range and
finiteness; it cannot validate the caller's random source.

The receipt also names the rule and its complete parameters, the draw's
arithmetic (`legacy-cdf/1`), how many weights were read as 1 and why, any
candidate whose weight was too small to be reachable ("absorbed"), the number
of candidates and a digest of their order (FNV-1a 64 over the ids, an identity
check, not cryptography), and the source of every input.

**What produced the weights** is in the receipt too, beside the rule that
drew, as typed data. Every map of weights carries its provenance, set by the
constructor that made it, never passed in by the caller:

- weights `historical/1` computed here carry `historical/1` with its complete
  parameter set and the sources of the two frames it read (the previous tick's
  counts and the current tick's extremity);
- the math engine's stored `comment-priorities` say exactly that
  (`math-engine-stored`): this crate did not compute them and the map does not
  say which rule or parameters did, so the receipt does not claim to know;
- a draw with no map at all says `no-map`.

So two draws whose weights came from different parameter sets, or from
different frames, have different receipts, even when every number drawn is
the same. The receipt has one canonical plain form (`Drawn::to_plain`, JSON
with keys in a fixed order); `Drawn::from_plain` reads it back through the
same constructors and refuses any other spelling. Reading a receipt back
checks the recorded rule's structural invariants and restores what was
written; it does not re-run or authenticate the draw. A caller can write a
plausible but false receipt, including false source names and parameter
claims. Audit and experiment readers must trust or authenticate the record's
origin separately. A parsed receipt cannot construct a computed weight map.
The weights in a receipt that come from the math engine are as trustworthy
as the math result they were read from, and no more. Signed-zero novelty
amplitudes normalize to positive zero, so equal parameter sets have one
canonical representation.

Where this crate refuses, it gives no receipt and says why: an empty or
repeated candidate list, a unit outside [0, 1), a stored weight that is
negative or above 1e150, or a total below 2^-1021. Today's read route would draw
a negative weight; a probability cannot be negative, so this rule refuses
instead. The caller then draws its own way, and its receipt must name the rule
that actually drew.

### The current tick's frames (inputs of the corrected rules)

Today's equation reads the previous tick's counts already summed over groups.
The corrected rules also read the current tick, in frames that the caller
fills from the math result and that are checked against each other before any
rule runs (`src/frames.rs`):

- **The group frame** (`CurrentGroupFrame`): each opinion group's members and,
  per comment, how many of the group agreed, disagreed and passed. Group ids
  may be sparse (0, 2, 7). Refused: a group listed twice or with no members; a
  count for a group that is not listed; a comment seen by more of a group than
  it has members; the same group and comment twice; members adding up to more
  than the declared participants. Defined, not refused: no groups at all; a
  group whose members have voted on nothing; a group with no count for a
  comment. An absent count is not a zero count, and each rule says how it
  treats the two.
- **Everyone's frame** (`EveryoneFrame`): every participant's latest votes per
  comment, grouped or not. When both frames are given (`CurrentFrames`), the
  groups' agrees, disagrees and passes for each comment, summed over groups,
  must each be at most everyone's, and the groups' members at most the
  participants, or the pair is refused as inconsistent, naming the comment and
  the field.
- **Importance marks** (`Marks`, `CommentMarks`, `MarkTotals`, `GroupMarks`,
  `ImportanceMarks`): of the votes that could carry an importance mark, how many
  did, per comment, per group and comment, and for the whole conversation, each
  with its source and cohort. Per-comment marks and totals must come from one
  frame, and the comments' marks may not add up to more than the total. Group
  marks are taken only with a group frame of the same source. Anything not
  supplied is unavailable, never a zero.
- **The 2019 voter weights, aggregated** (`VoterWeightFrame`): per comment, the
  voters and the sum of their weights (each at least 1), and the totals over
  the whole conversation.

What counts alone cannot show stays the caller's to certify: that groups do not
overlap, that a source id names its source, and that two frames said to be one
tick are one tick.

## 3. The equation today: `historical/1`

For one comment, with **A** agrees, **D** disagrees and **P** passes in the
previous scoring tick (summed over the opinion groups), **S = A + D + P** votes
seen, and **E** its extremity in the current tick:

```
p       = (P + 1) / (S + 2)                    the pass share
a       = (A + 1) / (S + 2)                    the agree share
novelty = 1 + 8 x 2^(-S / 5)
weight  = ((1 - p) x (E + 1) x a x novelty)^2
```

The published form, `[P_agree x (1 - P_pass) x (1 + E) x (1 + 2^(3 - S/5))]^2`,
is the same thing (8 x 2^(-S/5) = 2^(3 - S/5)). The crate follows the Python
arithmetic to the operation and in its order: `(1 - p) x (E + 1) x a`, then
times the novelty, then squared.

**What each term rewards.**

- **`not_pass_share`, 1 - p**: few passes. A comment people pass on is one they
  could not or would not answer.
- **`agree_share`, a**: agrees, more than disagrees at the same number of votes.
  Today's equation is not symmetric: an agree counts in both shares, a
  disagree only in the pass share.
- **`extremity_boost`, E + 1**: being far out on the opinion map. E is the
  math result's stored `pca.comment-extremity`: how far from the centre a
  participant would land who agreed with this comment and voted on nothing
  else. A comment at the centre (E = 0) still counts, through the 1.
- **`novelty`, 1 + 8 x 2^(-S/5)**: being new. It is 9 at no votes, halves its
  extra every five votes seen, and is exactly 1 from 280 votes on.
- **The square** deepens every difference.

Use the stored extremity rather than recomputing it from the served centre:
the wire centre has its axis sign flipped while the components do not. With
fewer than two component rows the engine stores zero extremity for every
comment, including when the one loading is nonzero.

**A worked example.** A comment with 3 agrees, 1 disagree and no passes, at
E = 0.5: p = 1/6, a = 4/6, novelty = 1 + 8 x 2^(-0.8) = 5.5948; the product is
(5/6) x 1.5 x (4/6) x 5.5948 = 4.6623, and the weight is its square, 21.74.

**Comments with no weight, and meta comments.**

- A comment not scored in the tick (absent from the counts or from the
  extremities) gets **no weight** from this rule; the draw reads it as 1, as
  today. That rule cannot tell a new comment from a missing one.
- A **meta** comment that is scored weighs **7^2 = 49**, a constant, whatever its
  votes. (The 7 is marked "TODO TUNE" in the source.) Ordinary comments mostly
  weigh between about 0.2 and 3, so meta comments are drawn far more often.

**The first tick and comments with no votes.** At a conversation's first tick
the previous tick has no counts, so A = D = P = S = 0 for every scored comment:
weight = (1/2 x (1 + E) x 1/2 x 9)^2 = 81/16 x (1 + E)^2, about 5.06 (1 + E)^2.
The first pass is ranked by extremity alone. The adapter must supply an
explicit zero `Counts` cell for each currently scored comment to obtain this
result. An empty `HistoricalCountFrame` produces no weights and therefore the
draw's fallback weight of 1; it does not synthesize those zero cells.

**No votes is not the largest weight.** At E = 0: no votes gives 5.0625; one
agree 12.53; three agrees 16.14, the largest for any number of agrees with no
disagrees or passes. One disagree gives 3.13 and one pass 0.78. Novelty is
largest at no votes, but the agree and not-pass shares can rise enough to
outweigh its fall. Nor does one more agree always raise the weight: from 5
agrees to 6 (nothing else) it falls by 12.7%.

**Two groups or five** make no difference: the counts reach the equation
already summed over the groups.

### Candidates for the next equation (none is chosen)

These rules are candidates to compare. None of them is chosen, and nothing
calls them. Each reads the same frames as today's equation, and the consensus
rules also read the current tick's opinion groups.

**`symmetric/1`: agree and disagree weighed alike.** The count term is
R = (A + D + 1) / (S + 2), the share of votes that took a side, and it appears
twice: weight = (R x R x (E + 1) x novelty)^2, with today's novelty. A comment
that most people agree with and one that most people disagree with, at the same
number of votes, weigh the same, where today the agreed one weighs more (one
agree: 12.53 under both; one disagree: 12.53 here, 3.13 today). Passes are
punished more than today: R is squared inside and then again. **It is not fully
symmetric:** the extremity E is still measured toward a hypothetical agree vote
(how far from the centre a participant would land who agreed with this comment
and voted on nothing else). Swapping every agree and disagree leaves the count
term bit for bit the same, but in a real conversation it would also change E.
*A newcomer with no group* gets the same weights as anyone: the rule does not
look at the participant. *On a conversation's first tick* and *for a comment
with no votes*, R = 1/2 and the weight is 81/16 x (1 + E)^2, the same as
today. As today, no votes is not the largest weight: at E = 0, three agrees (or
three disagrees, or any three votes that took a side) give 16.14. *Two groups or
five* make no difference: the counts arrive summed over the groups.

**The group-informed consensus factor, `gic-mean/1` and `gic-geomean/1`.**
Group-informed consensus is Polis's own measure of what holds across opinion
groups. Each group's agreement with a comment is (A + 1) / (A + D + 2) for that
group's votes, and G combines the groups. `gic-mean/1` is the form the report
computes: the mean over the groups that have votes on the comment (passes do
not count; a group with no votes on it is left out; with none, G = 0.5).
`gic-geomean/1` is the geometric mean over every group, with passes counted in
the votes seen and a group with no votes read as no votes. The factor is
0.5 + G, between 0.5 and 1.5, so it lifts a comment most groups agree with and
lowers one that some group rejects, and never removes a comment. **It is not
symmetric in agree and disagree, by design:** it rewards agreement across
groups; swapping every agree and disagree turns G into roughly 1 - G. The order
groups arrive in and their ids cannot change a bit: the values are added in
sorted order. *A newcomer with no group:* the factor is a property of the
comment, the same for everyone. *On a conversation's first tick*, with no
groups yet (or one), the factor is exactly 1. *For a comment with no votes*,
every group's value is 1/2, so G = 0.5 and the factor is 1. *With two groups*
each group is half of G; *with five*, a fifth, and one dissenting group counts
for more under the geometric mean: four groups at 0.9 and one at 0.1 give
G = 0.74 under the mean and 0.58 under the geometric mean.

**`symmetric-gic/1`** is `symmetric/1`'s weight times that factor (the
geometric mean by default; `consensus_form` chooses the mean). A comment
today's equation does not score keeps no weight here either, and the draw
gives it 1 without the factor; a meta comment weighs 49 without the factor, as
today (`meta_policy`). It is not symmetric: the count term is, the factor and E
are not.

### The floor, the uniform rule and the stable draw

These exist for one purpose: an honest comparison of rules (an A/B test).
Such a comparison needs every comment to keep a known, recorded chance of
being shown, and the chance written on the receipt to be the true one.

- **`uniform/1`** gives every candidate the same chance, 1/n. It reads no
  weights. It is the floor's lane on its own, and a baseline for replays.
- **The floor** (`symmetric-gic-floor/1`) mixes two lanes. A stated share,
  `floor_share` (default 0.1), of the chance is spread evenly over the
  candidates; the rest follows `symmetric-gic/1`'s weights. A comment's chance
  is

  ```text
  q_j = floor_share / n  +  (1 - floor_share) * w_j / W
  ```

  where n is the number of candidates and W the sum of their weights. So every
  comment has at least `floor_share / n`, however small its weight: with two
  candidates weighing 1 and 3 and a floor of 0.1, the chances are
  0.05 + 0.225 = 0.275 and 0.05 + 0.675 = 0.725; a comment of weight 0 beside
  one of weight 2 still has 0.05. An unscored comment (a new one, in only one
  of the two frames) draws at weight 1, not multiplied by any factor, as the
  corrected equation was studied.
- **Zero-mass donation.** If every candidate's weight is 0, the weighted lane
  has nothing to share out; its share is given to the uniform lane, so every
  candidate gets 1/n, and the receipt records the donation
  (`weights->uniform:zero_mass`). Under `symmetric-gic/1`'s parameter ranges
  every scored weight is positive and an unscored one is 1, so this cannot
  happen in `symmetric-gic-floor/1` itself; it is proven on the lane
  arithmetic the rule uses (`floor_marginals`).
- **Exclusion.** Under `meta_policy = exclude` a meta comment has no chance in
  any lane, the uniform floor included: a draw given one is refused, whether or
  not the comment could have been scored. A candidate the plan knows nothing
  about is refused too (`NeedsBaseline`): the crate never invents a row.
- **The stable draw, `stable-cdf/1`.** The same arithmetic as today's draw,
  over the mixture's chances, with three checks first: a list with no mass is
  refused; a total too small to draw from is refused; and a comment whose
  positive chance is below 2^-40 of the total is refused
  (`NumericDegeneracy`). What it promises: every comment that has a chance has
  a real interval of random numbers (at least 2^-40 less 2^-50 of them), none
  is silently unreachable, and a small change in the weights moves the
  boundaries between comments only a little, so the outcome for a given random
  number changes only near a boundary that moved. It does not promise that
  the same random number picks the same comment after the weights change.
- **The receipt** reports, for the chosen comment, both lanes: each one's
  effective share after any donation, its normaliser (n, and W), and its part
  of the chance; the reported probability is the comment's true marginal
  chance under the mixture, `q_j` above, as computed (`d_j / T`, T the computed
  sum of the chances, within a few roundings of 1). No lane is drawn first:
  the draw is over the marginal chances, so the receipt never names "the lane
  it fell in".
- **What it rewards that today's equation does not:** nothing by itself; it
  guarantees exposure. It is symmetric in the sense its base is: the floor is
  the same for every comment.

## 4. The parameters

Every constant of a rule is a named, typed parameter with a range. The
defaults are the constants in the source; **changing a default or the formula
is a new rule version** (`historical/2`), never an edit of this one. The tables
are generated from the crate's own registry (`registry::describe`), and a test
fails if they differ.

**`historical/1`**

| Name | Default | Allowed | Meaning | Source |
|---|---|---|---|---|
| `agree_prior` | 1 | [1e-3, 1000], and at most `seen_prior` | added to the agrees in the agree share | `conversation.py`, `importance_metric`: `(A + 1)` |
| `pass_prior` | 1 | [1e-3, 1000], and `seen_prior - pass_prior` at least 1e-3 | added to the passes in the pass share | `importance_metric`: `(P + 1)` |
| `seen_prior` | 2 | [1e-3, 1000] | added to the votes seen in both shares | `importance_metric`: `(S + 2)` |
| `extremity_offset` | 1 | [1e-3, 100] | added to the extremity, so a comment at the centre still counts | `importance_metric`: `(E + 1)` |
| `novelty_amplitude` | 8 | [0, 1000] | how much larger a comment with no votes is made | `priority_metric`: `1 + 8 * (2 ** (-S / 5))` |
| `novelty_halving_votes` | 5 | [1e-3, 1e6] | votes seen after which the novelty boost has halved | `priority_metric`: `-S / 5` |
| `exponent` | 2 | an integer from 1 to 4 | the power the product is raised to | `priority_metric`: `inner ** 2` |
| `meta_inner` | 7 | [1e-3, 1e6] | a meta comment's value before the power ("TODO TUNE" in the source) | `META_PRIORITY = 7` |

The ranges are chosen so that every weight is a positive number: with
`pass_prior` below `seen_prior`, 1 - p stays above 0 even with no votes; with
`extremity_offset` above 0, E + offset stays above 0 at E = 0.

**`stored-weights/1`**

This rule has no parameters.

**`symmetric/1`**

| Name | Default | Allowed | Meaning | Source |
|---|---|---|---|---|
| `side_prior` | 1 | [1e-3, 1000], and at most `seen_prior` | added to the agrees plus disagrees in the side share | `historical/1`'s `(A + 1)` and `(P + 1)` read as one term `(A + D + 1)` |
| `seen_prior` | 2 | [1e-3, 1000] | added to the votes seen in the side share | `importance_metric`: `(S + 2)` |
| `extremity_offset` | 1 | [1e-3, 100] | added to the extremity, so a comment at the centre still counts | `importance_metric`: `(E + 1)` |
| `novelty_amplitude` | 8 | [0, 1000] | how much larger a comment with no votes is made | `priority_metric`: `1 + 8 * (2 ** (-S / 5))` |
| `novelty_halving_votes` | 5 | [1e-3, 1e6] | votes seen after which the novelty boost has halved | `priority_metric`: `-S / 5` |
| `exponent` | 2 | an integer from 1 to 4 | the power the product is raised to | `priority_metric`: `inner ** 2` |
| `meta_inner` | 7 | [1e-3, 1e6] | a meta comment's value before the power ("TODO TUNE" in the source) | `META_PRIORITY = 7` |
| `meta_policy` | `fixed` | `fixed`, `ordinary` or `exclude` | a meta comment weighs `meta_inner^exponent`, is scored like any comment, or is excluded | `fixed` is today's behaviour (`META_PRIORITY`) |

**`gic-mean/1`** and **`gic-geomean/1`** (the same two parameters)

| Name | Default | Allowed | Meaning | Source |
|---|---|---|---|---|
| `gic_offset` | 0.5 | [1e-3, 100] | added to G, so the factor is always positive | the factor `(0.5 + G)` of the corrected equation |
| `gic_min_groups` | 2 | an integer from 1 to 64 | with fewer opinion groups than this, the factor is exactly 1 | one group has no consensus across groups to measure |

**`symmetric-gic/1`**

| Name | Default | Allowed | Meaning | Source |
|---|---|---|---|---|
| `side_prior` | 1 | [1e-3, 1000], and at most `seen_prior` | added to the agrees plus disagrees in the side share | `historical/1`'s `(A + 1)` and `(P + 1)` read as one term `(A + D + 1)` |
| `seen_prior` | 2 | [1e-3, 1000] | added to the votes seen in the side share | `importance_metric`: `(S + 2)` |
| `extremity_offset` | 1 | [1e-3, 100] | added to the extremity, so a comment at the centre still counts | `importance_metric`: `(E + 1)` |
| `novelty_amplitude` | 8 | [0, 1000] | how much larger a comment with no votes is made | `priority_metric`: `1 + 8 * (2 ** (-S / 5))` |
| `novelty_halving_votes` | 5 | [1e-3, 1e6] | votes seen after which the novelty boost has halved | `priority_metric`: `-S / 5` |
| `exponent` | 2 | an integer from 1 to 4 | the power the product is raised to | `priority_metric`: `inner ** 2` |
| `meta_inner` | 7 | [1e-3, 1e6] | a meta comment's value before the power ("TODO TUNE" in the source) | `META_PRIORITY = 7` |
| `meta_policy` | `fixed` | `fixed`, `ordinary` or `exclude` | a meta comment weighs `meta_inner^exponent`, is scored like any comment, or is excluded | `fixed` is today's behaviour (`META_PRIORITY`) |
| `consensus_form` | `gic-geomean/1` | `gic-geomean/1` or `gic-mean/1` | which form of the group-informed consensus factor multiplies the weight | the geometric mean is the form the corrected equation was studied with |
| `gic_offset` | 0.5 | [1e-3, 100] | added to G, so the factor is always positive | the factor `(0.5 + G)` of the corrected equation |
| `gic_min_groups` | 2 | an integer from 1 to 64 | with fewer opinion groups than this, the factor is exactly 1 | one group has no consensus across groups to measure |

**`uniform/1`**

This rule has no parameters.

**`symmetric-gic-floor/1`**

| Name | Default | Allowed | Meaning | Source |
|---|---|---|---|---|
| `side_prior` | 1 | [1e-3, 1000], and at most `seen_prior` | added to the agrees plus disagrees in the side share | `historical/1`'s `(A + 1)` and `(P + 1)` read as one term `(A + D + 1)` |
| `seen_prior` | 2 | [1e-3, 1000] | added to the votes seen in the side share | `importance_metric`: `(S + 2)` |
| `extremity_offset` | 1 | [1e-3, 100] | added to the extremity, so a comment at the centre still counts | `importance_metric`: `(E + 1)` |
| `novelty_amplitude` | 8 | [0, 1000] | how much larger a comment with no votes is made | `priority_metric`: `1 + 8 * (2 ** (-S / 5))` |
| `novelty_halving_votes` | 5 | [1e-3, 1e6] | votes seen after which the novelty boost has halved | `priority_metric`: `-S / 5` |
| `exponent` | 2 | an integer from 1 to 4 | the power the product is raised to | `priority_metric`: `inner ** 2` |
| `meta_inner` | 7 | [1e-3, 1e6] | a meta comment's value before the power ("TODO TUNE" in the source) | `META_PRIORITY = 7` |
| `meta_policy` | `fixed` | `fixed`, `ordinary` or `exclude` | a meta comment weighs `meta_inner^exponent`, is scored like any comment, or is excluded | `fixed` is today's behaviour (`META_PRIORITY`) |
| `consensus_form` | `gic-geomean/1` | `gic-geomean/1` or `gic-mean/1` | which form of the group-informed consensus factor multiplies the weight | the geometric mean is the form the corrected equation was studied with |
| `gic_offset` | 0.5 | [1e-3, 100] | added to G, so the factor is always positive | the factor `(0.5 + G)` of the corrected equation |
| `gic_min_groups` | 2 | an integer from 1 to 64 | with fewer opinion groups than this, the factor is exactly 1 | one group has no consensus across groups to measure |
| `floor_share` | 0.1 | [0, 1) | the share of the chance spread evenly over the candidates; the rest follows the weights | the uniform floor of the corrected equation (`alpha = 0.10`) |

The defaults of these four rules are listed in `tests/golden/defaults-manifest-3.json`.
The first manifest, `tests/golden/defaults-manifest.json`, is a published golden
file and is never edited; a test requires the two files together to list every
rule exactly once.

A parameter set is written in one **canonical plain form**, JSON with keys in a
fixed order and every parameter written out, for example the defaults of
`historical/1`:

```
{"rule":"historical/1","params":{"agree_prior":1.0,"pass_prior":1.0,"seen_prior":2.0,"extremity_offset":1.0,"novelty_amplitude":8.0,"novelty_halving_votes":5.0,"exponent":2,"meta_inner":7.0},"terms":[]}
```

Reading it refuses unknown, missing and repeated keys, an unknown rule or
version, and any value out of range. Running a non-default set (an A/B arm, for
instance) is the rule plus this form; it is not a new rule. The parity promise
below holds at the defaults only.

## 5. What is proven, and how to see it

**The equation against the real Python function.** `tests/fixtures/historical-1/make_grid.py`
calls `priority_metric` itself, in the delphi image built from the source
commit recorded in the fixture's header, over a grid: votes seen in {0, 1, 2, 3,
5, 10, 20, 50, 200, 279, 280, 281, 10000, 4294967295}; every agree, disagree and
pass split up to 5 votes seen, and all-agree, all-disagree, all-pass and an even
split above that; E in {0, 5e-324, 1e-300, 0.1, 1, 3.7, 50, 400, 1e70}; meta and
not. The header records the commit, the SHA-256 of the function's source and of
`conversation.py`, the image, the Python and NumPy versions, the container's
platform and C library, the exact invocation and the generator's own SHA-256.
`tests/grid_historical.rs` reproduces every case. On the recorded grid (1,386 cases, written in the
delphi image on Linux aarch64 with glibc 2.41, Python 3.12.16 and NumPy
1.26.4), all 1,386 are bit for bit equal; the largest relative difference is 0.

The tolerance is a relative 1e-12. Both sides run the same eight or so
floating operations in the same order; the one `pow` (in the novelty) comes from
the C library, and the Python side ran on Linux while the crate's check may run
on macOS, so the last bit can differ. 1e-12 is a thousand times that, and far
below the effect of any real change to the formula: changing the 8 to 7 moves
the small-count cases by percent. Exact zeros must be exact. From 280 votes
seen the novelty is exactly 1 on both sides, so the grid's large counts test
the shares and the extremity, not the novelty.

**The draw against Node.** `tests/fixtures/stored-weights-1/make_draws.py` is a
line-by-line transliteration of Node's `selectProbabilistically` into Python
floats (both IEEE doubles with the same `+`, `x` and `>`). It records the chosen
position and `random_n` for the three cases the Rust selector's own test
records, every boundary below, and generated weight lists at random units and
at each candidate's interval boundary and its neighbours.
`tests/draws_stored_weights.rs` matches every one bit for bit: of the 1,403 recorded cases, 1,402 draw the same
position with the same `random_n`, and the one whose total is below 2^-1021
is refused by the crate, as it must be.

**Golden cases** (`tests/golden/`): the three recorded cases with their
receipts, (position 0, `random_n` 0, q 0.25), (1, 1.0, 0.75) and (1, 1.5, 0.5);
[1, 3] at the unit just below 0.25 (position 0) and at 0.25 (position 1); a
single weight 2^-1021 at the unit just below 1 (drawn); a single weight 5e-324
there (refused, where today's code finds no candidate); [1, 5e-324], whose
second comment is absorbed and flagged; a negative stored weight (refused). For
`historical/1`: the first tick (5.0625 and 20.25), one and three agrees, a meta
comment (49), and comments that are not scored.

**The receipt.** A test finds, for every candidate of hundreds of weight lists
(including zeros, 1e-9, 1e6, 1e150 and 5e-324), the exact interval of units
that selects it, by bisection over doubles, and checks that its length differs
from the receipt's q by at most 2^-50. Also tested: a weight of 0 is never
chosen; no draw fails when the total is at least 2^-1021 and every draw is
refused below it; a single candidate is chosen with q = 1 exactly; multiplying
every weight by a power of two changes only `random_n`, by exactly that power,
when the original and scaled values stay in the supported range and positive
weights and intermediate products remain normal; the q's of a list sum to 1
within 3n x 2^-53.

**The equation's properties**, each checked against its formula before it was
written: every returned weight is a positive normal number at most 1e150;
out-of-range computations are refused, including at the defaults for a large
enough extremity, while the defaults with E at most 1e70 stay in range; one
more pass lowers the weight; turning a disagree or a pass into an agree, or a
pass into a disagree, raises it; extremity never lowers it (E = 0 and
E = 5e-324 give the same weight); novelty is in (1, 9] in real arithmetic and
rounds to exactly 1 from 280 votes; meta is exactly 49; the two counterexamples
above (no votes is not the largest; 5 to 6 agrees falls 12.7%) are kept as
tests. A result does not depend on the order its inputs are given in, and the
explanation (the named factors) evaluated left to right is the weight bit for
bit.

**No panics.** A deterministic corpus of awkward values (NaN payloads,
infinities, subnormals, -0.0, 1e308, the largest counts, empty, repeated and
unknown candidates, malformed and duplicate-key JSON, deep nesting) goes
through every public constructor and entry point; each returns a value or a
typed refusal. This is evidence, not an exhaustive proof.

**Shown failing on purpose.** The novelty's 8 changed to 7, the draw's `>`
changed to `>=`, and the pass share rewritten as `(A + D + 1) / (S + 2)` each
turn the tests red.

**What is not proven.** That any rule is better for participants. That a caller
will feed the crate the counts of the right tick, with agrees and disagrees in
the right fields. The recorded public replays and the scalar Python drift
test below check a fixed input corpus; they do not certify the live pipeline.

### The recorded public replays

`tests/fixtures/historical-1/make_fixture.py` replays the two public
conversations in `delphi/real_data` (VW and biodiversity, each export pinned by
its SHA-256) through the Python math engine, at ten prefixes of their votes in
(timestamp, file order), and records every input the engine's priority formula
was fed and every priority it returned: VW 10 ticks and 1,034 comment cells,
biodiversity 10 ticks and 2,189 cells (150 of them meta comments), and 8
constructed ticks with 34 cells (one comment, which gives fewer than two PCA
component rows; new comments; groups changing between ticks; a moderation
change). A separate empty recompute records no PCA and no priority calls,
bringing the constructed total to 9 ticks, still 34 cells.
`tests/parity_historical.rs` feeds each tick's recorded counts and
extremities to `historical/1` at its defaults: **all 3,257 cells agree bit for
bit; the largest relative difference is 0** (tolerance 1e-12, exact zeros
exact). For one comment per conversation the fixture also carries an extremity
computed, wrongly on purpose, from the served centre; it moves the weight by a
factor of about 5, and the test requires that it does not reproduce the
priority.

Two vote-sign checks, which compare like with like: the export's raw rows with
its agree (disagree) value equal the comments export's `agrees` (`disagrees`)
for every comment (125 and 316); and each participant's latest vote, folded
independently, equals the engine's loaded vote matrix comment by comment at
every prefix. The first proves the export's sign is read as the export
declares it; the second checks the latest per-comment counts. These totals
detect the tested flips, agree/disagree swaps and raw-row/latest-row mixups;
they do not prove participant identities or that every intermediate re-vote
was processed. Permuting participants can preserve every column total.

What the replays prove: given exactly the counts and extremities the Python
engine fed its priority formula while replaying these two public conversations
at ten prefixes, `historical/1` returns the same numbers. They do not prove
that a production caller will feed the crate correctly signed or correctly
lagged counts, nor that these ticks are the ticks production ran.

### The corrected rules against an independent statement

`tests/fixtures/crosscheck/make_crosscheck.py` states `symmetric/1`, both forms
of the group-informed consensus factor and `symmetric-gic/1` (in both forms)
again, in NumPy, from the formulas above and not from the Rust code. It writes
every comment's weight, G and factor, and the probability vector of a draw over
the candidates, for ten constructed cases: two, three and five groups; sparse
group ids; absent and zero cells; one and twelve candidates; one group and no
groups; new comments the equation does not score; a fixed meta comment.
`vectors-3.json` holds its output, with a header naming the formulas.
`tests/crosscheck.rs` requires the crate to reproduce all 563 numbers within
1e-12; the largest differences found are 1.9e-16 (factors and weights,
relative) and 5.6e-17 (probabilities). A change of 1e-11 to the novelty or the
factor, or of 1e-10 to one recorded number, turns it red. Importance, the floor
and zero mass are not in this file yet.

### The floor and the stable draw

`tests/floor.rs` checks every reported chance three ways. **By hand**, in plain
arithmetic written in the test: [1, 3] at 0.1 gives 0.275 and 0.725 (lanes
0.05 and 0.225 / 0.675); [0, 2] gives 0.05 and 0.95; [1, 5e-324] gives the tiny
comment 0.05; [0, 0] donates and gives 0.5 each; three comments [2, 0, 6] at
0.25 give 13/48, 4/48 and 31/48; one candidate gives exactly 1 for every
random number. **Against what the draw does**: the random numbers that pick
each comment are found by bisection over every double in [0, 1), and their
measure equals the reported chance within 2^-50. **Statistically**: 400,000
draws from a fixed seeded source land on each comment with a frequency
within five standard errors of the reported chance. Also: every chance is at
least `floor_share / n` up to rounding; the uniform lane's parts add up to the
floor share; the stable draw refuses no mass, a total below 2^-1021, and a
positive chance below 2^-40 of the total, where today's arithmetic would
silently absorb it; an excluded meta comment is refused whether scored, in one
frame or in neither; receipts read back byte for byte, and altered ones are
refused. `tests/golden/receipts-2.txt` records the first receipts of the new
shapes (and of the earlier shape with no map and with the engine's map); every
receipt of the first golden file still reads back unchanged.

## 6. What it does not do

No HTTP route or handler; no database, SQL, pool or connection; no cache or
global state; no schedule, job, table or migration; no clock; no logging or
printing; no feature, switch, environment variable or configuration file; no
randomness of its own (the caller passes the unit); no network, model call or
file reading at run time. It changes nothing in the Node server, the Rust
selectors or the Python math engine. The corrected rules (agree and disagree
weighed alike, group-informed consensus, a uniform floor, importance) come
later, each as its own named rule; none is chosen for anything.

## 7. The vote sign

There is no vote in this crate. Its only vote input is **counts**: how many
agreed, how many disagreed, how many passed, each by name and unsigned. No
signed vote value can be written down in its types, so the question of which
number means agree (the database stores agree as -1; exports and people use
+1) is settled before the crate, by whoever counts: the math engine, whose
counts are already named, or a caller going through the vote convention
module.

What counts cannot catch is a caller that puts the disagrees in the agree
field. Under `historical/1` that would reward disagreed comments in place of
agreed ones; the caller's adapter must carry its own convention tests.

## 8. How to run the checks

```
make check-polis-routing-equation
```

This runs, in `queue-rs`: `cargo fmt --check`, `cargo clippy -D warnings`, the
tests (printing the grid and draw counts), and three rules: a source scan (no
file, network, clock, environment, thread, process, output or global state
under `src/`; clippy's `clippy.toml` is a second witness), a dependency rule
read from `cargo metadata` (nothing else in the workspace depends on this
crate; it depends on `serde` and `serde_json` only), and an unchanged-fixture
rule: no file under `tests/golden` or `tests/fixtures` may be modified, deleted
or renamed against the base branch (`origin/edge` locally, the pull request's
base on hosted runs, `ROUTING_EQUATION_BASE` to choose). Adding files is fine.
If the base cannot be found the check fails; it never skips. Hosted CI runs the
same command. It needs no database and no Docker.

**A fixture is never remade for an existing rule.** A changed Python formula
is a new rule version (`historical/2`) with its own golden and fixture files,
made by running its generator once, in the delphi image:

```
python -I make_grid.py --delphi /app --commit <commit> --image <image id> --out grid.json
python3 -I make_draws.py --out draws.json
```

### The binding and the Python drift test

`tests/fixtures/CURRENT_PYTHON_RULE` names the rule today's Python must match
and its grid by SHA-256 (`historical/1 historical-1/grid.json sha256:...`).
`delphi/tests/test_routing_equation_parity.py` re-runs the bound grid and every
recorded replay through today's `priority_metric` and compares its source hash
with the one the grid recorded; when the Python formula changes it fails with
"the routing equation changed in Python; record a new rule version and its
fixture in the routing equation crate and move the binding in the same change;
never edit historical/1's fixture". This hashes only the scalar function
body. Changes to constants, configuration or called helpers are caught when
they change a recorded output. Helper changes outside this corpus, new
behaviour behind inactive settings, and upstream changes to extremity or
count construction can pass: the test reuses recorded inputs and does not
replay the engine. A complete pipeline drift check is separate. The Delphi
Python check copies `tests/fixtures` into its container read-only and checks
it against `tests/fixtures/SHA256SUMS`; a missing or changed file fails. The
Rust check also requires the bound rule to be registered and to reproduce the
bound grid; each new rule needs an explicit parity evaluator. Fixtures are
added, never changed: `SHA256SUMS` may only grow, and only the binding may
move.
