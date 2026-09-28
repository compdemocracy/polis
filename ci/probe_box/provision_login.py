"""Transactional reader-login operation for the disposable in-VPC CLI.
No automatic database mutation during native stack deployment.
"""
from __future__ import annotations
import json

TABLES = ('conversations','votes','comments','participants','math_main','math_ticks')
ROLE = 'polis_probe_reader'
PUBLIC_DEFAULTS = ('database-create', 'database-temp', 'schema-create', 'routine-execute')


def validate_public_defaults(value):
    """Only an ordered, duplicate-free subset of the reviewed finding tokens."""
    if (type(value) is not list or any(type(v) is not str or v not in PUBLIC_DEFAULTS for v in value)
            or value != [v for v in PUBLIC_DEFAULTS if v in value]):
        raise ValueError('PUBLIC_DEFAULTS')
    return value


def _public_only_rights(cur, rows, rights, refusal):
    """Inspect provenance, including redundant direct grants and implicit ACLs.

    Membership and broad role attributes have already been refused. Each row is
    (owner-is-reader, ACL); PostgreSQL's acldefault supplies an absent ACL.
    Ownership and grant options are authority even without an effective privilege.
    """
    observed = set()
    for owned, acl in rows:
        if owned: raise ValueError('READER_OBJECT_OWNER')
        cur.execute("""SELECT grantee, privilege_type, is_grantable,
            grantee=(SELECT oid FROM pg_roles WHERE rolname=%s)
            FROM aclexplode(%s::aclitem[])""", (ROLE, acl))
        for grantee, privilege, grantable, direct in cur.fetchall():
            if (direct or grantee == 0) and grantable:
                raise ValueError('READER_GRANT_AUTHORITY')
            if privilege in rights:
                if direct: raise ValueError(refusal)
                if grantee == 0: observed.add(rights[privilege])
    return observed


def provision(connection: object, password: str, database: str, owner: str) -> list[str]:
    from psycopg2 import sql
    with connection:
        with connection.cursor() as cur:
            cur.execute('SELECT pg_is_in_recovery()')
            if cur.fetchone()[0]: raise ValueError('PRIMARY_REQUIRED_FOR_LOGIN')
            cur.execute("SELECT pg_advisory_xact_lock(hashtext('polis_probe_reader'))")
            cur.execute("SELECT shobj_description(oid,'pg_authid') FROM pg_roles WHERE rolname=%s",(ROLE,))
            existing=cur.fetchone()
            if existing and existing[0]!=owner: raise ValueError('FOREIGN_READER_ROLE')
            role=sql.Identifier(ROLE)
            if not existing:
                cur.execute(sql.SQL('CREATE ROLE {} LOGIN NOSUPERUSER NOINHERIT NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS CONNECTION LIMIT 4').format(role))
                cur.execute(sql.SQL('COMMENT ON ROLE {} IS {}').format(role,sql.Literal(owner)))
            cur.execute(sql.SQL('ALTER ROLE {} PASSWORD {}').format(role,sql.Literal(password)))
            cur.execute(sql.SQL('ALTER ROLE {} SET default_transaction_read_only = on').format(role))
            cur.execute(sql.SQL('ALTER ROLE {} SET statement_timeout = \'30min\'').format(role))
            cur.execute(sql.SQL('ALTER ROLE {} SET search_path = pg_catalog, public').format(role))
            cur.execute(sql.SQL('GRANT CONNECT ON DATABASE {} TO {}').format(sql.Identifier(database),role))
            cur.execute(sql.SQL('GRANT USAGE ON SCHEMA public TO {}').format(role))
            for table in TABLES:
                cur.execute(sql.SQL('GRANT SELECT ON public.{} TO {}').format(sql.Identifier(table),role))
            return verify_effective_rights(cur, database)




def verify_effective_rights(cur, database: str) -> list[str]:
    """Check effective privileges, including PUBLIC and SET ROLE authority.

    This verifies and refuses drift transactionally; it never repairs grants.
    System catalog reads and built-in functions are PostgreSQL baseline rights.
    PUBLIC-only database CREATE/TEMP, public-schema CREATE and routine EXECUTE
    are reported findings. Direct authority and explicit future grants refuse.
    """
    cur.execute('SELECT rolsuper,rolcreaterole,rolcreatedb,rolreplication,rolbypassrls,rolinherit FROM pg_roles WHERE rolname=%s',(ROLE,))
    if any(cur.fetchone()): raise ValueError('BROAD_READER_ROLE')
    # MEMBER includes indirect and NOINHERIT memberships (SET ROLE is authority).
    cur.execute("SELECT 1 FROM pg_roles WHERE rolname<>%s AND pg_has_role(%s,oid,'MEMBER') LIMIT 1",(ROLE,ROLE))
    if cur.fetchone(): raise ValueError('READER_MEMBERSHIP')
    cur.execute("""SELECT datdba=(SELECT oid FROM pg_roles WHERE rolname=%s),
        COALESCE(datacl,acldefault('d',datdba)) FROM pg_database WHERE datname=%s""",(ROLE,database))
    rows=cur.fetchall()
    if len(rows)!=1: raise ValueError('READER_DATABASE_AUTHORITY')
    findings=_public_only_rights(cur, rows,
        {'CREATE':'database-create','TEMPORARY':'database-temp'}, 'READER_DATABASE_AUTHORITY')
    cur.execute("""SELECT nspowner=(SELECT oid FROM pg_roles WHERE rolname=%s),
        COALESCE(nspacl,acldefault('n',nspowner)) FROM pg_namespace WHERE nspname='public'""",(ROLE,))
    findings.update(_public_only_rights(cur, cur.fetchall(),
        {'CREATE':'schema-create'}, 'READER_SCHEMA_AUTHORITY'))
    cur.execute("""SELECT 1 FROM pg_namespace WHERE nspname !~ '^pg_' AND nspname<>'information_schema'
        AND nspowner=(SELECT oid FROM pg_roles WHERE rolname=%s) LIMIT 1""",(ROLE,))
    if cur.fetchone(): raise ValueError('READER_OBJECT_OWNER')
    cur.execute("""SELECT 1 FROM pg_namespace WHERE nspname !~ '^pg_' AND nspname NOT IN ('information_schema','public')
        AND has_schema_privilege(%s,oid,'CREATE,USAGE') LIMIT 1""",(ROLE,))
    if cur.fetchone(): raise ValueError('READER_SCHEMA_AUTHORITY')
    cur.execute("""SELECT c.oid,n.nspname,c.relname,c.relkind,c.relowner=(SELECT oid FROM pg_roles WHERE rolname=%s)
        FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
        WHERE n.nspname !~ '^pg_' AND n.nspname<>'information_schema'
          AND c.relkind IN ('r','p','v','m','f','S')""",(ROLE,))
    for oid, namespace, name, kind, owned in cur.fetchall():
        if owned: raise ValueError('READER_OBJECT_OWNER')
        if kind=='S':
            cur.execute("SELECT has_sequence_privilege(%s,%s,'USAGE,SELECT,UPDATE')",(ROLE,oid))
            if cur.fetchone()[0]: raise ValueError('READER_SEQUENCE_AUTHORITY')
        elif namespace=='public' and name in TABLES:
            cur.execute("SELECT has_table_privilege(%s,%s,'INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER,MAINTAIN') OR has_any_column_privilege(%s,%s,'INSERT,UPDATE,REFERENCES')",(ROLE,oid,ROLE,oid))
            if cur.fetchone()[0]: raise ValueError('READER_DML_AUTHORITY')
            cur.execute("""SELECT 1 FROM aclexplode((SELECT relacl FROM pg_class WHERE oid=%s))
                WHERE grantee IN (0,(SELECT oid FROM pg_roles WHERE rolname=%s)) AND is_grantable
                UNION ALL SELECT 1 FROM pg_attribute a, LATERAL aclexplode(a.attacl) acl
                WHERE a.attrelid=%s AND acl.grantee IN (0,(SELECT oid FROM pg_roles WHERE rolname=%s)) AND acl.is_grantable LIMIT 1""",(oid,ROLE,oid,ROLE))
            if cur.fetchone(): raise ValueError('READER_GRANT_AUTHORITY')
        else:
            cur.execute("SELECT has_table_privilege(%s,%s,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER,MAINTAIN') OR has_any_column_privilege(%s,%s,'SELECT,INSERT,UPDATE,REFERENCES')",(ROLE,oid,ROLE,oid))
            if cur.fetchone()[0]: raise ValueError('READER_EXTRA_TABLE_AUTHORITY')
    cur.execute("""SELECT p.proowner=(SELECT oid FROM pg_roles WHERE rolname=%s),
        COALESCE(p.proacl,acldefault('f',p.proowner))
        FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
        WHERE n.nspname !~ '^pg_' AND n.nspname<>'information_schema'""",(ROLE,))
    findings.update(_public_only_rights(cur, cur.fetchall(),
        {'EXECUTE':'routine-execute'}, 'READER_FUNCTION_AUTHORITY'))
    # Explicit default ACL entries grant access to future objects. Also reject
    # positive global defaults (e.g. an owner setting defaults for another role
    # while retaining implicit PUBLIC EXECUTE). No new DDL is performed here.
    cur.execute("""SELECT 1 FROM pg_default_acl d, LATERAL aclexplode(d.defaclacl) acl
        WHERE acl.grantee IN (0,(SELECT oid FROM pg_roles WHERE rolname=%s)) LIMIT 1""",(ROLE,))
    if cur.fetchone(): raise ValueError('READER_DEFAULT_AUTHORITY')
    return [value for value in PUBLIC_DEFAULTS if value in findings]


def execute(boot, client, connect=None):
    """Read only the two admitted secret versions; keep credentials in memory."""
    if connect is None:
        import psycopg2
        connect = psycopg2.connect
    versions = boot['provision']
    def secret(arn, version):
        response=client.get_secret_value(SecretId=arn, VersionId=version)
        if response.get('VersionId') != version: raise ValueError('SECRET_VERSION')
        value=json.loads(response['SecretString'])
        if not isinstance(value,dict) or any(type(value.get(k)) is not str or not value[k] for k in ('username','password')):
            raise ValueError('SECRET_SCHEMA')
        return value
    admin = secret(boot['adminSecretArn'], versions['adminVersion'])
    reader = secret(boot['secretArn'], versions['readerVersion'])
    if set(reader) != {'username','password'} or reader['username'] != ROLE:
        raise ValueError('READER_SECRET')
    connection = connect(host=boot['replicaHost'], port=5432, dbname=boot['database'],
        user=admin['username'], password=admin['password'], connect_timeout=10,
        sslmode='verify-full', sslrootcert='/opt/polis-probe/rds-ca.pem')
    try:
        return provision(connection, reader['password'], boot['database'], boot['owner'])
    finally:
        connection.close()
