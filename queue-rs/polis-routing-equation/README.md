# polis-routing-equation: how Polis chooses the next comment

## 1. What this is

Comment routing is how Polis chooses which comment a participant sees next.
This crate holds that choice as named, versioned rules with typed inputs, so
the equation can be read, changed under a new version, and compared, without
touching the code that serves participants.

It holds today's two rules and the candidates for the next equation:

- **`historical/1`**, today's equation: the weight the math engine (the Python
  `priority_metric` in `delphi/polismath/conversation/conversation.py`) gives
  each comment.
- **`stored-weights/1`**, today's draw: the weighted random pick the Node server
  (`selectProbabilistically` in `server/src/nextComment.ts`) and the Rust
  selector (`select` in `queue-rs/polis-api/src/next_comment.rs`) make from those
  weights.
- **Candidates**: `symmetric/1`, `symmetric-gic/1` (with the group-informed
  consensus factor in one of two forms, `gic-mean/1` or `gic-geomean/1`),
  `uniform/1` and `symmetric-gic-floor/1`, and the importance terms
  `importance-lift/1` and `importance-normalized-lift/1` (with the 2019 helper
  `issue217-voter-weight/1`). Sections 4 and 5.

**Nothing calls it.** It has no route, no database, no cache, no clock, no
logging, no switch and no randomness of its own: it is a library of pure
functions. No participant sees anything different because it exists.

**No rule here has been shown to be better for participants, and none is
chosen.** Which rule, and which parameters, Polis should use is a decision not
yet made. The crate exists so that the candidates can be read, and compared
honestly with today's equation.

**At a glance.** Today's equation is in section 3, in words and as a formula.

| Rule | What it changes from today | What it rewards |
|---|---|---|
| `historical/1` (today) | nothing | agrees more than disagrees; few passes; extremity (far from the centre of the opinion map, measured toward an agree); being new; all squared. Meta comments weigh 49 |
| `symmetric/1` | agree and disagree count alike: one "took a side" share replaces the agree and not-pass shares | taking a side, either side; passes are punished harder; extremity is still measured toward an agree |
| `symmetric-gic/1` | `symmetric/1` times 0.5 + G, group-informed consensus | agreement across opinion groups |
| `uniform/1` | every candidate has the same chance | nothing; a baseline |
| `symmetric-gic-floor/1` | a tenth of the chance spread evenly, the rest as `symmetric-gic/1` | as `symmetric-gic/1`, and every comment keeps a known share of the chance |
| with `importance-lift/1` or `importance-normalized-lift/1` | a scored comment's weight multiplied by a term from the importance marks | comments participants marked important (at most 3 times the weight under `importance-lift/1`) |

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
- **The latest counts** (`LatestCountFrame`, `src/latest.rs`): the group
  frame's counts summed over its groups, per comment, so the counts of the
  update being read rather than of the one before it. The two ways of reading
  base counts have names: `base-counts:lag-1` (the update before, today's
  equation and every `/1` rule) and `base-counts:lag-0` (the update read). The
  frame is made only from a group frame and carries that frame's source; it
  cannot be built from a list of counts, read from JSON, or turned into the
  lagged frame or back. A comment is present when any group has a count for it,
  even a count of zeros. Refused: a group frame with no groups (there are no
  latest counts), and any comment whose summed agrees, disagrees or passes go
  above 4,294,967,295; the whole frame is checked, including comments a rule
  would leave out. Defined: groups whose members have voted on nothing give a
  frame with no comments. The three `/2` rules (section 4) read it; nothing
  else does.
- **Everyone's frame** (`EveryoneFrame`): every participant's latest votes per
  comment, grouped or not. When both frames are given (`CurrentFrames`), the
  groups' agrees, disagrees and passes for each comment, summed over groups,
  must each be at most everyone's, and the groups' members at most the
  participants. The residual votes must fit the ungrouped participants too,
  including comments absent from all group cells. Declared participant totals
  must agree. A contradictory pair is refused.
- **Importance marks** (`Marks`, `CommentMarks`, `MarkTotals`, `GroupMarks`,
  `ImportanceMarks`): of the votes that could carry an importance mark, how many
  did, per comment, per group and comment, and for the whole conversation, each
  with its source and cohort. Per-comment marks and totals must come from one
  frame; both marked and eligible-but-unmarked sums must fit the totals.
  Group marks need the same cohort as pooled marks, must fit available pooled
  counts and totals, and need a group frame of their source. Missing per-comment
  marks remain unavailable, never zero. As with count frames, the caller
  certifies that differently labelled group and pooled sources share a tick.
- **The 2019 voter weights, aggregated** (`VoterWeightFrame`): per comment, the
  voters and the sum of their weights (each at least 1), and the totals over
  the whole conversation. Residual voters each require at least one residual
  weight; no residual voters means no residual weight, within the documented
  rounding slack. Validation reduces weight sums in sorted value order.

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
look at the participant. *For a scored comment with zero counts*, R = 1/2 and the weight is 81/16 x (1 + E)^2, the same as
today. An empty previous frame instead leaves every comment unscored, so
its draw weight is 1. As today, no votes is not the largest weight: at E = 0, three agrees (or
three disagrees, or any three votes that took a side) give 16.14. *Two groups or
five* make no difference: the counts arrive summed over the groups.

**The group-informed consensus factor, `gic-mean/1` and `gic-geomean/1`.**
Group-informed consensus is Polis's own measure of what holds across opinion
groups. `gic-mean/1` is the report's arithmetic mean of
(A + 1) / (A + D + 2) over groups with a cell for the comment. Passes do
not enter that fraction. An absent cell is left out; a present zero cell
contributes 0.5, as does a passes-only cell. With no cells, G = 0.5.
`gic-geomean/1` is the geometric mean of (A + 1) / (S + 2) over every
member group, with passes included in S and an absent cell filled as zero votes.
The engine's product uses the latter fractions over present cells. It has the
same ranking as this geometric mean when every comment has the same complete
group coverage, but a different magnitude; sparse missing cells can also
change the ranking. Neither factor is the product itself. The factor is
0.5 + G, between 0.5 and 1.5, so it lifts a comment most groups agree with and
lowers one that some group rejects, and never removes a comment. **It is not
symmetric in agree and disagree, by design:** it rewards agreement across
groups. Swapping agrees and disagrees gives exactly 1 - G in real arithmetic
for the arithmetic mean with unchanged cells. There is no complement identity
for the geometric mean: group fractions 0.9 and 0.1 give 0.3 before and after
swapping; passes further distinguish the forms. The order
groups arrive in and their ids cannot change a bit: the values are added in
sorted order. *A newcomer with no group:* the factor is a property of the
comment, the same for everyone. *On a conversation's first tick*, with no
groups yet (or one), the factor is exactly 1. *For a comment with no votes*,
every group's value is 1/2, so G = 0.5 and the factor is 1 mathematically
(the logarithmic implementation may round). With complete cells, each group
has equal weight in the arithmetic mean, or in the mean of logs for the
geometric mean. Missing cells change the arithmetic mean's denominator.
One dissenting group counts for more under the geometric mean: four groups at 0.9 and one at 0.1 give
G = 0.74 under the mean and 0.58 under the geometric mean.

**`symmetric-gic/1`** is `symmetric/1`'s weight times that factor (the
geometric mean by default; `consensus_form` chooses the mean). A comment
today's equation does not score keeps no weight here either, and the draw
gives it 1 without the factor; a meta comment weighs 49 without the factor, as
today (`meta_policy`). It is not symmetric: the count term is, the factor and E
are not. The default is an experimental parameter choice, not a production
selection. Both consensus forms are named explicitly in the complete parameter
form; changing the published default requires a new version.

`meta_policy = exclude` takes precedence over scoring readiness: every declared
meta id is excluded, even when absent from both scoring frames. A draw must
refuse any such id (the floor's draw does). The unscored-to-1 rule applies only
to other ids.

### The floor, the uniform rule and the stable draw

These exist for one purpose: an honest comparison of rules (an A/B test).
Such a comparison needs every admitted comment to keep a known, recorded
chance of being shown, and a receipt that reports that chance within the
stated numerical bound.

- **`uniform/1`** gives every candidate the same chance, 1/n. It reads no
  weights. It is the floor's lane on its own, and a baseline for replays.
- **The floor** (`symmetric-gic-floor/1`) mixes two lanes. A stated share,
  `floor_share` (default 0.1), of the chance is spread evenly over the
  candidates; the rest follows `symmetric-gic/1`'s weights. A comment's chance
  is

  ```text
  q_j = floor_share / n  +  (1 - floor_share) * w_j / W
  ```

  where n is the number of candidates and W the sum of their weights. In exact
  arithmetic every comment has at least `floor_share / n`: with two
  candidates weighing 1 and 3 and a floor of 0.1, the chances are
  0.05 + 0.225 = 0.275 and 0.05 + 0.675 = 0.725; a comment of weight 0 beside
  one of weight 2 still has 0.05. An unscored comment (a new one, in only one
  of the two frames) draws at weight 1, not multiplied by any factor, as the
  corrected equation was studied. In floating point the draw divides by the
  running sum T of all marginal scores. Its computed lower bound is
  `fl(fl(floor_share / n) / T)`; it need not be within four unit roundoffs of
  the mathematical floor. For 1,000 weights (999 zeros then 1), share 0.1,
  T is 1.0000000000000018 and the first chance is 0.00009999999999999983.
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
  is silently unreachable, and a small change in the normalised marginal scores moves the
  boundaries between comments only a little, so the outcome for a given random
  number changes only near a boundary that moved. It does not promise that
  the same random number picks the same comment after the weights change.
  This continuity statement assumes the same ordered candidate list and
  unchanged donation and acceptance branches. Inserting, removing or
  reordering candidates may move many intervals; numerical refusal thresholds
  can also change acceptance. Small absolute base-weight changes near zero
  mass can move probabilities greatly: [0, 0] donates and gives [0.5, 0.5],
  while [0, 5e-324] at share 0.1 gives [0.05, 0.95].
- **The receipt** reports, for the chosen comment, both lanes: each one's
  effective share after any donation, its normaliser (n, and W), and its part
  of the chance; the reported probability is the comment's true marginal
  chance under the mixture, `q_j` above, as computed (`d_j / T`, T the computed
  sum of the chances, with rounding that depends on the candidate count).
  Lane contributions are the pre-normalisation scores; their sum need not
  equal the reported probability bit for bit. No lane is drawn first:
  the draw is over the marginal chances, so the receipt never names "the lane
  it fell in".
- **What it rewards that today's equation does not:** nothing by itself; a
  positive, representable floor gives each admitted comment a positive
  chance on an accepted draw. It does not guarantee that a finite sequence
  of draws shows every comment. The floor is the same for every comment;
  the base rule determines the asymmetry.

### Importance (the checkbox on a vote)

Polis lets a participant mark a comment "important" as they vote. Three things
here use those marks; none is chosen.

- **`issue217-voter-weight/1`** is the formula of public issue #217 (2019):
  a marked vote weighs `(votes cast / comments) * (100 / marks used) + 1`,
  an unmarked one 1. Its worked numbers round correctly: 600 of 600 with 2
  marks gives 51; 300 of 600 with 2 gives 26; 10 of 600 with 2 gives 11/6
  (the issue's "1.83"); 300 of 600 with 150 gives 4/3 (the issue's "1.333").
  The issue multiplies the vote matrix by these weights; it does not say how
  routing should use them, so this is a helper, not a routing factor.
- **`importance-lift/1`**, the bounded pooled lift: with rho the
  conversation's own share of marked votes, a comment with M marks among n
  votes that could carry one gets `r = (M + k * rho) / (n + k)` (k = 20, the
  smoothing toward the conversation's rate) and the multiplier
  `clamp(r / rho, 1, cap)` (cap = 3). Example: rho = 0.06 and 5 of 10 marked
  gives 3.44, capped at 3; 1 of 10 gives 1.22; 0 of 10 gives exactly 1.
- **`importance-normalized-lift/1`**, the issue's weights adapted: a comment's
  mean voter weight over the conversation's mean, never below 1, with no cap
  unless one is given (a comment marked by the issue's heaviest voters can be
  lifted far: one witness is 26/7 = 3.71).

A term multiplies a scored comment's weight outside the power, and is named
with its parameters in the receipt (`symmetric-gic/1` with `terms`
`importance-lift/1`, inside what produced the weights). It never touches the
uniform floor, an unscored comment or a fixed meta comment. A comment with no
marks gets exactly 1; a conversation with no marks at all, or whose totals
are unavailable, gives every comment exactly 1, so the rule is its base rule
bit for bit (tested). **What a cap of 3 means:** at most three times the
comment's *weight*; because chances are normalised, it is never "shown three
times as often", and lifting others can lower this comment's chance. **The
denominator** is the votes the caller counts as able to carry a mark: where
the checkbox was not shown for part of a conversation's life, the caller
must leave those votes out of `eligible`; the crate cannot tell.

## 4. Each candidate rule, in plain words

None of these rules is chosen. Nothing calls them. No rule here has been
shown to be better for participants; they exist so that they can be compared
honestly with today's equation. The weighted candidates keep today's
unscored-to-1 fallback for comments present in at least one scoring frame;
missing counts do not by themselves identify a new comment. A scored
**meta** comment (one the moderator marks as being about the conversation
itself) weighs 49 under the default `meta_policy` (`fixed`). Exclusion takes
precedence over missing inputs. `uniform/1` instead reads only the candidate
list: it neither boosts nor identifies meta comments, so the caller must
filter any excluded comments first. Below, "the first tick" means an empty
previous-count frame and current extremities for the admitted comments.
Those comments are unscored and have equal draw weights; a floor plan refuses
an id absent from both frames. An adapter that instead supplies explicit zero
counts gets each weighted rule's no-votes weight (section 3 describes the
same choice for today's equation).

**Extremity is not symmetric in any rule here that reads it.** E, the stored
`pca.comment-extremity`, is how far from the centre of the opinion map a
participant would land who *agreed* with the comment and voted on nothing
else. Every rule here that uses E measures it that way; `uniform/1` ignores
it. The one that would
measure it the same way for agree and disagree, `symmetric-axis-gic-floor/1`,
needs the PCA's component loadings for each comment as an input, which no
frame of this crate carries yet; it is not built, and becomes a later piece
of work that first defines a frame for those loadings.

### `symmetric/1`: agree and disagree count alike

*In words:* today's equation, with the agree share and the not-pass share
replaced by one share, the share of votes that took a side, whichever side.
*Formula:* R = (A + D + 1) / (S + 2); weight = (R x R x (E + 1) x novelty)^2,
novelty = 1 + 8 x 2^(-S/5) as today. *What it rewards that today's does
not:* a comment people mostly disagree with is weighed like one they mostly
agree with (one disagree: 12.53 here, 3.13 today). It punishes passes harder
(R enters squared, then squared again). *Symmetric?* In the counts, exactly:
swapping A and D leaves the weight bit for bit the same. Not in E (above).
*A newcomer with no group:* the same weights as anyone. *On a conversation's
first tick* the previous frame is empty, so every comment is unscored and
drawn at 1 (uniform). *A scored comment with no votes* weighs
81/16 x (1 + E)^2, as today, and that is not the largest weight: three votes
that took a side give 16.14 at E = 0. *Two groups or five:* no difference;
the counts arrive summed.

### `symmetric-gic/1`: the same, times group-informed consensus

*In words:* `symmetric/1`'s weight, raised for a comment every opinion group
tends to agree with and lowered for one some group rejects. Group-informed
consensus is Polis's own measure, from 2012, of what holds across opinion
groups. *Formula:* weight = `symmetric/1`'s weight x (0.5 + G), G in section
5. The factor is between 0.5 and 1.5, so it never removes a comment.
*What it rewards:* agreement across groups. *Symmetric?* No, by design: the
count term is, the factor and E are not. *A newcomer with no group:* the
factor belongs to the comment, the same for everyone. *First tick:* every
comment is unscored and drawn at 1. *A comment with no votes:* every group's
share is 1/2, G = 1/2 and the factor is 1 mathematically (the geometric
implementation may round). *Two groups:* each group counts equally,
in the mean, or in the mean of logs for the geometric mean. *Five groups:* one dissenting group pulls harder under
the geometric mean (the default) than under the report's mean: four groups
at 0.9 and one at 0.1 give G = 0.74 under the mean and 0.58 under the
geometric mean. With fewer than two groups the factor is exactly 1.

### `uniform/1`: every candidate alike

*In words:* each candidate has the same chance, 1/n. *What it is for:* the
floor's lane on its own, and a baseline for replays. It reads no counts, so
it is symmetric in every sense, and the newcomer, the first tick, a comment
with no votes, and two or five groups all get 1/n.

### `symmetric-gic-floor/1`: the consensus rule with a floor

*In words:* a tenth of every draw's chance (`floor_share` = 0.1) is spread
evenly over the candidates; the rest follows `symmetric-gic/1`'s weights.
*Formula:* q_j = 0.1 / n + 0.9 x w_j / W, W the sum of the candidates'
weights (an unscored comment counts 1). *What it rewards:* what
`symmetric-gic/1` rewards, plus a guarantee: every comment keeps at least
`floor_share / n` of the chance, however low its weight (in exact arithmetic;
the computed bound is in section 3, under the floor). Two comments
weighing 1 and 3 get 0.275 and 0.725; a comment weighing 0 beside one
weighing 2 still gets 0.05. *Symmetric?* As its base: the floor is the same
for every comment. *Newcomer, first tick, no votes, two or five groups:* as
`symmetric-gic/1`, with the floor added; on the first tick every comment is
unscored, so the chances are 1/n in exact arithmetic; the computed
normalisation and the stated draw bound still apply. An excluded meta comment
(`meta_policy = exclude`) has no chance in either lane: a draw given one is
refused.

**Why the floor and the stable draw exist.** An honest A/B test needs every
comment to keep a known, recorded chance of being shown, and the chance on
the receipt to be the true one. At the default share, the floor supplies a positive part for every admitted
comment. A zero share supplies no floor, and an extremely small share can
round its uniform part to zero. The stable draw, `stable-cdf/1`, refuses to draw when a
positive chance would be too small to land on (below 2^-40 of the total) or
there is nothing to draw from, instead of silently dropping a comment as
today's arithmetic can. If every weight were 0, the weighted lane's share
would be given to the uniform lane and the receipt would record it
(`weights->uniform:zero_mass`); under this rule's parameter ranges that
cannot happen, and it is tested on the lane arithmetic itself.

### The `/2` rules: the counts of the update being read

Every rule above that reads counts reads them one math update late: the base
count term takes A, D and P from the update before the one whose extremity
and groups it reads (`base-counts:lag-1`), because that is what today's
Python does. The three `/2` rules are the same formulas, parameters, defaults,
decision tables and draws on the counts of the update being read
(`base-counts:lag-0`): A, D and P are summed over that update's opinion
groups, so counts, extremity and groups all come from one update. The policy
is fixed by the rule's id, never a parameter (`RuleId::count_policy`), and
the version number moved because what a parameter means moved: the base
counts are different counts. Both policies leave out participants in no
group, as the Python does.

The function signature decides the policy. A `/2` rule takes the group frame
and builds the counts itself (`LatestCountFrame`); it cannot be given a count
frame. The group frame and the extremity frame must name the same source, or
the rule refuses (`PolicySourceMismatch`); a frame with no groups has no
latest counts (`NoLatestCounts`), and a summed count above 4,294,967,295
anywhere in the frame refuses it (`CountOverflow`). Equal sources are a
consistency check, not proof: naming the update truthfully stays the
caller's, as it does for the `/1` rules.

**Where the two policies differ.** In the constructed witness (two groups,
ids 0 and 2; comments 7 and 8) the update before had one agree on comment 7
and one disagree on comment 8; the update read has (3, 2, 1) and (1, 2, 2).
`symmetric/1` weighs them 28.19 and 78.31, `symmetric/2` 14.30 and 16.66. The
group-informed consensus factor is the same under both (0.908 and 0.816; it
always read the update being read), and the floor's chances move from 0.31
and 0.69 to 0.49 and 0.51. The newest votes decide.

### `symmetric/2`: `symmetric/1` on the latest counts

*What it changes:* only which counts: R = (A + D + 1) / (S + 2) with A, D and
P summed over the groups of the update read. *A newcomer with no group:* the
same weights as anyone; their own votes are not in the sums until they are in
a group, as under `/1`. *On a conversation's first update* the counts are
there (unlike `/1`, whose previous frame is empty), so comments with votes are
scored from the start. *A comment no group has a count for* is unscored and
drawn at 1; a comment whose every group has a count of zeros is scored at zero
votes (81/16 x (1 + E)^2). *Two groups or five:* no difference; the counts
arrive summed, and the sums are exact, so the groups' order and ids change no
bit. *Symmetric?* In the counts, exactly, as `symmetric/1`; not in E. Its
receipt records the groups' source too, since its counts came from them.

### `symmetric-gic/2`: the consensus rule on the latest counts

*What it changes:* the base counts and G now come from the one group frame.
*Newcomer, first update, no votes:* as `symmetric/2`, times the factor (1 for
a comment with no votes, mathematically). *Two groups or five:* as
`symmetric-gic/1`: the factor weighs each group equally; with fewer than
`gic_min_groups` groups it is exactly 1. *Symmetric?* The count term is; the
factor and E are not.

### `symmetric-gic-floor/2`: the floor over `symmetric-gic/2`

*What it changes:* nothing in the floor: `floor_share / n` for every
candidate, the rest by `symmetric-gic/2`'s weights, drawn with `stable-cdf/1`.
Its plan accepts only `symmetric-gic/2` weights with its own base parameters,
and the `/1` floor accepts only `symmetric-gic/1` weights (`BaseMismatch`
either way); the plan takes computed weights and never rebuilds counts.
*Newcomer, first update, no votes, two or five groups:* as `symmetric-gic/2`,
with the floor added. Importance composes as on `/1`: `importance-lift/1` and
`importance-normalized-lift/1` read marks, not counts, and keep their own
source.

`stored-weights/1` can draw a `/2` map (`StoredWeights::from_latest`, for
`symmetric/2` or `symmetric-gic/2` weights with or without a term). It refuses
`/1` weights, which their floor draws, and weights with excluded comments,
which a stored map cannot tell from absent ones.

## 5. The terms

**Group-informed consensus, G, in two forms.** For each opinion group, the
group's share of agreement with the comment.
- `gic-mean/1`, the report's form: the mean over the groups that have a
  count for the comment of (A + 1) / (A + D + 2); passes do not enter; with
  no counts, G = 0.5. One group at 9 agrees and 1 disagree and a second group
  with no count: G = 0.833333. The second group present with zero votes:
  0.666667.
- `gic-geomean/1`, the form the corrected equation was studied with (the
  default): the geometric mean over every group of (A + 1) / (S + 2), passes
  counted in S, a missing count read as no votes. The same example gives
  0.645497.
- The math engine's own consensus multiplies the groups' shares over the
  groups present. It ranks comments like the geometric mean only when every
  comment has the same complete group coverage; with missing counts the
  ranking can differ. Neither form here is the product.
- Swapping every agree and disagree turns the mean's G into exactly 1 - G
  (same cells, real arithmetic). The geometric mean has no such identity:
  shares 0.9 and 0.1 give 0.3 before and after.

**Importance (the checkbox on a vote).** A participant can mark a comment
"important" as they vote. Public issue #217 (2019) proposed weighing a marked
vote by (votes cast / comments) x (100 / marks used) + 1, an unmarked one by
1. Its four worked numbers round correctly in `issue217-voter-weight/1`:
600 of 600 votes with 2 marks gives 51; 300 of 600 with 2 gives 26; 10 of
600 with 2 gives 11/6 (the issue's "1.83"); 300 of 600 with 150 gives 4/3
(the issue's "1.333"). The issue weighs the vote matrix; it does not say how
routing should use the marks, so that formula is a helper, and two routing
terms adapt it:
- `importance-lift/1`, the bounded lift: rho is the conversation's share of
  marked votes; a comment with M marks among n votes that could carry one
  gets r = (M + 20 rho) / (n + 20) and multiplier clamp(r / rho, 1, 3). At
  rho = 0.06, 5 of 10 marked gives 3.44, capped at 3; 1 of 10 gives 1.22; 0 of
  10 gives exactly 1.
- `importance-normalized-lift/1`: the comment's mean 2019 voter weight over
  the conversation's mean, never below 1, uncapped unless a cap is given (one
  constructed comment reaches 26/7 = 3.71; the heaviest voter in that
  example weighs 51, while the helper permits up to 101).
- A term multiplies a scored comment's weight. It never touches the floor, an
  unscored comment or a fixed meta comment. With no marks anywhere, or no
  usable totals, every multiplier is exactly 1 and the rule is its base rule
  bit for bit. A cap of 3 is on the *weight*: it never means "shown three
  times as often", because the chances are normalised and lifting other
  comments can lower this one's chance. The cap compares with the same base
  and no term: under two different patterns of marks, the weighted part of
  one comment's chance can differ by up to about 3 x 3 = 9 times (its
  multiplier rising from 1 to 3 while its competitors' fall from 3 to 1).
- The votes that "could carry a mark" are the caller's to count: where the
  checkbox was not shown for part of a conversation's life, the caller must
  leave those votes out; how to decide that is an open question.
- The helper rounds the exact fraction once, to the nearest double (ties to
  even), with integer remainders, for every count up to the largest 64-bit
  integer: it does not overflow, and it does not miss by one unit. The
  integers 51 and 26 are exact doubles; 11/6 and 4/3 are their nearest
  representable doubles.

**What is proven for these rules, and what is not.** Proven: each rule's
documented numbers (the hand examples above) as tests; two cross-checks
against statements of the formulas written again in NumPy from this README
(`vectors-3.json` for the corrected rules, `vectors-4.json` for the floor
and importance, both within 1e-12, section 9); the receipt's chance against
the draw itself, by bisection over every double, within 2^-50; frequencies
over 400,000 seeded draws; the symmetry of the count term (swapping A and D
is bit for bit the same) and the counterexamples to symmetry kept as tests,
including the floor rule's chances changing when every agree and disagree is
swapped; two weaknesses of the consensus factor kept as tests (a brigade
inside one fixed group lifts a comment, and splitting one group with no vote
changed moves G either way; `tests/counterexamples.rs`);
no panic over a deterministic corpus of awkward inputs. Not proven: that any
rule is better for participants; that a caller will feed the right tick's
counts in the right fields; anything about meta comments outside the
constructed cases. Nothing here is chosen, and nothing calls the crate.

## 6. The parameters

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

**`symmetric/2`**, **`symmetric-gic/2`** and **`symmetric-gic-floor/2`**: the
tables of `symmetric/1`, `symmetric-gic/1` and `symmetric-gic-floor/1`, with the
same defaults (listed in `tests/golden/defaults-manifest-5.json`). Only the
counts the defaults apply to differ: `base-counts:lag-0`.

The defaults of `symmetric/1`, `gic-mean/1`, `gic-geomean/1` and
`symmetric-gic/1` are listed in `tests/golden/defaults-manifest-3.json`, and
those of `uniform/1` and `symmetric-gic-floor/1` in
`tests/golden/defaults-manifest-4.json`. The first manifest,
`tests/golden/defaults-manifest.json`, is a published golden file and is never
edited, nor are the later ones; a test requires the files together to list
every rule exactly once.

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

## 7. Changing a parameter or a rule safely

**"A published rule never changes its numbers"**, in practice: once a rule
such as `historical/1` has its defaults listed in a manifest, its formula,
arithmetic order, parameter meanings and accepted ranges are frozen. Reusing
that name must preserve its specified behaviour. Bit-for-bit reproducibility
also depends on the floating-point environment, including the math library;
the numerical cross-checks use the tolerances stated in section 9. They do
not prove bit-for-bit equality on every input or future platform. Existing
receipt texts retain their canonical reader. The regression safeguards are: the golden files, the defaults manifests, the fixtures
and the recorded vectors are never modified, deleted or renamed (the check
of section 12 compares them with the base branch); `tests/fixtures/SHA256SUMS`
lists every fixture with its SHA-256 digest and may only grow; the tests
reproduce every recorded number; and every receipt in the first golden
receipt file still reads back unchanged.

**To try a different constant** whose new value is inside the parameter's
allowed range (section 6), nothing in the crate changes: it is a **parameter
set** under the same rule, for example `symmetric-gic-floor/1` with
`floor_share` 0.2 in place of 0.1. A parameter set is identified by the rule
and its **canonical plain form**: the JSON of section 6, every parameter
written out, keys in a fixed order. `ParamSet::is_default()` says whether it
is the published default. Every receipt names the rule and the complete
parameter set (and, for weights the crate computed, the rule and parameters
that produced them), so a receipt from that arm says `"floor_share":0.2` and
differs from a default receipt even where every drawn number is the same.
Which participants were given which parameter set is recorded by the caller
that stores the receipts; no caller exists yet. The agreement with today's
Python equation (section 9) is promised at the defaults only. An A/B arm is
a parameter set, not a new rule.

**A new version** (`symmetric-gic-floor/2` beside `symmetric-gic-floor/1`) is
needed to change a rule's formula, a default, a parameter's meaning, or its
allowed range (whether narrower or wider). The
old version stays registered with its numbers, files and tests untouched;
the new one gets its own manifest entry in a new manifest file, its own
fixtures and its own tests. A change to the Python formula is a new version
of `historical`, with its grid made once by the real Python function, and
the binding moved in the same change (section 12). The accepted domain is
part of what a rule name promises, including its refusals. Old receipts keep
their reader: a new rule shape adds a receipt form, it
never rewrites the old ones.

None of this chooses anything. Which rule and which parameter set Polis
should use is a decision not yet made.

## 8. How to add a rule

A new rule (a new candidate, or a new version of an old one) arrives in one
change with all of the following:

1. **The formula**, in words and as a formula, written down before the code:
   what it changes from today's equation, what it rewards, whether it is
   symmetric in agree and disagree (and, if it reads E, that E is measured
   toward an agree), and what it does for a newcomer, on the first tick, for a
   comment with no votes, and with two and with five groups.
2. **Its parameters**, each a named, typed field with a default, an allowed
   range, a meaning and a source, built only through the constructor that
   refuses a value out of range (`ParamError` names the parameter, the value
   and the range), and written in the canonical plain form. The rule gets a
   name with its version (`name/1`) as a new variant of `RuleId`, a closed
   list: the compiler then points at every place that must handle it.
3. **Its entry in the registry** (`registry::describe`): the summary, the
   formula and the parameter table. Section 6 of this README is generated
   from it, and a test fails if the README's table differs.
4. **Its manifest entry**: its default parameter set in a new file
   `tests/golden/defaults-manifest-N.json`. Earlier manifests are never
   edited; a test requires every rule to be listed exactly once across them.
5. **Fixtures or vectors from an independent generator**: a script written
   from the formula, not from the Rust (NumPy, or the real Python function
   when the rule exists in Python), whose output the Rust test reproduces
   within 1e-12, exact zeros exact. The script and its output are new files
   under `tests/fixtures`, appended to `SHA256SUMS`; an existing generator is
   never edited.
6. **Its properties**, each checked against the formula before it is
   written: algebraic statements for real numbers, non-strict checks over
   grids for floating point with strict examples at well-separated values,
   and the counterexamples to what the rule does not promise kept as tests.
7. **Its mutations**: a constant or an operator in the rule's code changed
   on purpose, the tests shown failing, the change reverted, and the list
   written down where reviewers can see it.
8. **No panic**: its constructors and entry points added to the corpus of
   awkward inputs (`tests/no_panic.rs`).
9. **Its README paragraph**, in the form of section 4, and any term in the
   form of section 5.
10. **The binding**, only when the Python engine is to match the rule:
    `tests/current_python_binding.rs` handles every `RuleId` explicitly, so a
    new weight-producing rule adds its own evaluator there; the binding
    (`tests/fixtures/CURRENT_PYTHON_RULE`) moves only in a change that also
    changes the Python formula.

**What the checks refuse** (section 12): code that is not formatted or that
clippy warns about; a modified, deleted or renamed file under `tests/golden`
or `tests/fixtures`; a fixture missing from `SHA256SUMS` or not matching its
digest, or a digest removed; a README parameter table that differs from the
registry; a rule missing from the manifests or listed twice; anything under
`src/` that reaches files, the network, the clock, the environment, threads,
processes, output or global state; a dependency other than `serde` and
`serde_json`, or another crate in the workspace depending on this one; a
binding that does not name an implemented weight-producing rule reproducing
its grid. Separately, the repository's vote-sign lint
(`make check-vote-sign-lint`) refuses any new comparison against a literal
vote value.

## 9. What is proven, and how to see it

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
`tests/crosscheck.rs` compares weights, factors and probabilities within
1e-12; the largest differences found are 1.9e-16 (factors and weights,
relative) and 5.6e-17 (probabilities). A change of 1e-11 to the novelty or the
factor, or of 1e-10 to one recorded number, turns it red. The floor, importance and zero mass are in a second
file: `make_crosscheck_4.py` writes `vectors-4.json` (11 rule cases, 7 lane
cases), and `tests/crosscheck_floor.rs` reproduces all 385 numbers within
1e-12 (largest difference 1.6e-16).

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
within five standard errors of the reported chance, and each returned
probability is checked against the expected value. This is a coarse check:
at q = 0.5 the five-error allowance is about 0.004; the bisection check is
what tests the 2^-50 numerical claim. Also: each computed chance includes
the uniform floor divided by the computed total; the uniform lane's parts add up to the
floor share; the stable draw refuses no mass, a total below 2^-1021, and a
positive chance below 2^-40 of the total, where today's arithmetic would
silently absorb it; an excluded meta comment is refused whether scored, in one
frame or in neither; receipts read back byte for byte, and altered ones are
refused. `tests/golden/receipts-2.txt` records the first receipts of the new
shapes (and of the earlier shape with no map and with the engine's map); every
receipt of the first golden file still reads back unchanged.

### The latest-count rules

`tests/latest_rules.rs` proves the `/2` rules four ways. On every input both
policies admit, a `/2` rule equals its `/1` rule given a count frame holding
exactly the group frame's sums: weights and explanations bit for bit, the same
unscored and excluded comments, the same floor chances (400 constructed
conversations, all three meta policies, both consensus forms, default and
other parameters). With identical cells the draws are bit for bit the same and
the receipts differ only where they should: the rule names, `input_policy`,
`latest_counts` in place of `previous_counts`, and the sources. An independent
statement in plain Python (`tests/fixtures/crosscheck/make_crosscheck_5.py`,
run with `python3 -I`; its output `vectors-5.json`) agrees to 1e-12 on twelve
constructed cases, the witness among them, with `/1` and `/2` asserted
different there. Renaming and reordering groups changes no bit.
`tests/sequence_latest.rs` is the floor's request-sequence test, copied for
`symmetric-gic-floor/2` rather than assumed from `/1`. The recorded `/2`
receipts are `tests/golden/receipts-5.txt`; every `/1` receipt keeps its bytes.

## 10. What it does not do

No HTTP route or handler; no database, SQL, pool or connection; no cache or
global state; no schedule, job, table or migration; no clock; no logging or
printing; no feature, switch, environment variable or configuration file; no
randomness of its own (the caller passes the unit); no network, model call or
file reading at run time. It changes nothing in the Node server, the Rust
selectors or the Python math engine. The corrected rules (agree and disagree
weighed alike, group-informed consensus, a uniform floor, importance) are here
only as named candidate rules; none is chosen for anything, and nothing calls
them.

## 11. The vote sign

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

## 12. How to run the checks

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
