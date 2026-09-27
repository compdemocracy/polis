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
            c.execute(sql.SQL('ALTER DATABASE {} OWNER TO postgres').format(sql.Identifier(self.conn.info.dbname)))
            c.execute('ALTER SCHEMA public OWNER TO pg_database_owner')
            for t in TABLES:
                c.execute(sql.SQL('ALTER TABLE IF EXISTS {} OWNER TO postgres').format(sql.Identifier(t)))
            c.execute('ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC')
            c.execute('DROP OWNED BY polis_probe_reader') if self.exists() else None
            c.execute('DROP ROLE IF EXISTS polis_probe_reader')
            for t in TABLES:c.execute(sql.SQL('CREATE TABLE IF NOT EXISTS {} (value integer)').format(sql.Identifier(t)))
            c.execute('SELECT current_database()');self.database=c.fetchone()[0]
            c.execute(sql.SQL('REVOKE CREATE, TEMP ON DATABASE {} FROM PUBLIC').format(sql.Identifier(self.database)))
            c.execute('REVOKE CREATE ON SCHEMA public FROM PUBLIC')
            for t in TABLES:c.execute(sql.SQL('REVOKE ALL ON {} FROM PUBLIC').format(sql.Identifier(t)))
            c.execute('DROP TABLE IF EXISTS extra_reader_table')
            c.execute('DROP SEQUENCE IF EXISTS extra_reader_sequence')
            c.execute('DROP FUNCTION IF EXISTS public.reader_function()')
            c.execute('ALTER DEFAULT PRIVILEGES REVOKE SELECT ON TABLES FROM PUBLIC')
            c.execute('ALTER DEFAULT PRIVILEGES REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC')
        self.conn.autocommit=False
        self.password=secrets.token_urlsafe(32)

    def exists(self):
        with self.conn.cursor() as c:
            c.execute('SELECT 1 FROM pg_roles WHERE rolname=%s',(ROLE,));return bool(c.fetchone())

    def install(self,owner='public-fixture-owned-stack'):
        return provision(self.conn,self.password,self.database,owner)

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

    def drift(self, ddl, error):
        self.install()
        with self.conn:
            with self.conn.cursor() as c:c.execute(ddl)
        with self.assertRaisesRegex(ValueError,error):self.install()

    def test_public_write(self):
        self.drift('GRANT UPDATE ON votes TO PUBLIC','DML')

    def test_public_column_write(self):
        self.drift('GRANT UPDATE(value) ON votes TO PUBLIC','DML')

    def test_public_schema_create(self):
        self.install()
        self.grant('GRANT CREATE ON SCHEMA public TO PUBLIC')
        self.assertEqual(self.install(), ['schema-create'])

    def test_public_temp(self):
        self.install()
        with self.conn:
            with self.conn.cursor() as c:c.execute(sql.SQL('GRANT TEMP ON DATABASE {} TO PUBLIC').format(sql.Identifier(self.database)))
        self.assertEqual(self.install(), ['database-temp'])

    def test_public_extra_table_select(self):
        self.drift('CREATE TABLE extra_reader_table(value integer); GRANT SELECT ON extra_reader_table TO PUBLIC','EXTRA_TABLE')

    def test_public_sequence(self):
        self.drift('CREATE SEQUENCE extra_reader_sequence; GRANT USAGE ON extra_reader_sequence TO PUBLIC','SEQUENCE')

    def test_public_function(self):
        self.install()
        self.grant("CREATE FUNCTION public.reader_function() RETURNS integer LANGUAGE sql AS 'SELECT 1'; GRANT EXECUTE ON FUNCTION public.reader_function() TO PUBLIC")
        self.assertEqual(self.install(), ['routine-execute'])

    def test_public_default_grant(self):
        self.drift('ALTER DEFAULT PRIVILEGES GRANT SELECT ON TABLES TO PUBLIC','DEFAULT')

    def test_select_grant_option(self):
        self.drift('GRANT SELECT ON votes TO polis_probe_reader WITH GRANT OPTION','GRANT_AUTHORITY')

    def test_transaction_rolls_back_partial_grants(self):
        with self.conn:
            with self.conn.cursor() as c:c.execute('DROP TABLE math_ticks')
        with self.assertRaises(psycopg2.errors.UndefinedTable):self.install()
        self.assertFalse(self.exists())


    def grant(self, ddl):
        with self.conn:
            with self.conn.cursor() as c:c.execute(ddl)

    def test_no_public_defaults(self):
        self.assertEqual(self.install(), [])

    def test_public_database_create(self):
        self.install()
        self.grant(sql.SQL('GRANT CREATE ON DATABASE {} TO PUBLIC').format(sql.Identifier(self.database)))
        self.assertEqual(self.install(), ['database-create'])

    def test_stock_null_acls_and_all_reported_defaults(self):
        # Restore PostgreSQL's implicit routine ACL; the verifier must use
        # acldefault for proacl NULL, not silently omit the finding.
        self.grant('ALTER DEFAULT PRIVILEGES GRANT EXECUTE ON FUNCTIONS TO PUBLIC')
        self.grant("CREATE FUNCTION public.reader_function() RETURNS integer LANGUAGE sql AS 'SELECT 1'")
        self.grant(sql.SQL('GRANT CREATE, TEMP ON DATABASE {} TO PUBLIC').format(sql.Identifier(self.database)))
        self.grant('GRANT CREATE ON SCHEMA public TO PUBLIC')
        with self.conn.cursor() as c:
            c.execute("SELECT proacl FROM pg_proc WHERE oid='public.reader_function()'::regprocedure")
            self.assertIsNone(c.fetchone()[0])
        expected=['database-create','database-temp','schema-create','routine-execute']
        self.assertEqual(self.install(), expected)
        self.assertEqual(self.install(), expected)
        with self.conn.cursor() as c:
            c.execute("SELECT has_database_privilege(%s,%s,'TEMP'),has_schema_privilege(%s,'public','CREATE'),has_function_privilege(%s,'public.reader_function()','EXECUTE')",(ROLE,self.database,ROLE,ROLE))
            self.assertEqual(c.fetchone(),(True,True,True))

    def test_direct_database_rights_even_with_public(self):
        for privilege in ('CREATE','TEMP'):
            for public in (False,True):
                with self.subTest(privilege=privilege,public=public):
                    self.install()
                    grant=sql.SQL('GRANT '+privilege+' ON DATABASE {} TO ').format(sql.Identifier(self.database))
                    if public:self.grant(grant+sql.SQL('PUBLIC'))
                    self.grant(grant+sql.Identifier(ROLE))
                    with self.assertRaisesRegex(ValueError,'READER_DATABASE_AUTHORITY'):self.install()
                    self.grant(sql.SQL('REVOKE CREATE, TEMP ON DATABASE {} FROM PUBLIC, {}').format(sql.Identifier(self.database),sql.Identifier(ROLE)))

    def test_direct_schema_right_even_with_public(self):
        for public in (False,True):
            with self.subTest(public=public):
                self.install()
                if public:self.grant('GRANT CREATE ON SCHEMA public TO PUBLIC')
                self.grant('GRANT CREATE ON SCHEMA public TO polis_probe_reader')
                with self.assertRaisesRegex(ValueError,'READER_SCHEMA_AUTHORITY'):self.install()
                self.grant('REVOKE CREATE ON SCHEMA public FROM PUBLIC, polis_probe_reader')

    def test_direct_routine_right_even_with_public(self):
        self.install()
        self.grant("CREATE FUNCTION public.reader_function() RETURNS integer LANGUAGE sql AS 'SELECT 1'")
        for public in (False,True):
            with self.subTest(public=public):
                if public:self.grant('GRANT EXECUTE ON FUNCTION public.reader_function() TO PUBLIC')
                self.grant('GRANT EXECUTE ON FUNCTION public.reader_function() TO polis_probe_reader')
                with self.assertRaisesRegex(ValueError,'READER_FUNCTION_AUTHORITY'):self.install()
                self.grant('REVOKE EXECUTE ON FUNCTION public.reader_function() FROM PUBLIC, polis_probe_reader')

    def test_membership_with_public_still_refused(self):
        self.install()
        self.grant('GRANT CREATE ON SCHEMA public TO PUBLIC; GRANT pg_read_all_data TO polis_probe_reader')
        with self.assertRaisesRegex(ValueError,'READER_MEMBERSHIP'):self.install()

    def test_schema_owner_refused(self):
        self.drift('ALTER SCHEMA public OWNER TO polis_probe_reader','READER_OBJECT_OWNER')
        self.grant('ALTER SCHEMA public OWNER TO pg_database_owner')

    def test_routine_owner_refused(self):
        self.drift("CREATE FUNCTION public.reader_function() RETURNS integer LANGUAGE sql AS 'SELECT 1'; ALTER FUNCTION public.reader_function() OWNER TO polis_probe_reader",'READER_OBJECT_OWNER')

    def test_table_owner_refused(self):
        self.drift('ALTER TABLE votes OWNER TO polis_probe_reader','READER_OBJECT_OWNER')
        self.grant('ALTER TABLE votes OWNER TO postgres')

    def test_database_owner_refused(self):
        # PostgreSQL exposes database ownership as pg_database_owner membership.
        self.drift(sql.SQL('ALTER DATABASE {} OWNER TO polis_probe_reader').format(sql.Identifier(self.database)),'READER_MEMBERSHIP')
        self.grant(sql.SQL('ALTER DATABASE {} OWNER TO postgres').format(sql.Identifier(self.database)))

    def test_schema_usage_grant_option_refused(self):
        self.drift('GRANT USAGE ON SCHEMA public TO polis_probe_reader WITH GRANT OPTION','READER_GRANT_AUTHORITY')

    def test_database_connect_grant_option_refused(self):
        self.drift(sql.SQL('GRANT CONNECT ON DATABASE {} TO polis_probe_reader WITH GRANT OPTION').format(sql.Identifier(self.database)),'READER_GRANT_AUTHORITY')

    def test_public_create_on_other_schema_refused(self):
        self.install()
        self.grant('CREATE SCHEMA reader_other; GRANT CREATE ON SCHEMA reader_other TO PUBLIC')
        try:
            with self.assertRaisesRegex(ValueError,'READER_SCHEMA_AUTHORITY'):self.install()
        finally:self.grant('DROP SCHEMA reader_other')

    def test_explicit_default_routine_acl_refused(self):
        self.drift('ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT EXECUTE ON FUNCTIONS TO PUBLIC','READER_DEFAULT_AUTHORITY')
        self.grant('ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC')

    def test_explicit_default_reader_acl_refused(self):
        self.drift('ALTER DEFAULT PRIVILEGES GRANT SELECT ON TABLES TO polis_probe_reader','READER_DEFAULT_AUTHORITY')

    def test_public_procedure_execute(self):
        self.install()
        self.grant("CREATE PROCEDURE public.reader_procedure() LANGUAGE sql AS 'SELECT 1'; GRANT EXECUTE ON PROCEDURE public.reader_procedure() TO PUBLIC")
        try:
            self.assertEqual(self.install(), ['routine-execute'])
            self.grant('GRANT EXECUTE ON PROCEDURE public.reader_procedure() TO polis_probe_reader')
            with self.assertRaisesRegex(ValueError,'READER_FUNCTION_AUTHORITY'):self.install()
        finally:self.grant('DROP PROCEDURE public.reader_procedure()')

    def test_indirect_noinherit_membership_refused(self):
        self.install()
        self.grant('CREATE ROLE reader_parent NOINHERIT; CREATE ROLE reader_ancestor; GRANT reader_ancestor TO reader_parent; GRANT reader_parent TO polis_probe_reader; GRANT CREATE ON SCHEMA public TO reader_ancestor, PUBLIC')
        try:
            with self.assertRaisesRegex(ValueError,'READER_MEMBERSHIP'):self.install()
        finally:
            self.grant('DROP OWNED BY reader_parent, reader_ancestor; DROP ROLE reader_parent, reader_ancestor')


if __name__=='__main__':unittest.main()
