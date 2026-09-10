"""Explicit isolated-PG rehearsal; never discovers or defaults to a database."""
import os
import secrets
import unittest
import psycopg2
from psycopg2 import sql
from provision_login import provision, ROLE, TABLES


class LoginTests(unittest.TestCase):
    def setUp(self):
        url=os.environ['PROBE_TEST_DATABASE_URL']
        if not url.startswith('postgresql://postgres@127.0.0.1:'):raise ValueError('ISOLATED_LOCAL_PG_REQUIRED')
        self.conn=psycopg2.connect(url);self.conn.autocommit=True
        self.addCleanup(self.conn.close)
        with self.conn.cursor() as c:
            c.execute('DROP OWNED BY polis_probe_reader') if self.exists() else None
            c.execute('DROP ROLE IF EXISTS polis_probe_reader')
            for t in TABLES:c.execute(sql.SQL('CREATE TABLE IF NOT EXISTS {} (value integer)').format(sql.Identifier(t)))
            c.execute('SELECT current_database()');self.database=c.fetchone()[0]
        self.conn.autocommit=False
        self.password=secrets.token_urlsafe(32)

    def exists(self):
        with self.conn.cursor() as c:
            c.execute('SELECT 1 FROM pg_roles WHERE rolname=%s',(ROLE,));return bool(c.fetchone())

    def install(self,owner='public-fixture-owned-stack'):
        provision(self.conn,self.password,self.database,owner)

    def test_create_select_and_no_dml(self):
        self.install()
        with self.conn.cursor() as c:
            for table in TABLES:
                c.execute("SELECT has_table_privilege(%s,%s,'SELECT'),has_table_privilege(%s,%s,'INSERT,UPDATE,DELETE,TRUNCATE')",(ROLE,table,ROLE,table))
                self.assertEqual(c.fetchone(),(True,False))
            c.execute('SET ROLE polis_probe_reader')
            c.execute('SET transaction_read_only=off')
            with self.assertRaises(psycopg2.errors.InsufficientPrivilege):c.execute('INSERT INTO votes VALUES(1)')
        self.conn.rollback()

    def test_owned_reapply(self):
        self.install();self.install()
        self.assertTrue(self.exists())

    def test_foreign_role_not_adopted(self):
        with self.conn:
            with self.conn.cursor() as c:c.execute('CREATE ROLE polis_probe_reader')
        with self.assertRaisesRegex(ValueError,'FOREIGN'):self.install()
        with self.conn.cursor() as c:
            c.execute('SELECT rolcanlogin FROM pg_roles WHERE rolname=%s',(ROLE,));self.assertEqual(c.fetchone(),(False,))

    def test_owner_mismatch_refused(self):
        self.install()
        with self.assertRaisesRegex(ValueError,'FOREIGN'):self.install('different-stack')

    def test_broad_owned_role_refused(self):
        self.install()
        with self.conn:
            with self.conn.cursor() as c:c.execute('ALTER ROLE polis_probe_reader CREATEDB')
        with self.assertRaisesRegex(ValueError,'BROAD'):self.install()

    def test_membership_refused(self):
        self.install()
        with self.conn:
            with self.conn.cursor() as c:c.execute('GRANT pg_read_all_data TO polis_probe_reader')
        with self.assertRaisesRegex(ValueError,'MEMBERSHIP'):self.install()

    def test_direct_write_drift_refused(self):
        self.install()
        with self.conn:
            with self.conn.cursor() as c:c.execute('GRANT INSERT ON votes TO polis_probe_reader')
        with self.assertRaisesRegex(ValueError,'DML'):self.install()

    def test_transaction_rolls_back_partial_grants(self):
        with self.conn:
            with self.conn.cursor() as c:c.execute('DROP TABLE math_ticks')
        with self.assertRaises(psycopg2.errors.UndefinedTable):self.install()
        self.assertFalse(self.exists())


if __name__=='__main__':unittest.main()
