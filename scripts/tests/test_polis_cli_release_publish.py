import importlib.util
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch

SPEC = importlib.util.spec_from_file_location("publish", Path(__file__).resolve().parents[1] / "publish-polis-cli-release.py")
publish = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(publish)
COMMIT = "a" * 40


class PublishTests(unittest.TestCase):
    def bundle(self, directory, source="clean-checkout"):
        for target in publish.build.TARGETS:
            publish.build.package(directory, b"generated binary", "1.2.3", COMMIT, target,
                                  source, "rustc fixture", b"lock", b"license")

    def test_four_targets_checked_before_any_publication(self):
        with tempfile.TemporaryDirectory() as d, patch.object(publish.subprocess, "run") as run:
            self.bundle(Path(d))
            assets = publish.validate(Path(d), "cli-v1.2.3", COMMIT)
            self.assertEqual(len(assets), 8)
            publish.publish(Path(d), "cli-v1.2.3", COMMIT, "example/project")
            calls = [call.args[0] for call in run.call_args_list]
            self.assertEqual(len(calls), 3)
            self.assertEqual(calls[0][0:4], ["gh", "release", "create", "cli-v1.2.3"])
            self.assertIn("--verify-tag", calls[0])
            self.assertIn("--draft", calls[0])
            self.assertIn("--generate-notes", calls[0])
            self.assertEqual(calls[1][0:3], ["gh", "release", "upload"])
            self.assertEqual(calls[1][6:], list(map(str, assets)))
            self.assertIn("--draft=false", calls[2])
            self.assertIn("--latest=false", calls[2])

    def test_bad_tag_wrong_commit_missing_platform_and_checksum_fail_before_publish(self):
        for mode in ["tag", "version", "commit", "missing", "checksum", "extra", "unverified"]:
            with self.subTest(mode=mode), tempfile.TemporaryDirectory() as d, patch.object(publish.subprocess, "run") as run:
                directory = Path(d)
                self.bundle(directory, "unverified-archive" if mode == "unverified" else "clean-checkout")
                if mode == "missing": next(directory.glob("*.tar.gz")).unlink()
                if mode == "checksum": next(directory.glob("*.sha256")).write_text("0"*64)
                if mode == "extra": (directory/"unexpected").write_text("extra")
                tag = "bad" if mode == "tag" else "cli-v1.2.4" if mode == "version" else "cli-v1.2.3"
                commit = "b"*40 if mode == "commit" else COMMIT
                with self.assertRaises(ValueError): publish.publish(directory, tag, commit, "example/project")
                run.assert_not_called()

    def test_upload_failure_leaves_release_draft(self):
        with tempfile.TemporaryDirectory() as d, patch.object(publish.subprocess, "run") as run:
            self.bundle(Path(d))
            run.side_effect = [None, subprocess.CalledProcessError(1, "gh upload")]
            with self.assertRaises(subprocess.CalledProcessError): publish.publish(Path(d), "cli-v1.2.3", COMMIT, "example/project")
            self.assertEqual(run.call_count, 2)

    def test_tag_guard(self):
        publish.build.check_tag("cli-v1.2.3", "1.2.3")
        for tag in ["v1.2.3", "cli-v1.2.4", "cli-v01.2.3", "cli-v1.2.3-beta", "cli-v1.2.3\n"]:
            with self.assertRaises(ValueError): publish.build.check_tag(tag, "1.2.3")


if __name__ == "__main__":
    unittest.main()
