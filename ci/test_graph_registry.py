"""Negative controls for source generation and the graph admission boundary."""
import importlib.util
from pathlib import Path
import tempfile
import unittest

SPEC = importlib.util.spec_from_file_location('registry_check', Path(__file__).with_name('check_graph_registry.py'))
check = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(check)

class RegistryCheck(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        for name in ['queue-rs/polis-contracts/job-models.json','delphi/polismath/job-models.json',
                     'queue-rs/polis-contracts/job-test-models.json','delphi/tests/job_graph/job-test-models.json']:
            p = self.root/name; p.parent.mkdir(parents=True, exist_ok=True); p.write_text('[]\n')
    def test_equal_registry(self):
        self.assertEqual(check.check(self.root), [])
    def test_python_only_addition_refuses(self):
        (self.root/'delphi/polismath/job-models.json').write_text('[{}]\n')
        self.assertEqual(len(check.check(self.root)),1)
    def test_rust_only_addition_refuses(self):
        (self.root/'queue-rs/polis-contracts/job-models.json').write_text('[{}]\n')
        self.assertEqual(len(check.check(self.root)),1)
    def test_other_admitter_refuses(self):
        p=self.root/'delphi/scripts/new_client.py';p.parent.mkdir(parents=True);p.write_text("call('pd_graph_admit')\n")
        self.assertEqual(len(check.check(self.root)),1)

if __name__ == '__main__': unittest.main()
