"""Password-bearing arguments fail closed before connections or child launch."""
import contextlib
import io
from unittest import mock
import unittest
from polismath.replay.dsn_admission import passwordless_dsn, ERROR


class DsnTests(unittest.TestCase):
    def test_password_spellings(self):
        for value in ('postgresql://user:example-marker@localhost/db',
                      'postgres://user:example%2Dmarker@localhost/db',
                      'postgresql://user:@localhost/db',
                      'postgresql://localhost/db?password=example-marker',
                      'postgresql://localhost/db?%70assword=example-marker',
                      "host=localhost password='example-marker'",
                      "host=localhost password = ''",
                      "dbname='postgresql://user:example-marker@localhost/db'"):
            with self.subTest(value=value):
                with self.assertRaisesRegex(ValueError, '^'+ERROR+'$'):
                    passwordless_dsn(value)

    def test_external_credentials(self):
        for value in ('postgresql://user@localhost/db', 'host=localhost user=reader',
                      'service=reader', 'host=localhost passfile=/private/reader.pgpass'):
            self.assertEqual(passwordless_dsn(value), value)

    def test_invalid_never_echoes_input(self):
        with self.assertRaisesRegex(ValueError,'^DSN_INVALID$'):
            passwordless_dsn('example-marker')

    def test_click_clis(self):
        from click.testing import CliRunner
        from scripts import prodclone_extract, certify_data, poller_equiv
        commands=[(prodclone_extract.cli, ['survey']), (prodclone_extract.cli,['extract']),
                  (prodclone_extract.cli,['select-representative']), (prodclone_extract.cli,['from-config']),
                  (certify_data.cli,['survey']), (poller_equiv.cli,['run-clj']), (poller_equiv.cli,['run-py']), (poller_equiv.cli,['seed']),
                  (poller_equiv.cli,['feed']), (poller_equiv.cli,['full-run'])]
        for cli, command in commands:
            for dsn in ('postgresql://u:example-marker@localhost/db','host=localhost password=example-marker'):
                with self.subTest(command=command, dsn=dsn), mock.patch('psycopg2.connect') as connect:
                    result=CliRunner().invoke(cli,command+['--admin-url' if command[0] in ('seed','feed','full-run') else '--database-url',dsn])
                    self.assertNotEqual(result.exit_code,0)
                    self.assertIn(ERROR,result.output)
                    self.assertNotIn('example-marker',result.output)
                    connect.assert_not_called()

    def test_projection_primary_replica_and_forwarding(self):
        from scripts import projection_gate as gate
        for flag in ('--dsn','--replica-dsn'):
            with self.subTest(flag=flag):
                argv=['--dsn','service=reader','--zid','1',flag,'host=localhost password=example-marker']
                stderr=io.StringIO()
                with contextlib.redirect_stderr(stderr), self.assertRaises(SystemExit):
                    gate._parse_args(argv)
                self.assertIn(ERROR,stderr.getvalue())
                self.assertNotIn('example-marker',stderr.getvalue())
        with mock.patch('subprocess.run') as run, self.assertRaisesRegex(ValueError,ERROR):
            gate.run_wire_witness('postgresql://u:example-marker@localhost/db',{'zid':1})
        run.assert_not_called()
