"""Restore a validated catalog layout into an explicitly owned PG17 fixture.

Object definitions must already come from the reviewed baseline/profile. The
census carries no column types or function bodies and is never executable SQL.
"""
from __future__ import annotations
from collections import Counter
import json
from psycopg2 import sql, Error
from psycopg2.extensions import TRANSACTION_STATUS_IDLE
from roles_census import FAMILIES, normalize, encoded, validate_receipt, validate_census, identity as catalog_identity
from roles_queries import QUERIES, MAX_FAMILY_ROWS

ATTRIBUTE={'superuser':'SUPERUSER','inherit':'INHERIT','create_role':'CREATEROLE','create_db':'CREATEDB',
           'login':'LOGIN','replication':'REPLICATION','bypass_rls':'BYPASSRLS'}


def snapshot_rows(cursor):
    cursor.execute("SET LOCAL search_path=pg_catalog; SET LOCAL TimeZone='UTC'; SET LOCAL DateStyle='ISO, YMD'")
    rows={}
    for name in FAMILIES:
        cursor.execute(QUERIES[name]);rows[name]=[r[0] for r in cursor.fetchall()]
        if len(rows[name])>MAX_FAMILY_ROWS:raise ValueError('REVERSAL_CATALOG_LIMIT')
    for r in rows['policies']:r['roles'].sort(key=encoded)
    for r in rows['default_acls']:r['entries'].sort(key=encoded)
    return normalize(rows)


def snapshot(conn):
    with conn:
        with conn.cursor() as c:return snapshot_rows(c)


def apply_grants(cursor,commands):
    """Order grant chains by authority, retaining exact grantors or fail closed."""
    pending=list(commands)
    while pending:
        retry=[]
        for grantor,command in pending:
            cursor.execute('SAVEPOINT replay_grant')
            try:
                cursor.execute(sql.SQL('SET LOCAL ROLE {}').format(sql.Identifier(grantor)))
                cursor.execute(command)
                cursor.execute('RESET ROLE')
            except Error:
                cursor.execute('ROLLBACK TO SAVEPOINT replay_grant')
                retry.append((grantor,command))
            cursor.execute('RELEASE SAVEPOINT replay_grant')
        if len(retry)==len(pending):raise ValueError('REVERSAL_GRANT_CHAIN_UNMODELED')
        pending=retry


def principal(value):
    return sql.SQL('PUBLIC') if value['kind']=='PUBLIC' else sql.Identifier(value['name'])


def object_sql(kind,identity):
    if kind in ('DATABASE','SCHEMA'):return sql.Identifier(identity[0])
    if kind=='COLUMN':return sql.Identifier(*identity[:2])
    if kind=='ROUTINE':
        return sql.SQL('{}({})').format(sql.Identifier(*identity[:2]),sql.SQL(',').join(sql.Identifier(*t) for t in identity[2]))
    return sql.Identifier(*identity)


def object_kind(kind):
    return {'RELATION':'TABLE','COLUMN':'TABLE','ROUTINE':'ROUTINE'}.get(kind,kind)


def restore(conn,receipt,job,*,settings_presence=False):
    parameters=conn.get_dsn_parameters()
    try:port=int(parameters.get('port','0'))
    except (TypeError,ValueError):raise ValueError('REVERSAL_ISOLATED_PG17_REQUIRED') from None
    if (parameters.get('host')!='127.0.0.1' or parameters.get('dbname')!='probe_test'
            or not 55432<=port<=65000):
        raise ValueError('REVERSAL_ISOLATED_PG17_REQUIRED')
    validate_receipt(receipt,job)
    if receipt['verdict']!='PASS' or receipt['coverage']['external_dependencies']:
        raise ValueError('REVERSAL_CENSUS_INCOMPLETE')
    wanted=receipt['census']
    if (any(r['scope']=='OTHER' or r['rows']!=1 or r['config_count']!=1 for r in wanted['role_settings'])
        or any(r['config_count']>1 or r['config_present']!=(r['config_count']>0) for r in wanted['roles'])
        or wanted['role_settings'] and not settings_presence):raise ValueError('REVERSAL_SETTINGS_UNMODELED')
    if conn.get_transaction_status()!=TRANSACTION_STATUS_IDLE:
        raise ValueError('REVERSAL_IDLE_CONNECTION_REQUIRED')
    before=snapshot(conn)
    if any(r['kind'] not in ('f','p') for r in wanted['routines']):
        raise ValueError('REVERSAL_ROUTINE_KIND_UNMODELED')
    # SQL cannot reset an explicit object ACL to its original NULL catalog
    # representation. Require a clean reviewed baseline for DEFAULT objects.
    for family in ('database','schemas','relations','columns','routines'):
        actual={catalog_identity(r,family):r for r in before[family]}
        for r in wanted[family]:
            old=actual.get(catalog_identity(r,family))
            if old and r['acl_state']=='DEFAULT' and old['acl_state']!='DEFAULT':
                raise ValueError('REVERSAL_DEFAULT_ACL_BASELINE')
    desired_defaults={catalog_identity(r,'default_acls') for r in wanted['default_acls']}
    if any(catalog_identity(r,'default_acls') not in desired_defaults for r in before['default_acls']):
        raise ValueError('REVERSAL_EXTRA_DEFAULT_ACL')
    if any(a['grantor']!=r['owner'] for r in wanted['default_acls'] for a in r['entries']):
        raise ValueError('REVERSAL_DEFAULT_GRANTOR')
    for r in wanted['roles']:
        old=next((x for x in before['roles'] if x['name']==r['name']),None)
        if old and r['valid_until'] is None and old['valid_until'] is not None:
            raise ValueError('REVERSAL_VALID_UNTIL_BASELINE')
    # The caller must install reviewed object definitions first. Never invent
    # unknown types, no-op functions, foreign servers or policy expressions.
    for family,keys in [('relations',('schema','name','kind')),('columns',('relation','name','number')),
                        ('routines',('schema','name','kind','input_types','argument_modes'))]:
        shape=lambda rows:sorted(encoded([r[k] for k in keys]) for r in rows)
        if shape(before[family])!=shape(wanted[family]):raise ValueError('REVERSAL_BASELINE_MISMATCH')
    if before['database'][0]['name']!=wanted['database'][0]['name']:raise ValueError('REVERSAL_DATABASE')
    with conn:
        with conn.cursor() as c:
            c.execute("SELECT current_setting('server_version_num')::int, current_database(), rolsuper FROM pg_roles WHERE rolname=current_user")
            version,db,superuser=c.fetchone()
            if version//10000!=17 or db!='probe_test' or not superuser:raise ValueError('REVERSAL_ISOLATED_PG17_REQUIRED')
            c.execute('SELECT EXISTS(SELECT FROM pg_authid WHERE rolpassword IS NOT NULL)')
            if c.fetchone()[0]:raise ValueError('REVERSAL_PASSWORD_BASELINE_REFUSED')
            c.execute('SELECT rolname FROM pg_roles');existing={r[0] for r in c.fetchall()}
            wanted_names={r['name'] for r in wanted['roles']}
            if existing-wanted_names:raise ValueError('REVERSAL_EXTRA_ROLE')
            for setting in before['role_settings']:
                if setting['scope']=='OTHER':raise ValueError('REVERSAL_SETTINGS_UNMODELED')
                if setting['scope']=='CURRENT':
                    if setting['role'] is None:
                        c.execute(sql.SQL('ALTER DATABASE {} RESET ALL').format(sql.Identifier(db)))
                    else:
                        c.execute(sql.SQL('ALTER ROLE {} IN DATABASE {} RESET ALL').format(sql.Identifier(setting['role']),sql.Identifier(db)))
            for r in wanted['roles']:
                name=r['name']
                if name.startswith('pg_') or name=='postgres':
                    current=next((x for x in before['roles'] if x['name']==name),None)
                    if current!=r:raise ValueError('REVERSAL_BUILTIN_ROLE')
                    continue
                if name not in existing:c.execute(sql.SQL('CREATE ROLE {}').format(sql.Identifier(name)))
                flags=' '.join(('' if r[k] else 'NO')+v for k,v in ATTRIBUTE.items())
                q=sql.SQL('ALTER ROLE {} '+flags+' CONNECTION LIMIT {}').format(sql.Identifier(name),sql.Literal(r['connection_limit']))
                if r['valid_until'] is not None:q+=sql.SQL(' VALID UNTIL {}').format(sql.Literal(r['valid_until']))
                c.execute(q)
                c.execute(sql.SQL('ALTER ROLE {} RESET ALL').format(sql.Identifier(name)))
                if r['config_count']:
                    c.execute(sql.SQL("ALTER ROLE {} SET application_name='rehearsal-presence-only'").format(sql.Identifier(name)))
            dbrow=wanted['database'][0]
            c.execute(sql.SQL('ALTER DATABASE {} OWNER TO {}').format(sql.Identifier(db),sql.Identifier(dbrow['owner'])))
            c.execute(sql.SQL('ALTER DATABASE {} ALLOW_CONNECTIONS {} CONNECTION LIMIT {}').format(
                sql.Identifier(db),sql.SQL(str(dbrow['allow_connections']).upper()),sql.Literal(dbrow['connection_limit'])))
            # Preserve identical edges; rebuild changed edges with their exact
            # recorded grantor and all PostgreSQL 17 membership options.
            for r in before['memberships']:
                if r not in wanted['memberships']:
                    c.execute(sql.SQL('REVOKE {} FROM {} GRANTED BY {}').format(*map(sql.Identifier,(r['role'],r['member'],r['grantor']))))
            membership_commands=[]
            for r in wanted['memberships']:
                if r in before['memberships']:continue
                membership_commands.append((r['grantor'],sql.SQL('GRANT {} TO {} WITH ADMIN {}, INHERIT {}, SET {} GRANTED BY {}').format(sql.Identifier(r['role']),sql.Identifier(r['member']),*[sql.SQL(str(r[k]).upper()) for k in ('admin','inherit','set')],sql.Identifier(r['grantor']))))
            apply_grants(c,membership_commands)

            for r in wanted['schemas']:
                c.execute(sql.SQL('ALTER SCHEMA {} OWNER TO {}').format(sql.Identifier(r['name']),sql.Identifier(r['owner'])))
            for r in wanted['relations']:
                kind={'S':'SEQUENCE','v':'VIEW','m':'MATERIALIZED VIEW','f':'FOREIGN TABLE'}.get(r['kind'],'TABLE')
                if r['kind'] in ('i','I','t'):continue
                c.execute(sql.SQL('ALTER '+kind+' {} OWNER TO {}').format(sql.Identifier(r['schema'],r['name']),sql.Identifier(r['owner'])))
                if r['kind'] in ('r','p'):
                    c.execute(sql.SQL('ALTER TABLE {} '+('ENABLE' if r['row_security'] else 'DISABLE')+' ROW LEVEL SECURITY').format(sql.Identifier(r['schema'],r['name'])))
                    c.execute(sql.SQL('ALTER TABLE {} '+('FORCE' if r['force_row_security'] else 'NO FORCE')+' ROW LEVEL SECURITY').format(sql.Identifier(r['schema'],r['name'])))
            for r in wanted['routines']:
                target=object_sql('ROUTINE',[r['schema'],r['name'],r['input_types']])
                c.execute(sql.SQL('ALTER ROUTINE {} OWNER TO {}').format(target,sql.Identifier(r['owner'])))
                c.execute(sql.SQL('ALTER ROUTINE {} SECURITY '+('DEFINER' if r['security_definer'] else 'INVOKER')).format(target))
            # Replay only explicit ACLs; DEFAULT and EMPTY remain distinguishable.
            objects=[]
            for family,kind in [('database','DATABASE'),('schemas','SCHEMA'),('relations','RELATION'),('columns','COLUMN'),('routines','ROUTINE')]:
                for r in wanted[family]:
                    k='SEQUENCE' if family=='relations' and r['kind']=='S' else kind
                    if family=='relations' and r['kind'] in ('i','I','c','t'):continue
                    identity=[r['name']] if family in ('database','schemas') else [*r['relation'],r['name']] if family=='columns' else [r['schema'],r['name'],r['input_types']] if family=='routines' else [r['schema'],r['name']]
                    objects.append((k,identity,r['acl_state']))
            grants=[]
            for kind,identity,state in objects:
                if state=='DEFAULT':continue
                target=object_sql(kind,identity)
                privilege=sql.SQL('ALL ({})').format(sql.Identifier(identity[2])) if kind=='COLUMN' else sql.SQL('ALL')
                for who in [sql.SQL('PUBLIC')]+[sql.Identifier(x) for x in wanted_names]:
                    c.execute(sql.SQL('REVOKE {} ON '+object_kind(kind)+' {} FROM {} CASCADE').format(privilege,target,who))
                for acl in [a for a in wanted['acls'] if a['kind']==kind and a['object']==identity]:
                    privilege=sql.SQL(acl['privilege'])
                    if kind=='COLUMN':privilege=sql.SQL('{} ({})').format(privilege,sql.Identifier(identity[2]))
                    grants.append((acl['grantor'],sql.SQL('GRANT {} ON '+object_kind(kind)+' {} TO {}'+(' WITH GRANT OPTION' if acl['grantable'] else '')).format(privilege,target,principal(acl['grantee']))))
            apply_grants(c,grants)
            for r in wanted['default_acls']:
                noun={'RELATION':'TABLES','SEQUENCE':'SEQUENCES','ROUTINE':'FUNCTIONS','TYPE':'TYPES','SCHEMA':'SCHEMAS'}[r['kind']]
                head=sql.SQL('ALTER DEFAULT PRIVILEGES FOR ROLE {} '+('IN SCHEMA public ' if r['scope']=='PUBLIC' else '')).format(sql.Identifier(r['owner']))
                for who in [sql.SQL('PUBLIC')]+[sql.Identifier(x) for x in wanted_names]:
                    c.execute(head+sql.SQL('REVOKE ALL ON '+noun+' FROM {}').format(who))
                for a in r['entries']:
                    if a['grantor']!=r['owner']:raise ValueError('REVERSAL_DEFAULT_GRANTOR')
                    c.execute(head+sql.SQL('GRANT '+a['privilege']+' ON '+noun+' TO {}'+(' WITH GRANT OPTION' if a['grantable'] else '')).format(principal(a['grantee'])))
            for r in before['policies']:
                c.execute(sql.SQL('DROP POLICY {} ON {}').format(sql.Identifier(r['name']),sql.Identifier(*r['relation'])))
            for r in wanted['policies']:
                command={'*':'ALL','r':'SELECT','a':'INSERT','w':'UPDATE','d':'DELETE'}[r['command']]
                q=sql.SQL('CREATE POLICY {} ON {} AS '+('PERMISSIVE' if r['permissive'] else 'RESTRICTIVE')+' FOR '+command+' TO {}').format(sql.Identifier(r['name']),sql.Identifier(*r['relation']),sql.SQL(',').join(principal(x) for x in r['roles']))
                for key,clause in [('using',' USING '),('with_check',' WITH CHECK ')]:
                    if r[key]!='ABSENT':q+=sql.SQL(clause+'('+r[key]+')')
                c.execute(q)
            for r in wanted['role_settings']:
                if r['scope']=='CURRENT':
                    if r['role'] is None:raise ValueError('REVERSAL_SETTINGS_UNMODELED')
                    c.execute(sql.SQL("ALTER ROLE {} IN DATABASE {} SET application_name='rehearsal-presence-only'").format(sql.Identifier(r['role']),sql.Identifier(db)))
            # Verify before committing; mismatch must roll back every change.
            for r in wanted['role_settings']:
                if r['scope']=='SHARED' and r['role'] is None:
                    raise ValueError('REVERSAL_SETTINGS_UNMODELED')
            actual=snapshot_rows(c)
            if actual!=wanted:raise ValueError('REVERSAL_PROJECTION_MISMATCH')
    return actual


def residue(before,after):
    """Describe typed catalog changes; never normalize away ACL representation."""
    validate_census(before,complete=False);validate_census(after,complete=False)
    result={'schema':'polis-reversal-residue/1','families':{},'changes':{}}
    for family in FAMILIES:
        a,b=Counter(map(encoded,before[family])),Counter(map(encoded,after[family]))
        result['families'][family]={'added':sum((b-a).values()),'removed':sum((a-b).values())}
        left={catalog_identity(r,family):r for r in before[family]}
        right={catalog_identity(r,family):r for r in after[family]}
        changes=[]
        for key in sorted(left.keys()|right.keys()):
            if key not in left:kind,fields='ADDED',[]
            elif key not in right:kind,fields='REMOVED',[]
            else:
                fields=sorted(k for k in left[key] if left[key][k]!=right[key][k])
                if not fields:continue
                kind='CHANGED'
            changes.append({'identity':json.loads(key),'change':kind,'fields':fields})
        result['changes'][family]=changes
    flat=[(family,r) for family,rows in result['changes'].items() for r in rows]
    result['verdict']='PRESERVED' if not flat else 'RESIDUE'
    result['classification']=('NONE' if not flat else 'ACL_REPRESENTATION_ONLY'
        if all(r['change']=='CHANGED' and r['fields']==['acl_state'] for _,r in flat)
        else 'CATALOG_LAYOUT_CHANGED')
    return result
