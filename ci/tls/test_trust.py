"""Offline regression controls: empty, stale and alternate-path stores fail."""
import hashlib
import ssl
import unittest
import tomllib
from check_trust import HERE, PEM, POLICY, audit_bundle, verify_chain


class TrustTests(unittest.TestCase):
    def test_empty_store_is_not_a_pass(self):
        with self.assertRaisesRegex(ValueError, 'empty'):
            audit_bundle('', 'empty')

    def test_each_affected_root_is_rejected(self):
        roots = PEM.findall((HERE / 'fixtures/affected-roots.pem').read_text())
        self.assertEqual(len(roots), 4)
        for root in roots:
            with self.subTest(root=hashlib.sha256(ssl.PEM_cert_to_DER_cert(root)).hexdigest()):
                with self.assertRaisesRegex(ValueError, 'trusts'):
                    audit_bundle(root, 'stale')

    def test_chain_fixtures_are_accepted_by_the_old_roots(self):
        chains = sorted((HERE / 'fixtures').glob('*we-have-a-problem.com.pem'))
        self.assertEqual(len(chains), 12)
        for chain in chains:
            with self.subTest(chain=chain.name):
                result = verify_chain(HERE / 'fixtures/affected-roots.pem', chain)
                self.assertEqual(result.returncode, 0, result.stdout + result.stderr)

    def test_advisory_versions_are_locked(self):
        root = HERE.parents[1]
        cargo = tomllib.loads((root / 'polis-cli/Cargo.lock').read_text())
        versions = {p['name']: p['version'] for p in cargo['package']}
        self.assertEqual(versions['webpki-roots'], '1.0.10')
        self.assertEqual(versions['rustls-webpki'], '0.103.16')
        uv = tomllib.loads((root / 'delphi/uv.lock').read_text())
        self.assertEqual(next(p['version'] for p in uv['package'] if p['name'] == 'certifi'), '2026.10.19')
        self.assertIn('certifi==2026.10.19', (root / 'delphi/requirements.lock').read_text().splitlines())
        self.assertEqual(tomllib.loads((root / 'server/mise.toml').read_text())['tools']['node'], '22.23.4')

    def test_policy_includes_cross_signs(self):
        self.assertEqual(len(POLICY['intermediates']), 16)
        self.assertEqual(len({r['spki_sha256'] for r in POLICY['intermediates']}), 8)
        self.assertIn('AAA Certificate Services', {r['name'] for r in POLICY['roots']})


if __name__ == '__main__':
    unittest.main()
