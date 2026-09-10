"""Reviewable primary-side login creation; never run from a probe instance.

The CloudFormation provider retains the owned login on Delete. A foreign role
with the same name is refused, never adopted or modified. Secrets remain in
Secrets Manager; exceptions are reduced to one fixed failure before returning.
"""
from __future__ import annotations
import json

TABLES = ('conversations','votes','comments','participants','math_main','math_ticks')
ROLE = 'polis_probe_reader'


def provision(connection: object, password: str, database: str, owner: str) -> None:
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
            cur.execute('SELECT rolsuper,rolcreaterole,rolcreatedb,rolreplication,rolbypassrls,rolinherit FROM pg_roles WHERE rolname=%s',(ROLE,))
            if any(cur.fetchone()): raise ValueError('BROAD_READER_ROLE')
            cur.execute('SELECT 1 FROM pg_auth_members WHERE member=(SELECT oid FROM pg_roles WHERE rolname=%s)',(ROLE,))
            if cur.fetchone(): raise ValueError('READER_MEMBERSHIP')
            for table in TABLES:
                cur.execute("SELECT has_table_privilege(%s,%s,'INSERT,UPDATE,DELETE,TRUNCATE,TRIGGER') OR has_any_column_privilege(%s,%s,'INSERT,UPDATE')",(ROLE,'public.'+table,ROLE,'public.'+table))
                if cur.fetchone()[0]: raise ValueError('READER_DML_AUTHORITY')


def handler(event: dict, context: object) -> dict:
    physical=event.get('PhysicalResourceId','polis-probe-reader')
    if event['RequestType']=='Delete': return {'PhysicalResourceId':physical}
    try:
        import boto3
        import psycopg2
        p=event['ResourceProperties']
        client=boto3.client('secretsmanager',endpoint_url=p['SecretsUrl'])
        admin=json.loads(client.get_secret_value(SecretId=p['AdminSecretArn'])['SecretString'])
        reader=json.loads(client.get_secret_value(SecretId=p['ReaderSecretArn'])['SecretString'])
        if set(reader)!={'username','password'} or reader['username']!=ROLE: raise ValueError('READER_SECRET')
        conn=psycopg2.connect(host=p['PrimaryHost'],port=5432,dbname=p['Database'],user=admin['username'],password=admin['password'],
                             connect_timeout=10,sslmode='verify-full',sslrootcert='/opt/rds-ca.pem')
        try: provision(conn,reader['password'],p['Database'],'polis-probe-login:'+event['StackId'])
        finally: conn.close()
        return {'PhysicalResourceId':physical}
    except Exception:
        raise RuntimeError('READER_PROVISION_FAILED') from None
