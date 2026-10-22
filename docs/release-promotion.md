# Preparing and publishing a Polis release

Nothing here dispatches on a push, tag or stable merge. Deployments keep their
existing gates; publishing a release does not deploy it. These workflows require
the shared root VERSION/build identity and `polis-version` compute tool first.
The canonical-tag CLI updater must also be on the promoted source before a
publication plan is accepted. An older updater needs the explicit verified
artifact installation described in [CLI releases](../polis-cli/docs/releases.md).

## Repository setup

An administrator must create the **release** GitHub environment, set **Colin's
GitHub user as its sole required reviewer**, and disable administrator bypass
in the settings UI. The public REST environment response does not expose that
bypass setting.
Set the repository variable `POLIS_RELEASE_REVIEWER` to that same login. Both
planning and publication read the environment configuration and refuse if the
reviewer is missing, different, a team, or accompanied by another reviewer.
The publisher also checks this run’s review history for an explicit approval
by that reviewer. YAML alone cannot configure reviewer protection. Do not
dispatch publication until these settings are verified. Approval is a separate
explicit action even when the approver dispatched the workflow himself.

Enable Actions' permission to create pull requests. Preparation gets contents
and pull-request write permission solely for the version branch and PRs; it has
no release command. Protect edge/stable against unreviewed merges, and use a
merge commit for edge-to-stable promotions. The publication workflow and its
reusable builder have read-only permissions until the final `publish` job.
That single writer uses `environment: release`. Both entry workflows share a
non-cancelling concurrency group to avoid concurrent preparations/publications.
Do not run a manual publication in parallel with it.

## Prepare the version and promotion

Dispatch **Prepare Polis promotion** (`polis-promotion-prepare.yml`) from **edge**
with `candidate` equal to the full, current edge SHA. The script validates current
edge/stable and the complete tag inventory. It calls `polis-version plan` with
`effective-selection`: newly selected release.txt migrations give a minor;
otherwise a patch. MAJOR is never selected here. Before the first canonical tag,
the tool's reviewed history supplies the baseline; after that the previous
stable head must have its canonical tag. No missing release is skipped.

The workflow invokes `plan --write`, which changes root VERSION locally, and
prepares the two generated CLI Cargo version mirrors without altering dependency
versions. It creates a deterministic branch and a review PR against edge with
only those metadata changes. Repeating the same candidate reuses the branch and
updates the PR body; it refuses to overwrite anyone's edits. A different
candidate gets a distinct branch/PR: close superseded preparation PRs after
review. A PR opened with the workflow token does not automatically trigger
other workflows: explicitly dispatch the existing CLI CI on its preparation
branch and satisfy required checks before merging. Existing PR prose outside the marked release-plan section is preserved.

It also creates a draft edge-to-stable promotion PR, or updates its marked body
section with the computed number, reason, exact release.txt additions and input
SHAs. Merge the version PR through normal review, then **dispatch preparation
again with the new edge SHA**. When the metadata already matches, no version PR
is needed; only the promotion plan is refreshed. Review the refreshed promotion
and merge it with a merge commit. There is no automatic PR merge or deployment.
A wrong version, unexpected stable-only merge content, moved stable head or
missing canonical updater will fail publication validation.

## Review and publish

Dispatch **Publish Polis release** (`polis-release.yml`) from **edge**, with
`stable_commit` equal to the full current stable merge SHA. It verifies the two
parents, the exact source tree, the number computed from previous stable to the
promoted source, unchanged shipped SQL (through the compute tool), and version
mirrors. It snapshots PR associations and titles, including explicit commit
entries for changes without exactly one verified PR association. Preparation
PRs changing only version metadata and the enclosing promotion are excluded
from change bullets; the promotion remains linked in the header.

The reused native matrix builds four archives and four SHA256 files:

- `polis-VERSION-COMMIT12-aarch64-apple-darwin.tar.gz[.sha256]`
- `polis-VERSION-COMMIT12-x86_64-apple-darwin.tar.gz[.sha256]`
- `polis-VERSION-COMMIT12-x86_64-unknown-linux-gnu.tar.gz[.sha256]`
- `polis-VERSION-COMMIT12-aarch64-unknown-linux-gnu.tar.gz[.sha256]`

Each build first validates the stable source, then creates a **local-only** tag
in its disposable checkout so the shared identity embeds the stable version and
zero distance before any public tag exists. It never pushes that tag. Artifact
names, archive layout, checksums, target set and updater validation are retained;
the builder reads root VERSION. A missing or failed target blocks publication.

Before the environment prompt, the plan/review job summaries and
`polis-release-review` artifact show:

- previous release/tag (or bootstrap stable SHA), exact stable/source SHAs;
- computed version, reason, migration filenames, and `schema: yes/no`;
- promoted public PR titles/links and direct-commit exceptions to review;
- the complete eight-asset SHA256 inventory and equivalent manual commands.

Colin opens the run linked by the environment prompt, reviews these records and
approves **release**. The final job downloads only this run's artifacts and
revalidates source, tags, notes and asset contents after the wait. It creates
one immutable annotated `vMAJOR.MINOR.PATCH` tag targeting the stable merge, creates a draft
**Polis VERSION** release with the prepared notes, uploads all eight assets,
then publishes it as latest. GitHub's generic generated notes are not used:
our deterministic notes contain the verified promoted PR titles, migration
filenames and explicit schema line. Releases are source-shipment records,
not evidence that database migrations ran or production deployed.

Use a fresh manual dispatch for retry; rerunning an old run is refused so an earlier approval cannot be reused. A matching existing public release is a no-op only after comparing its title,
notes, tag object type, exact annotation, stable target and every downloaded asset byte. Different assets/notes or a
conflicting tag fail; nothing is overwritten. A partial draft is deliberately
held for explicit review/cleanup, not silently completed. A failed upload leaves
a draft. Retain the original run artifacts for retry. Moving stable or changing
PR titles after review invalidates the packet and needs a fresh plan/approval.
Only current stable can be newly published; older stable deployment remains a
redeploy using its existing number. This is the edge-promotion path, not a
separate hotfix/major/backfill publisher.

## Prepared manual commands

Build `polis-version` from `queue-rs`, use a clean checkout at the exact stable
commit with full history/tags, and retrieve the four verified native artifacts.
Use a packet/output directory **outside** the checkout:

```sh
python3 scripts/polis_release.py plan --repository OWNER/REPO \
  --stable FULL_STABLE_SHA --tool /path/to/polis-version --output /path/to/review
python3 scripts/polis_release.py commands --stable FULL_STABLE_SHA \
  --packet /path/to/review/publication.json --assets /path/to/assets \
  --tool /path/to/polis-version
```

Both publication paths use the same annotation: Polis version, previous tag (or
bootstrap stable SHA), stable merge SHA, source SHA, public promotion PR URL,
`schema: yes/no`, and the exact newly shipped migration filenames (`none` for a
patch). Git stores that text in an annotated tag object whose target is the
stable merge commit. Existing lightweight tags, different annotations or targets
are refused, even when the peeled commit matches; they are never replaced.

The second command validates and **prints** exact shell-quoted `git tag`,
`git push` and `gh release` commands; it does not execute them. Colin reviews
and runs the prepared commands explicitly as the alternative to the workflow.
Run the printed verification immediately before tag/push; if a matching tag
already exists, verify it and omit those two commands. Do not reuse a stale
packet or overwrite a partial/published release. Anyone with direct repository
write rights remains responsible for following the manual approval procedure;
the environment protects the workflow job, not arbitrary local gh commands.

## Verification

Run the same hosted CLI entry on a work/test machine:

```sh
bash scripts/test-polis-cli.sh
```

It includes `test_polis_cli_release*.py`: archive/provenance, shared identity,
publication and promotion orchestration against generated repository/API state.
The compute tool retains its existing Cargo test/fmt/Clippy entries. No test
needs live GitHub writes, a database, a deployment, or a participant request.
Publication adds no serving hook, DB connection, pool, lock, permit or queue.
