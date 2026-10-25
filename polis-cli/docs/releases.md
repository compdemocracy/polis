# Building, installing and updating the CLI

`polis --version` prints the installed build version, full source commit and
source status. The CLI is a client of Polis and follows the Polis release version.
The shared build identity supplies root `VERSION` as `POLIS_VERSION_BASE`, plus
commit and distance for development display. Until that identity is available,
the updater compares the version embedded from `polis-cli/Cargo.toml`. It never
reads a version from the configured site or a runtime environment variable. An ordinary Cargo build without metadata says `commit unknown;
development`. A native artifact built by the release script says
`clean-checkout`; an explicitly declared archive rehearsal says
`unverified-archive`. These are build descriptions, not signatures or proof of
publisher identity. Run `command -v polis` (or `type -a polis`) if an older binary
still appears after an update.

## Build review artifacts

From a clean repository root with Python 3.11+ and Rust installed:

```sh
bash scripts/test-polis-cli.sh
python3 scripts/build-polis-cli-release.py \
  --target aarch64-apple-darwin --output /tmp/polis-cli-release
```

Use the target matching the native host: `aarch64-apple-darwin`,
`x86_64-apple-darwin`, `x86_64-unknown-linux-gnu`, or
`aarch64-unknown-linux-gnu`. The script uses the repository's pinned Rust
toolchain, `cargo build --locked --release`, and the actual Cargo target directory.
It builds the production binary without fixture features, checks version/help,
and refuses modified or untracked build inputs. It never publishes or installs.

The **Build Polis CLI release assets** reusable workflow uses these same commands
on native macOS and Linux runners. It is called only by the manually dispatched
Polis publication workflow; there is no tag-push publisher. It adds
`--release-tag vX.Y.Z --release-commit FULL_SHA`, which makes the script refuse
unless the binary prints exactly
`polis X.Y.Z (commit FULL_SHA; distance 0; clean-checkout)`. Artifacts expire
after 14 days and remain review inputs until the approved publication job
validates all eight files. All target jobs must pass. A passing
ARM64 Mac build alone does not qualify
Intel or Linux. GNU/Linux binaries use the runner's glibc and are not promised
to work on older distributions. A source build remains available there. Mac
archives are unsigned unless a distributor separately signs and notarizes them;
no signing identity is supplied here.

Archive names contain version, abbreviated commit and target. Each archive has
one named directory containing `polis`, `manifest.json`, `LICENSE`, and
`README.txt`. The manifest records full commit, target, version, compiler,
source status, lockfile SHA256 and binary SHA256. An adjacent `.tar.gz.sha256`
file covers the archive. Member metadata and gzip timestamps are normalized;
bit-identical binaries across SDKs or operating system images are not promised.
Existing artifact paths are never overwritten.

For an uncommitted source archive, the builder requires both
`--source-commit FULL_BASE_COMMIT` and `--allow-unverified-source`. This explicitly
records a declared base, not verified source equality. The name includes
`-unverified`, and the manifest and binary identify the rehearsal. Do not publish
that output as a clean release. For ordinary development, use Cargo directly.

## Install or replace an explicitly selected artifact

Download the archive for your OS and CPU and its expected checksum from your
trusted distributor. For a first installation, select and verify an archive explicitly.
A checksum verifies bytes against that expected digest; it does not authenticate
the distributor on its own. In the download directory:

```sh
# Use the exact downloaded checksum filename; substitute your chosen artifact.
shasum -a 256 -c polis-VERSION-COMMIT12-TARGET.tar.gz.sha256
mkdir unpacked
# Substitute the same exact filename; unpack into the new directory.
tar -xzf polis-VERSION-COMMIT12-TARGET.tar.gz -C unpacked
```

Inspect the manifest and run the unpacked `polis --version` before installation.
The version/commit/target must match the version you selected. Then, from the
unpacked artifact directory, install into a directory you own on PATH:

```sh
mkdir -p "$HOME/.local/bin"
# If replacing an existing binary, first save it under a new backup filename.
# Stop if that backup filename already exists.
test ! -e "$HOME/.local/bin/polis.prev" || exit 1
if test -e "$HOME/.local/bin/polis"; then
  cp -p "$HOME/.local/bin/polis" "$HOME/.local/bin/polis.prev"
fi
install -m 755 ./polis "$HOME/.local/bin/polis.new"
"$HOME/.local/bin/polis.new" --version
mv -f "$HOME/.local/bin/polis.new" "$HOME/.local/bin/polis"
"$HOME/.local/bin/polis" --version
```

Add `$HOME/.local/bin` to PATH if necessary, then check `command -v polis` and
`polis --version` in a new shell. This procedure changes only the executable;
profiles and credential files remain in their existing locations. Keep the
backup until the replacement works. To roll back, explicitly restore that saved
binary and verify its version. No sudo, credential transfer or server mutation
is required.

## Update the installed CLI

```sh
polis --version
polis update
polis update --json
# Use a distributor's compatible release API instead of the default:
polis update --release-base-url https://releases.example.org/cli/releases
```

`polis update` is explicit; no update requests run during sign-in, reads, votes,
comments, or any other command. It does not load profiles or credentials, and
`--site` does not select the software distributor. The release source is the
`--release-base-url` flag, then `POLIS_RELEASE_BASE_URL`, then
`https://api.github.com/repos/compdemocracy/polis/releases`. The URL is a GitHub
release-list compatible endpoint: an array of objects with `tag_name`, `draft`,
`prerelease`, optional `body`, and `assets` containing `name` and
`browser_download_url`. It receives `per_page=100&page=N`; a page shorter than
100 ends the list. More than ten full pages fails instead of guessing.

The updater chooses the highest numeric stable Polis version tagged exactly
`vMAJOR.MINOR.PATCH`, across every returned page. It ignores drafts, prereleases,
tags with prerelease or build suffixes, malformed versions, and other namespaces,
including the old `cli-v` tags. If only legacy tags exist, the error states the
required tag format and that legacy tags are ignored. Equal or older versions do
nothing, even if their commit differs. Comparison uses only major, minor and patch
from the compiled `POLIS_VERSION_BASE` (or the embedded Cargo version before the
shared identity is available), never commit ordering or development distance.

A development build such as `2.41.0+dev.7.abcdef123456` is never updated in the
background. Explicit `polis update` can install a strictly higher base version;
it leaves an equal-base stable release alone. To replace a development build
with an equal-base stable build, explicitly select and verify an artifact using
the installation procedure above. There is no implicit downgrade or force flag.

An installed older updater that only recognizes `cli-v` cannot discover these
Polis releases. Replace it once using an explicitly selected verified artifact
containing the new updater; subsequent `polis update` calls follow `v` releases.
Do not publish compatibility `cli-v` tags or a separate CLI version line.
The newest release must contain the running platform's archive and its checksum;
a missing platform fails, without silently selecting an older release.

Downloads require HTTPS, except loopback HTTP for local testing. Credentials in
URLs are refused; no site token is sent. Up to five redirects are allowed, with
no HTTPS downgrade. Requests each obey `--timeout`; responses and archive members
have size limits. Archive SHA256, manifest version/commit/target/source, binary
SHA256, and the four expected regular archive members are checked before any
replacement. Downloads are never executed as a verification step. Checksums
verify integrity against the selected distributor; they do not independently
authenticate that distributor. Choose the release base URL accordingly.

The running executable must resolve to a regular file named `polis` in a writable
directory. A launcher symlink resolves to that executable; other installations on
PATH are unaffected. The updater stages in the same directory, syncs both files,
saves the installed binary as `polis.prev`, then uses an atomic rename to replace
`polis`. An existing `polis.prev` is replaced by the immediately previous binary.
An installation lock serializes replacement; its empty `.polis-update.lock` file
is retained so overlapping processes always lock the same inode. A changed
installed binary during download causes a refusal. The old executable remains
available until rename; interruptions before that leave it in place. A directory
sync failure after rename is reported as an uncertain outcome (exit 7).

Success reports the old and new version/commit, platform, backup name and release
notes. `--json` uses the normal CLI envelope, with `data.state` equal to `updated`
or `up_to_date`; terminal control characters in release notes are escaped.
Configuration and sign-ins are untouched. Verify with `polis --version` after
updating. To roll back from the installation directory, keep the backup and
atomically restore a copy:

```sh
cp -p polis.prev polis.rollback
mv -f polis.rollback polis
./polis --version
```

## Publish the reviewed Polis promotion

Root `VERSION` is authoritative. Preparation computes the number and opens a
review PR with VERSION and generated Cargo mirrors. A `vMAJOR.MINOR.PATCH` tag
identifies the stable promotion merge. All eight files keep the
`polis-VERSION-COMMIT12-TARGET.tar.gz[.sha256]` names and attach to one Polis
release. No tag push or merge starts publication.

Colin uses the prepared manual commands or approves the final **release**
environment job after reviewing the exact stable SHA, number, migration notes,
PR titles and eight checksums. Only that workflow job has release write
permission; it creates the tag and a draft, uploads the complete set, then
publishes as latest. A failed upload leaves a draft for explicit review. A
matching completed release is a verified no-op; different content is never
overwritten. Signing/notarization and older glibc compatibility remain separate.

The canonical-tag updater must land before publication is enabled; the
publication validator checks this prerequisite on the promoted source. Already
installed legacy updaters only recognize `cli-v` and need the explicit verified
artifact replacement procedure above once. Then the canonical updater follows
the single Polis release series. Do not add compatibility `cli-v` tags.

See [promotion and publication](../../docs/release-promotion.md) for dispatch
inputs, required reviewer configuration, manual commands and retry rules.
Tests mock publication and use a loopback updater server; no public mutation
is needed to test this code.
