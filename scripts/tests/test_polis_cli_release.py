import hashlib
import importlib.util
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


if __name__ == "__main__":
    unittest.main()
