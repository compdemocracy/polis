"""Mutations must fail closed without a Cargo registry cache or network."""
from contextlib import redirect_stdout
import io
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tarfile
import tempfile
import unittest

import vendor_postgres

ROOT = Path(__file__).resolve().parents[1]


class VendorPostgresTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        shutil.copytree(ROOT / vendor_postgres.VENDOR, self.root / vendor_postgres.VENDOR)
        for name in ("Cargo.lock", "Cargo.toml"):
            shutil.copy2(ROOT / "queue-rs" / name, self.root / "queue-rs" / name)
        self.vendor = self.root / vendor_postgres.VENDOR

    def check(self):
        with redirect_stdout(io.StringIO()):
            vendor_postgres.check(self.root)

    def rejected(self, filename):
        with self.assertRaises((ValueError, OSError)) as caught:
            self.check()
        self.assertIn(filename, str(caught.exception))

    def replace(self, path, old, new):
        data = path.read_text()
        self.assertIn(old, data)
        path.write_text(data.replace(old, new, 1))

    def test_stack_passes_with_empty_cargo_cache(self):
        result = subprocess.run([sys.executable, str(ROOT / "ci/vendor_postgres.py"),
                                 "--root", str(self.root)], capture_output=True, text=True,
                                env=os.environ | {"CARGO_HOME": str(self.root / "empty-cache"),
                                                  "CARGO_NET_OFFLINE": "true"})
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("offline", result.stdout)
        self.assertFalse((self.root / "empty-cache").exists())

    def test_unmodified_file_edit_fails_named(self):
        path = self.vendor / "src/row_iter.rs"
        path.write_bytes(path.read_bytes() + b"// drift\n")
        self.rejected("src/row_iter.rs")

    def test_modified_file_edit_in_delta_fails_named(self):
        self.replace(self.vendor / "src/config.rs", "setup_deadline", "setup_changed")
        self.rejected("src/config.rs")

    def test_modified_file_edit_outside_delta_fails_named(self):
        path = self.vendor / "src/client.rs"
        path.write_bytes(path.read_bytes() + b"// drift\n")
        self.rejected("src/client.rs")

    def test_malformed_delta_header_fails_named(self):
        path = self.vendor / vendor_postgres.DELTA
        self.replace(path, "+", "-STALE", )
        self.rejected(vendor_postgres.DELTA)

    def test_empty_delta_fails(self):
        (self.vendor / vendor_postgres.DELTA).write_bytes(b"")
        self.rejected(vendor_postgres.DELTA)

    def test_stale_old_bytes_in_delta_fail_upstream_hash(self):
        path = self.vendor / vendor_postgres.DELTA
        data = path.read_bytes()
        # Alter only a removed upstream line: reverse application still works,
        # but the independently recorded upstream SHA must reject it.
        lines = data.splitlines(keepends=True)
        index = next(i for i, line in enumerate(lines)
                     if line.startswith(b"-") and not line.startswith(b"---"))
        lines[index] = lines[index][:-1] + b" stale\n"
        path.write_bytes(b"".join(lines))
        self.rejected("upstream SHA-256 mismatch")

    def test_noncanonical_diff_order_fails_byte_comparison(self):
        path = self.vendor / vendor_postgres.DELTA
        parts = path.read_bytes().split(b"--- a/")[1:]
        self.assertGreater(len(parts), 1)
        path.write_bytes(b"".join(b"--- a/" + part for part in reversed(parts)))
        self.rejected("not byte-for-byte canonical")

    def test_readme_version_fails_named(self):
        self.replace(self.vendor / "README.md", "This is `postgres` 0.19.14", "This is `postgres` 0.19.13")
        self.rejected("README.md")

    def test_readme_checksum_fails_named(self):
        self.replace(self.vendor / "README.md", "33ad20e0", "00ad20e0")
        self.rejected("README.md")

    def test_lock_version_fails_named(self):
        self.replace(self.root / "queue-rs/Cargo.lock", 'name = "postgres"\nversion = "0.19.14"',
                     'name = "postgres"\nversion = "0.19.13"')
        self.rejected("Cargo.lock")

    def test_lock_registry_fields_fail_named(self):
        path = self.root / "queue-rs/Cargo.lock"
        original = path.read_text()
        for field in ['source = "registry+https://github.com/rust-lang/crates.io-index"',
                      'checksum = "' + "0" * 64 + '"']:
            with self.subTest(field=field):
                path.write_text(original)
                self.replace(path, 'name = "postgres"', 'name = "postgres"\n' + field)
                self.rejected("Cargo.lock")

    def test_missing_archive_checksum_fails_named(self):
        self.replace(self.vendor / "README.md", "33ad20e0", "invalid-")
        self.rejected("README.md")

    def test_cargo_version_fails_named(self):
        self.replace(self.vendor / "Cargo.toml", 'version = "0.19.14"', 'version = "0.19.13"')
        self.rejected("Cargo.toml")

    def test_patch_path_fails_named(self):
        self.replace(self.root / "queue-rs/Cargo.toml", 'path = "vendor/postgres"', 'path = "vendor/other"')
        self.rejected("queue-rs/Cargo.toml")

    def test_missing_file_fails_named(self):
        (self.vendor / "src/row_iter.rs").unlink()
        self.rejected("src/row_iter.rs")

    def test_unexpected_file_fails_named(self):
        (self.vendor / "extra.rs").write_text("unexpected\n")
        self.rejected("extra.rs")

    def test_restored_omitted_file_fails_named(self):
        (self.vendor / "CHANGELOG.md").write_text("unexpected\n")
        self.rejected("CHANGELOG.md")

    def test_symlink_fails_named(self):
        (self.vendor / "src/row_iter.rs").unlink()
        (self.vendor / "src/row_iter.rs").symlink_to("client.rs")
        self.rejected("src/row_iter.rs")

    def test_upstream_hash_drift_fails_named(self):
        path = self.vendor / vendor_postgres.MANIFEST
        manifest = json.loads(path.read_text())
        manifest["files"]["LICENSE-MIT"] = "0" * 64
        path.write_text(json.dumps(manifest))
        self.rejected("LICENSE-MIT")

    def test_manifest_provenance_fails_named(self):
        self.replace(self.vendor / vendor_postgres.MANIFEST, "33ad20e0", "00ad20e0")
        self.rejected(vendor_postgres.MANIFEST)

    def test_missing_documented_diff_link_fails_named(self):
        self.replace(self.vendor / "POLIS_CHANGES.md", "[POLIS_CHANGES.patch]", "[missing.patch]")
        self.rejected("POLIS_CHANGES.md")

    def test_refresh_rejects_wrong_archive_without_writing(self):
        archive = self.root / "bad.crate"
        archive.write_bytes(b"not the published archive")
        before = vendor_postgres.inventory(self.vendor)
        with self.assertRaisesRegex(ValueError, "archive SHA-256"):
            vendor_postgres.refresh(self.root, archive)
        self.assertEqual(vendor_postgres.inventory(self.vendor), before)

    def test_refresh_reproduces_manifest_and_delta(self):
        # Build a fixture archive from independently verified reconstructed
        # originals, then give it its own checksum; no network/cache required.
        files = vendor_postgres.inventory(self.vendor)
        current = {n: b for n, b in files.items() if n not in vendor_postgres.ADDITIONS}
        upstream = vendor_postgres.reverse_diff(files[vendor_postgres.DELTA], current)
        upstream.update({n: b"omitted fixture\n" for n in vendor_postgres.OMITTED})
        archive = self.root / "fixture.crate"
        with tarfile.open(archive, "w:gz") as crate:
            for name, data in sorted(upstream.items()):
                info = tarfile.TarInfo("postgres-0.19.14/" + name)
                info.size = len(data)
                crate.addfile(info, io.BytesIO(data))
        checksum = vendor_postgres.sha(archive.read_bytes())
        old = json.loads(files[vendor_postgres.MANIFEST])["archive_sha256"]
        for path in [self.vendor / "README.md", self.vendor / "POLIS_CHANGES.md"]:
            self.replace(path, old, checksum)
        with redirect_stdout(io.StringIO()):
            vendor_postgres.refresh(self.root, archive)
        self.check()
        manifest = json.loads((self.vendor / vendor_postgres.MANIFEST).read_bytes())
        self.assertEqual(manifest["files"], {n: vendor_postgres.sha(b) for n, b in upstream.items()})
        before = vendor_postgres.inventory(self.vendor)
        with redirect_stdout(io.StringIO()):
            vendor_postgres.refresh(self.root, archive)
        self.assertEqual(vendor_postgres.inventory(self.vendor), before)

    def test_diff_handles_empty_files_and_missing_newlines(self):
        for old, new in [(b"", b"added\n"), (b"gone\n", b""),
                         (b"before", b"after"), (b"same\nlast\n", b"same\nlast")]:
            with self.subTest(old=old, new=new):
                delta = vendor_postgres.canonical_diff({"file": old}, {"file": new})
                self.assertEqual(vendor_postgres.reverse_diff(delta, {"file": new}), {"file": old})


if __name__ == "__main__":
    unittest.main()
