"""Negative controls for the registry copy and the graph admission boundary."""
import importlib.util
from pathlib import Path
import tempfile
import unittest

SPEC = importlib.util.spec_from_file_location('registry_check', Path(__file__).with_name('check_graph_registry.py'))
check = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(check)

CALL = "call('pd_graph_admit')\n"

class RegistryCheck(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        for name in ['queue-rs/polis-contracts/job-models.json','delphi/polismath/job-models.json',
                     'queue-rs/polis-contracts/job-test-models.json','delphi/tests/job_graph/job-test-models.json']:
            p = self.root/name; p.parent.mkdir(parents=True, exist_ok=True); p.write_text('[]\n')
    def write(self, name, text=CALL):
        p = self.root/name; p.parent.mkdir(parents=True, exist_ok=True); p.write_text(text)
    def test_equal_registry(self):
        self.assertEqual(check.check(self.root), [])
    def test_python_only_addition_refuses(self):
        (self.root/'delphi/polismath/job-models.json').write_text('[{}]\n')
        self.assertEqual(len(check.check(self.root)),1)
    def test_rust_only_addition_refuses(self):
        (self.root/'queue-rs/polis-contracts/job-models.json').write_text('[{}]\n')
        self.assertEqual(len(check.check(self.root)),1)
    def test_other_admitter_refuses(self):
        self.write('delphi/scripts/new_client.py')
        self.assertEqual(len(check.check(self.root)),1)
    def test_admitter_anywhere_in_the_tree_refuses(self):
        names = ['delphi/umap_narrative/new_client.py', 'delphi/run_new.py', 'queue-rs/polis-api/src/new_route.rs',
                 'polis-cli/crates/polis/src/new.rs', 'scripts/new_admit.sh', 'server/src/new.ts']
        for name in names:
            self.write(name)
        self.assertEqual(sorted(check.check(self.root)),
                         sorted('graph admission outside shared entry: ' + n for n in names))
    def test_entry_boundary_tests_migrations_and_docs_are_not_callers(self):
        for name in sorted(check.ALLOWED) + ['server/postgres/migrations/000047_x.sql', 'docs/job-graphs.md',
                                             'server/node_modules/x/index.js', 'queue-rs/target/debug/x.rs']:
            self.write(name)
        self.assertEqual(check.check(self.root), [])

if __name__ == '__main__': unittest.main()
