"""The scheduler verifies offline provenance with bounded streaming reads."""
import hashlib
import importlib.util
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

SCRIPTS = Path(__file__).resolve().parents[2] / "scripts"
sys.path.insert(0, str(SCRIPTS))
_spec = importlib.util.spec_from_file_location("graph_provenance", SCRIPTS / "graph_provenance.py")
provenance = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(provenance)
from delphi_graph_stages import model_digest


class ProvenanceTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.files = {"weights.safetensors": b"generated weights", "config.json": b"{}"}
        for name, data in self.files.items():
            (self.root / name).write_bytes(data)
        self.lock = {"files": {name: hashlib.sha256(data).hexdigest() for name, data in self.files.items()}}

    def test_one_read_per_file_matches_the_child_digest(self):
        expected = model_digest(self.root)
        opened = []
        original = Path.open
        def track(path, *args, **kwargs):
            opened.append(path.name)
            return original(path, *args, **kwargs)
        with patch.object(Path, "open", track):
            self.assertEqual(provenance.verified_digest(self.root, self.lock), expected)
        self.assertCountEqual(opened, list(self.files))

    def test_changed_weights_refuse(self):
        (self.root / "weights.safetensors").write_bytes(b"changed")
        with self.assertRaises(ValueError):
            provenance.verified_digest(self.root, self.lock)

    def test_missing_file_refuses(self):
        (self.root / "config.json").unlink()
        with self.assertRaises(ValueError):
            provenance.verified_digest(self.root, self.lock)

    def test_extra_file_refuses(self):
        (self.root / "extra").write_bytes(b"extra")
        with self.assertRaises(ValueError):
            provenance.verified_digest(self.root, self.lock)


if __name__ == "__main__":
    unittest.main()
