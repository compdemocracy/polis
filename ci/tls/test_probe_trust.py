"""Probe blocklist selection must preserve unrelated trust and match policy."""
import importlib.util
from pathlib import Path
import tempfile
import unittest
from check_trust import HERE, PEM, POLICY, affected_objects

SPEC = importlib.util.spec_from_file_location(
    'probe_distrust', HERE.parent / 'probe_box/local/distrust-ca.py')
PROBE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(PROBE)


class ProbeTrustTests(unittest.TestCase):
    def test_fingerprints_match_all_policy_roots(self):
        self.assertEqual(PROBE.BLOCKED, {root['sha256'] for root in POLICY['roots']})

    def test_only_exact_roots_are_blocked_and_source_is_unchanged(self):
        roots = (HERE / 'fixtures/affected-roots.pem').read_text()
        unrelated = affected_objects()[0]
        original = '# Autorité\n' + roots + '\n' + unrelated
        with tempfile.TemporaryDirectory() as tmp:
            bundle, destination = Path(tmp) / 'bundle.pem', Path(tmp) / 'blocklist'
            bundle.write_text(original)
            self.assertEqual(PROBE.block_roots(bundle, destination), PROBE.BLOCKED)
            self.assertEqual(bundle.read_text(), original)
            self.assertEqual(len(list(destination.iterdir())), 4)
            self.assertEqual({p.read_text().strip() for p in destination.iterdir()}, set(PEM.findall(roots)))
            before = {p.name: p.read_bytes() for p in destination.iterdir()}
            PROBE.block_roots(bundle, destination)
            self.assertEqual({p.name: p.read_bytes() for p in destination.iterdir()}, before)
            bundle.write_text(unrelated)
            self.assertEqual(PROBE.block_roots(bundle, destination), set())
            self.assertEqual({p.name: p.read_bytes() for p in destination.iterdir()}, before)

    def test_empty_bundle_fails_closed(self):
        with tempfile.TemporaryDirectory() as tmp:
            bundle = Path(tmp) / 'bundle.pem'
            bundle.write_text('not a certificate')
            with self.assertRaisesRegex(ValueError, 'empty or malformed'):
                PROBE.block_roots(bundle, Path(tmp) / 'blocklist')

    def test_non_tls_parents_are_also_blocked(self):
        roots = PEM.findall((HERE / 'fixtures/affected-roots.pem').read_text())
        with tempfile.TemporaryDirectory() as tmp:
            source, destination = Path(tmp), Path(tmp) / 'blocklist'
            for purpose, certs in zip(('tls', 'email', 'objsign'), (roots[:1], roots[1:3], roots[3:])):
                (source / f'{purpose}-ca-bundle.pem').write_text('\n'.join(certs))
            PROBE.install_blocklist(source, destination)
            self.assertEqual({p.stem.removeprefix('emudhra-') for p in destination.iterdir()}, PROBE.BLOCKED)


if __name__ == '__main__':
    unittest.main()
