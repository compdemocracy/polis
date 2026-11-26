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
restores what was written; it does not re-run the draw. The weights in a
receipt that come from the math engine are as trustworthy as the math result
they were read from, and no more.

Where this crate refuses, it gives no receipt and says why: an empty or
repeated candidate list, a unit outside [0, 1), a stored weight that is
negative or above 1e150, or a total below 2^-1021. Today's read route would draw
a negative weight; a probability cannot be negative, so this rule refuses
instead. The caller then draws its own way, and its receipt must name the rule
that actually drew.

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
the right fields. Recorded replays of the public conversations, and a Python
test that fails when the Python formula changes without this crate following,
are the next piece.

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
