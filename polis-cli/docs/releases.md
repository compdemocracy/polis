# Building, installing and updating the CLI

`polis --version` prints the semantic CLI version, full source commit and source
status. An ordinary Cargo build without metadata says `commit unknown;
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

The manual **polis-cli release build (no publishing)** workflow uses these same
commands on native macOS and Linux runners. Its artifacts expire after 14 days;
they are review inputs, not permanent release URLs. All target jobs must pass
before a distributor claims that version supports all four targets. A passing
ARM64 Mac build alone does not qualify Intel or Linux. GNU/Linux binaries use
the runner's glibc and are not promised to work on older distributions. A source
build remains available there. Mac archives are unsigned unless a distributor
separately signs and notarizes them; no signing identity is supplied here.

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
trusted distributor. There is no automatic installer or download in this CLI.
A checksum verifies bytes against that expected digest; it does not authenticate
the distributor on its own. In the download directory:

```sh
# Use the exact downloaded checksum filename; substitute your chosen artifact.
shasum -a 256 -c polis-VERSION-COMMIT-TARGET.tar.gz.sha256
mkdir unpacked
# Substitute the same exact filename; unpack into the new directory.
tar -xzf polis-VERSION-COMMIT-TARGET.tar.gz -C unpacked
```

Inspect the manifest and run the unpacked `polis --version` before installation.
The version/commit/target must match the version you selected. Then, from the
unpacked artifact directory, install into a directory you own on PATH:

```sh
mkdir -p "$HOME/.local/bin"
# If replacing an existing binary, first save it under a new backup filename.
# Stop if that backup filename already exists.
test ! -e "$HOME/.local/bin/polis.previous" || exit 1
if test -e "$HOME/.local/bin/polis"; then
  cp -p "$HOME/.local/bin/polis" "$HOME/.local/bin/polis.previous"
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

Updating repeats the same pinned-artifact procedure. The CLI does not check for
updates during sign-in, reads, votes or comments. An explicit update-check command
can be added later; no update network request or automatic replacement exists.

## Publication remains separate

The semantic version lives in `polis-cli/Cargo.toml`. A distributor first reviews
and increments it with its lockfile, qualifies native targets, and records the
chosen full commit under a CLI-specific release tag such as `cli-v0.1.0`.
Only then publish the exact reviewed archives and checksums to permanent release
storage, with the appropriate signing/attestation policy. This build workflow has
read-only repository permissions and no release creation, tag writes or package
publishing steps.
