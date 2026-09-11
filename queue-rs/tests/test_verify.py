"""Refusal controls for the case receipt parser; no database involved."""
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest
import xml.etree.ElementTree as ET

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location("queue_receipt", ROOT / "verify.py")
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class ReceiptControls(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.path = Path(self.directory.name) / "junit.xml"
        self.suite = ET.Element("testsuite")
        for identity in json.loads((ROOT / "case-inventory.json").read_text()):
            filename, name = identity.split("::")
            ET.SubElement(self.suite, "testcase", classname=filename.removesuffix(".py").replace("/", "."), name=name)

    def check(self, valid=False):
        ET.ElementTree(self.suite).write(self.path)
        if valid:
            self.assertEqual(module.verify(self.path)["tests"], 54)
        else:
            with self.assertRaises(ValueError):
                module.verify(self.path)

    def test_complete(self):
        self.check(valid=True)

    def test_missing(self):
        self.suite.remove(self.suite[0])
        self.check()

    def test_duplicate(self):
        self.suite.append(self.suite[0])
        self.check()

    def test_unknown(self):
        self.suite[0].set("name", "unknown")
        self.check()

    def test_failed(self):
        ET.SubElement(self.suite[0], "failure")
        self.check()

    def test_error(self):
        ET.SubElement(self.suite[0], "error")
        self.check()

    def test_skipped(self):
        ET.SubElement(self.suite[0], "skipped")
        self.check()


if __name__ == "__main__":
    unittest.main()
