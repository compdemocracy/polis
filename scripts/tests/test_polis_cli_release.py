import hashlib
import importlib.util
import io
import json
from pathlib import Path
import tarfile
import tempfile
import unittest
from unittest.mock import patch

SPEC = importlib.util.spec_from_file_location("release", Path(__file__).resolve().parents[1] / "build-polis-cli-release.py")
release = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(release)
COMMIT = "a" * 40
TARGET = "aarch64-apple-darwin"


class ReleaseTests(unittest.TestCase):
    def test_archive_is_reproducible_and_carries_exact_binary_hash_and_modes(self):
        with tempfile.TemporaryDirectory() as d:
            args = (b"generated binary", "0.1.0", COMMIT, TARGET,
                    "clean-checkout", "rustc fixture", b"lock", b"license")
            first = release.package(Path(d)/"one", *args)
            second = release.package(Path(d)/"two", *args)
            self.assertEqual(first.read_bytes(), second.read_bytes())
            digest = hashlib.sha256(first.read_bytes()).hexdigest()
            self.assertEqual(Path(str(first)+".sha256").read_text(), f"{digest}  {first.name}\n")
            with tarfile.open(first) as tar:
                self.assertEqual(len(tar.getmembers()), 4)
                for member in tar.getmembers():
                    self.assertTrue(member.isfile())
                    self.assertEqual(member.uid, 0)
                    self.assertEqual(member.mtime, 0)
                    self.assertNotIn("..", Path(member.name).parts)
                    if member.name.endswith("/polis"):
                        self.assertEqual(member.mode, 0o755)
                        self.assertEqual(tar.extractfile(member).read(), args[0])
                    elif member.name.endswith("/manifest.json"):
                        manifest = json.load(tar.extractfile(member))
                        self.assertEqual(manifest["commit"], COMMIT)
                        self.assertEqual(manifest["target"], TARGET)
                        self.assertEqual(manifest["binary_sha256"], hashlib.sha256(args[0]).hexdigest())
                    else:
                        self.assertEqual(member.mode, 0o644)

    def test_no_overwrite(self):
        with tempfile.TemporaryDirectory() as d:
            args = (Path(d), b"binary", "0.1.0", COMMIT, TARGET, "clean-checkout", "rustc", b"lock", b"license")
            archive = release.package(*args)
            before = archive.read_bytes()
            with self.assertRaises(ValueError):
                release.package(*args)
            self.assertEqual(archive.read_bytes(), before)

    def test_unverified_archive_is_named_and_manifested(self):
        with tempfile.TemporaryDirectory() as d:
            archive = release.package(Path(d), b"binary", "0.1.0", COMMIT, TARGET,
                                      "unverified-archive", "rustc", b"lock", b"license")
            self.assertIn("-unverified.tar.gz", archive.name)
            with tarfile.open(archive) as tar:
                member = next(m for m in tar if m.name.endswith("/manifest.json"))
                self.assertEqual(json.load(tar.extractfile(member))["source"], "unverified-archive")

    def test_archive_provenance_requires_two_explicit_options(self):
        self.assertEqual(release.provenance(Path("."), COMMIT, True), (COMMIT, "unverified-archive"))
        for commit, allowed in [(COMMIT, False), (None, True), ("short", True)]:
            with self.assertRaises(ValueError):
                release.provenance(Path("."), commit, allowed)

    def test_clean_checkout_requires_exact_root_commit_and_unmodified_inputs(self):
        root = Path("/generated/repository")
        for replies, valid in [([str(root), COMMIT, ""], True),
                               (["/generated"], False),
                               ([str(root), COMMIT, " M polis-cli/Cargo.toml"], False),
                               ([str(root), COMMIT, "?? polis-cli/crates/polis/src/new.rs"], False),
                               ([str(root), "bad"], False)]:
            with patch.object(release, "output", side_effect=replies):
                if valid:
                    self.assertEqual(release.provenance(root), (COMMIT, "clean-checkout"))
                else:
                    with self.assertRaises(ValueError):
                        release.provenance(root)

    def test_native_host_and_all_matrix_targets(self):
        for target in release.TARGETS:
            release.native_target(f"rustc fixture\nhost: {target}\n", target)
        for target in ["x86_64-apple-darwin", "unknown"]:
            with self.assertRaises(ValueError):
                release.native_target(f"host: {TARGET}", target)

    def test_invalid_metadata_cannot_become_an_archive_path(self):
        for commit in ["a"*39, "A"*40, "../"+"a"*37, "a"*40+"\n"]:
            with self.assertRaises(ValueError):
                release.commit_id(commit)
        with tempfile.TemporaryDirectory() as d:
            with self.assertRaises(ValueError):
                release.package(Path(d), b"binary", "../bad", COMMIT, TARGET,
                                "clean-checkout", "rustc", b"lock", b"license")
            self.assertEqual(list(Path(d).iterdir()), [])


STABLE = dict(version_base="2.42.2", version_display="2.42.2", commit=COMMIT,
              distance=0, channel="stable", source="clean-checkout")
DEVELOPMENT = dict(STABLE, version_display="2.42.2+dev.0." + COMMIT[:12], channel="development")
STABLE_LINE = f"polis 2.42.2 (commit {COMMIT}; distance 0; clean-checkout)"
DEVELOPMENT_LINE = f"polis 2.42.2+dev.0.{COMMIT[:12]} (commit {COMMIT}; distance 0; clean-checkout)"


class ReleaseIdentityTests(unittest.TestCase):
    def test_only_the_stable_identity_of_the_tag_and_commit_is_a_release(self):
        release.check_release_identity(dict(STABLE), "v2.42.2", COMMIT)
        self.assertEqual(release.release_version_line("2.42.2", COMMIT), STABLE_LINE)
        for change in [dict(channel="development"), dict(version_display="2.42.2+dev.0." + COMMIT[:12]),
                       dict(distance=1), dict(distance=None), dict(commit="b" * 40),
                       dict(source="unverified-archive"), dict(version_base="2.42.1")]:
            with self.subTest(change=change), self.assertRaisesRegex(ValueError, "stable identity"):
                release.check_release_identity(dict(STABLE, **change), "v2.42.2", COMMIT)
        with self.assertRaisesRegex(ValueError, "stable identity"):
            release.check_release_identity(dict(STABLE), "v2.42.3", COMMIT)

    def build(self, *flags, identities=(STABLE, STABLE), reported=STABLE_LINE,
              provenance=(COMMIT, "clean-checkout")):
        """Drive the real entry point with generated toolchain replies; nothing is compiled."""
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        root = Path(temp.name)
        (root / "VERSION").write_text("2.42.2\n")
        (root / "LICENSE").write_text("license")
        (root / "polis-cli").mkdir()
        (root / "polis-cli/Cargo.lock").write_text("lock")
        binary = root / "target" / TARGET / "release" / "polis"
        binary.parent.mkdir(parents=True)
        binary.write_bytes(b"generated binary")
        def output(argv, cwd=None, env=None):
            if argv[:2] == ["rustc", "-vV"]:
                return f"rustc fixture\nhost: {TARGET}"
            if argv[:2] == ["cargo", "metadata"]:
                return json.dumps({"target_directory": str(root / "target")})
            if argv == [str(binary), "--version"]:
                return reported
            self.fail(argv)
        argv = ["build-polis-cli-release.py", "--target", TARGET, "--output", str(root / "out"), *flags]
        with patch.object(release, "ROOT", root), patch.object(release, "provenance", return_value=provenance), \
             patch.object(release, "output", side_effect=output), \
             patch.object(release, "identity", side_effect=list(identities)) as identity, \
             patch.object(release.subprocess, "run") as run, \
             patch.object(release, "package", return_value=root / "out/archive.tar.gz") as package, \
             patch("sys.argv", argv), patch("sys.stdout", new_callable=io.StringIO), \
             patch("sys.stderr", new_callable=io.StringIO) as stderr:
            try:
                release.main()
                failure = None
            except SystemExit as error:
                self.assertEqual(error.code, 1)
                failure = stderr.getvalue()
        return failure, run, package, identity

    def test_release_build_packages_only_a_stable_binary(self):
        flags = ("--release-tag", "v2.42.2", "--release-commit", COMMIT)
        failure, run, package, _ = self.build(*flags)
        self.assertIsNone(failure)
        self.assertEqual(run.call_args_list[0].args[0][:2], ["cargo", "build"])
        package.assert_called_once()
        # A runner without origin/stable or the local tag: refused before compiling.
        failure, run, package, identity = self.build(*flags, identities=(DEVELOPMENT,))
        self.assertIn("stable identity", failure)
        self.assertIn('"channel": "development"', failure)
        self.assertEqual(identity.call_count, 1)
        run.assert_not_called()
        package.assert_not_called()
        # A binary that reports a development build after compiling is not packaged.
        failure, run, package, _ = self.build(*flags, identities=(STABLE, DEVELOPMENT),
                                              reported=DEVELOPMENT_LINE)
        self.assertIn("must report exactly the release version", failure)
        package.assert_not_called()

    def test_release_build_requires_the_exact_tag_commit_and_clean_checkout(self):
        for flags, provenance, message in [
                (("--release-tag", "v2.42.2"), (COMMIT, "clean-checkout"), "both --release-tag"),
                (("--release-commit", COMMIT), (COMMIT, "clean-checkout"), "both --release-tag"),
                (("--release-tag", "v2.42.3", "--release-commit", COMMIT), (COMMIT, "clean-checkout"), "exact root VERSION"),
                (("--release-tag", "cli-v2.42.2", "--release-commit", COMMIT), (COMMIT, "clean-checkout"), "exact root VERSION"),
                (("--release-tag", "v2.42.2", "--release-commit", "b" * 40), (COMMIT, "clean-checkout"), "exactly the release commit"),
                (("--release-tag", "v2.42.2", "--release-commit", "short"), (COMMIT, "clean-checkout"), "full lowercase"),
                (("--release-tag", "v2.42.2", "--release-commit", COMMIT), (COMMIT, "unverified-archive"), "exactly the release commit")]:
            with self.subTest(flags=flags, provenance=provenance):
                failure, run, package, identity = self.build(*flags, provenance=provenance)
                self.assertIn(message, failure)
                identity.assert_not_called()
                run.assert_not_called()
                package.assert_not_called()

    def test_rehearsal_builds_without_release_flags_are_unchanged(self):
        failure, _, package, _ = self.build(identities=(DEVELOPMENT,), reported=DEVELOPMENT_LINE)
        self.assertIsNone(failure)
        package.assert_called_once()


if __name__ == "__main__":
    unittest.main()
