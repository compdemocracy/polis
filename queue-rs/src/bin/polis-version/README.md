# Computing a Polis release number

`polis-version` is an offline repository tool in the existing queue adapter
package. It uses that package's toolchain and dependencies and is included in
its normal unit-test and Clippy commands. The promotion preparation and
publication workflows invoke it read-only, with `plan --write` also used during
preparation. No serving process invokes it. It opens no database or network connection and never applies
migrations, creates commits or tags, or publishes releases.

Build from `queue-rs`:

```sh
cargo build --locked --bin polis-version
```

Supply a local repository with complete stable/source history and all published
canonical version tags. The caller is responsible for refreshing those inputs;
the tool does not contact a remote. Shallow repositories and replacement objects
are refused. Full immutable commit IDs are preferable to moving branch names.
The default repository is the current directory and default stable ref is
`origin/stable`. Repository paths may point to bare repositories for read-only
commands.

```sh
# Print a proposed number and the release.txt filenames responsible for it.
queue-rs/target/debug/polis-version plan --repo . \
  --stable origin/stable --candidate origin/edge

# The same computation as structured JSON, without changing files.
queue-rs/target/debug/polis-version plan --repo . \
  --stable origin/stable --candidate origin/edge --json

# A source branch that incorporates current stable uses the same bump rule.
queue-rs/target/debug/polis-version plan --repo . \
  --stable origin/stable --candidate hotfix --kind hotfix --json

# Reusing an older stable artifact keeps its known number; allocates nothing.
queue-rs/target/debug/polis-version plan --repo . \
  --stable origin/stable --candidate v2.38.1 --kind redeploy --json

# Extend the built-in historical seed along stable's first-parent lineage.
queue-rs/target/debug/polis-version history --repo . --stable origin/stable --json

# Explicit alternative interpretation of the historical manifest transition.
queue-rs/target/debug/polis-version history --repo . --stable origin/stable \
  --rule literal-manifest-lines --json
```

Paths above assume Cargo's normal target directory; respect `CARGO_TARGET_DIR`
when it is set. Text goes to stdout by default; `--json` emits one JSON document
instead. Diagnostics go to stderr with a nonzero exit status. Redirect stdout
to retain a plan or history. Output contains no current time or local paths;
repeating a command against unchanged inputs produces identical bytes.

## Rules

The `effective-selection` rule increments MINOR and resets PATCH to zero
when the candidate adds one or more selected migration filenames. Otherwise it
increments PATCH. It never increments MAJOR. The number comes from the last
canonical `vMAJOR.MINOR.PATCH` tag on the stable first-parent lineage, never from
the working tree's VERSION value. Tags must increase along that lineage, cannot
assign two numbers to one commit, and the latest must identify the given stable
head. A pending untagged promotion after a release tag must be completed before
another number is allocated. Tags outside that lineage are refused.

Only exact nonblank, noncomment filename lines are selected. Whitespace within
a filename, duplicate migration numbers, missing selected files and nonregular
migration files are errors. Reordering or comments do not count. Files held out
of the manifest do not count until selected. Adding a migration and removing it
again before the final candidate does not ship it. Data-only migrations follow
the same rule. Prospective releases refuse removal, renaming or any byte change
to a previously selected SQL file; Git blob identities check the exact bytes.
A prospective release must have a manifest.

For ordinary promotions, the current stable tree must equal its source parent's
tree and the candidate must retain that source ancestry. Those conditions make
the candidate tree the promotion result without running a merge or writing Git
objects. Stable-only changes must first be reconciled. A hotfix must descend
from the current stable commit. Both kinds reject empty or preparation-only
promotions. Preparation includes root VERSION and the generated version lines
in `polis-cli/Cargo.toml` (`[workspace.package].version`) and `polis-cli/Cargo.lock`
(the local `polis` and `polis-client` package versions). The shared contracts
package is independently versioned and is not ignored. Only canonical quoted
version lines in the existing generated layout are normalized; unfamiliar
layouts remain substantive. Other bytes, dependency/build changes, additions,
deletions and file-mode changes still count. The tool does not regenerate these
mirrors. A committed revert is new code and follows the same rule; a redeploy
of a known stable first-parent commit retains its original number. Later
forward plans still use the latest stable head, independent of what is serving.

Named refs and the tag inventory are rechecked before output or writing. The
future promotion caller must bind its approval to these inputs and revalidate
them before merging/publishing. This tool does not authorize those operations.

## JSON contracts

All fields below are always present; nullable fields use JSON `null`, never an
omitted key. Versions are canonical `MAJOR.MINOR.PATCH` strings, not numbers.
Commit/tree/blob identities are full Git object ID strings. A `rule` is either
`effective-selection` or `literal-manifest-lines`. Filename arrays are sorted
and contain migration basenames. PR numbers and counts are unsigned integers.
These schema identifiers and exact keys are covered by serialization tests.

`polis.release-plan/1`:

| Field | JSON type | Meaning |
|---|---|---|
| `schema` | string | Exactly `polis.release-plan/1`. |
| `rule` | string | Selected counting rule. |
| `kind` | string | `promotion`, `hotfix`, or `redeploy`. |
| `version` | string | Computed number; original number for redeploy. |
| `previous_version` | string | Latest stable number, also for redeploy. |
| `bump` | string | `minor`, `patch`, or `none` (redeploy). |
| `reason` | string | Human-readable explanation; use `bump` for branching. |
| `release_lines` | array of strings | Added filenames counted by the selected rule; empty for patch/redeploy. |
| `previous_stable_commit` | string | Resolved latest stable commit. |
| `candidate_commit` | string | Resolved proposed source or redeploy target. |
| `previous_tree` | string | Stable tree object ID. |
| `candidate_tree` | string | Candidate tree object ID. |
| `previous_manifest_blob` | string or null | Stable manifest blob; null if absent. |
| `candidate_manifest_blob` | string or null | Candidate manifest blob; null if absent (historical redeploy). |
| `previous_tag` | string or null | Canonical latest stable tag; null during bootstrap. |
| `new_number` | boolean | True for promotion/hotfix; false for redeploy. |

`polis.release-history/1`:

| Field | JSON type | Meaning |
|---|---|---|
| `schema` | string | Exactly `polis.release-history/1`. |
| `rule` | string | Selected counting rule. |
| `seed_sha256` | string | Lowercase 64-hex SHA-256 of exact seed input bytes. |
| `promotions` | array of objects | Seed row first, then chronological first-parent promotions; row fields below. |

Each promotion object:

| Field | JSON type | Meaning |
|---|---|---|
| `version` | string | Number after this promotion, or supplied seed number. |
| `previous_version` | string or null | Prior row's version; null only on the seed row. |
| `date` | string | Git committer ISO 8601 timestamp, including offset. |
| `stable_commit` | string | Stable promotion commit. |
| `source_commit` | string | Promotion's second parent. |
| `migrations_shipped` | array of strings | Actual additions to effective selection, even when using literal counting. |
| `bump_lines` | array of strings | Added filenames under the chosen rule; empty on the seed row. Can differ from `migrations_shipped`. |
| `migrations_removed` | array of strings | Effective selections removed since the preceding endpoint. |
| `bump` | string | `seed` on the first row, then `minor` or `patch`. |
| `selection_evidence` | string | Committed manifest or recognized historical initializer identity. |
| `manifest_blob` | string or null | Manifest blob ID; null before a manifest exists. |
| `promotion_pr` | integer or null | Public enclosing promotion PR from Git subject; null if unrecognized. The seed requires a number. |
| `pr_count` | integer | Length of `prs`. |
| `prs` | array of integers | Sorted unique source-range PR subject references, excluding the enclosing promotion. |

The seed row records its actual migration additions/removals relative to its
first parent and its source-range PRs. Its version is supplied, not recomputed:
`previous_version=null`, `bump="seed"`, `bump_lines=[]`. A nonempty
`migrations_shipped` on that row does not allocate another number.

Seed input (`polis.release-seed/1`); every field is required and non-null,
and unknown keys are rejected:

| Field | JSON type | Meaning |
|---|---|---|
| `schema` | string | Exactly `polis.release-seed/1`. |
| `version` | string | Trusted historical baseline number. |
| `stable_commit` | string | Full stable promotion commit on the supplied lineage. |
| `source_commit` | string | Full second-parent commit, verified against Git. |
| `date` | string | Exact Git committer ISO 8601 timestamp, verified against Git. |
| `promotion_pr` | integer | Public promotion PR number, verified against the Git subject. |

## Bootstrap history

`src/bin/polis-version/seed.json` contains the normalized terminal historical
baseline: `2.34.0` at stable commit
`fd16f790a01d433aa338c06aea77499cf39b9944` (PR #2957). Its source parent, commit
date and public promotion number are checked against Git. This is a supplied
baseline, not a reclassification of the releases preceding it. `--history PATH`
can supply a seed of the same strict `polis.release-seed/1` format. A seed is a
trusted numbering input: its number is not inferred from SQL or VERSION.

The history command returns the seed row followed by one row per two-parent
first-parent promotion. Each row includes version, previous version, date,
stable and source commits, actual newly selected migrations, counted bump
lines, removed selections, selection evidence, manifest blob, public promotion
PR, and unique PR references/count from merge or squash subjects in the newly
promoted source range. The seed row's bump is `seed`; it does not allocate a new
number. The result includes the SHA-256 of the exact seed bytes. PR counts
exclude the enclosing promotion PR. They describe Git subject references;
release-note publication should resolve GitHub associations and handle direct
commits with no PR reference explicitly.

Before a manifest exists, effective selection requires the historical
`server/Dockerfile-db` rule copying root migration SQL into the initializer.
Down/archive directories are excluded. An unrecognized or ambiguous rule stops
the walk. A manifest's first appearance compares against that established set,
so relisting old SQL does not count as new. Historical removal/reintroduction
records what each endpoint selected; it does not relax prospective validation.

The alternative `literal-manifest-lines` rule counts only additions relative to
the previous manifest (absent manifest = no lines). Actual selected additions
remain separately available in `migrations_shipped`; `bump_lines` explains the
number under the chosen rule. Both walks preserve the same seed. Through
`d2da302d0f94fb29fa0e7fde27299509c6f5f28b`, the 34 subsequent promotions yield
`2.41.0` (effective: seven minor, 27 patch) or `2.40.0` (literal: six minor,
28 patch). Omitting `--rule` selects the single `DEFAULT_RULE` constant in `model.rs`;
the help output prints its configured value. Both explicit flags override it.
These computations neither create historical tags nor claim old binaries
embedded these numbers. Once tags exist, prospective computation uses them.

## Writing VERSION

Only `plan --write` writes anything. It requires a nonbare checkout at the exact
candidate HEAD, clean except for VERSION, and a regular root VERSION file.
It atomically replaces that file with the computed number and a newline,
preserving permissions. A previous abandoned VERSION edit is overwritten from
the stable baseline; it never reserves a number. No Cargo mirror is changed by
this tool. The preparation workflow's `scripts/polis_release.py prepare --open-pr`
writes `VERSION`, `[workspace.package].version`, and the `polis`/`polis-client`
versions in `Cargo.lock` together; a VERSION-only preparation makes publication
refuse. See [release preparation](../../../../docs/release-promotion.md).
`history --write` and `--kind redeploy --write` are refused. Without `--write`,
even a plan run inside a dirty checkout is read-only and uses committed inputs.

## Verification

The ordinary existing CI entries from `queue-rs` include this binary:

```sh
cargo test --locked
cargo clippy --locked --all-targets -- -D warnings
cargo clippy --locked --all-targets --features jobs-integration -- -D warnings
cargo fmt -p polis-queue-adapter --check
```

The full-history regression is explicitly opt-in because ordinary hosted source
checkouts are shallow. It fails if the history variable is absent or incomplete;
it does not silently skip cases. It verifies both real bootstrap walks, the
manifest transition and committed rollback, patch/minor hotfix computation,
redeploy/next-forward behavior, rejected ancestry, seed validation, and repeated
JSON identity:

```sh
POLIS_VERSION_TEST_REPO=/path/to/complete/polis \
  cargo test --locked --bin polis-version -- --ignored --nocapture
```
