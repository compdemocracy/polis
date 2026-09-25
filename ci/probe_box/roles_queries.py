"""Fixed PG17 catalog statements. No job-supplied SQL or application calls."""
from __future__ import annotations

# The one reviewed census capacity (polis-roles-census-policy/2). The policy,
# closed validation, this SQL LIMIT, the reader's bounded fetch and the local
# reversal snapshot all derive from these values; a job cannot change them.
# Nested per-row bounds are separate (roles_census.MAX_NESTED_ENTRIES).
MAX_FAMILY_ROWS = 4096
MAX_ROWS = 16384
MAX_BYTES = 1048576


def obj(**fields):
    return 'pg_catalog.jsonb_build_object('+','.join("'"+k+"',"+v for k,v in fields.items())+')'


def state(column):
    return f"CASE WHEN {column} IS NULL THEN 'DEFAULT' WHEN pg_catalog.cardinality({column})=0 THEN 'EMPTY' ELSE 'EXPLICIT' END"


def who(oid):
    return f"(SELECT rolname FROM pg_catalog.pg_roles WHERE oid={oid})"


def principal(oid):
    return obj(kind=f"CASE WHEN {oid}=0 THEN 'PUBLIC' ELSE 'ROLE' END",name=who(oid))


REL = "pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace"
PUBLIC = "n.nspname='public'"
RID = "pg_catalog.jsonb_build_array(n.nspname,c.relname)"
TYPES = "(SELECT COALESCE(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_array(tn.nspname,t.typname) ORDER BY a.ord),'[]'::jsonb) FROM pg_catalog.unnest(p.proargtypes) WITH ORDINALITY a(oid,ord) JOIN pg_catalog.pg_type t ON t.oid=a.oid JOIN pg_catalog.pg_namespace tn ON tn.oid=t.typnamespace)"
PID = f"pg_catalog.jsonb_build_array(n.nspname,p.proname,{TYPES})"
PROC = "pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid=p.pronamespace"

QUERIES = {
 'roles': 'SELECT '+obj(name='rolname',superuser='rolsuper',inherit='rolinherit',create_role='rolcreaterole',
    create_db='rolcreatedb',login='rolcanlogin',replication='rolreplication',bypass_rls='rolbypassrls',
    connection_limit='rolconnlimit',valid_until="rolvaliduntil::text",
    config_present='rolconfig IS NOT NULL',config_count='COALESCE(pg_catalog.cardinality(rolconfig),0)')+' FROM pg_catalog.pg_roles ORDER BY oid',
 'memberships': 'SELECT '+obj(role=who('m.roleid'),member=who('m.member'),grantor=who('m.grantor'),
    admin='m.admin_option',inherit='m.inherit_option',set='m.set_option')+' FROM pg_catalog.pg_auth_members m ORDER BY m.roleid,m.member,m.grantor',
 'database': 'SELECT '+obj(name='datname',owner=who('datdba'),allow_connections='datallowconn',connection_limit='datconnlimit',acl_state=state('datacl'))+" FROM pg_catalog.pg_database WHERE datname=pg_catalog.current_database() ORDER BY oid",
 'schemas': 'SELECT '+obj(name='nspname',owner=who('nspowner'),acl_state=state('nspacl'))+" FROM pg_catalog.pg_namespace WHERE nspname='public' ORDER BY oid",
 'relations': 'SELECT '+obj(schema='n.nspname',name='c.relname',kind='c.relkind',owner=who('c.relowner'),
    row_security='c.relrowsecurity',force_row_security='c.relforcerowsecurity',acl_state=state('c.relacl'))+f' FROM {REL} WHERE {PUBLIC} ORDER BY c.oid',
 'columns': 'SELECT '+obj(relation=RID,name='a.attname',number='a.attnum',acl_state=state('a.attacl'))+
    f' FROM {REL} JOIN pg_catalog.pg_attribute a ON a.attrelid=c.oid WHERE {PUBLIC} AND a.attnum>0 AND NOT a.attisdropped ORDER BY c.oid,a.attnum',
 'routines': 'SELECT '+obj(schema='n.nspname',name='p.proname',kind='p.prokind',input_types=TYPES,
    argument_modes="CASE WHEN p.proargmodes IS NULL THEN pg_catalog.to_jsonb(pg_catalog.array_fill('i'::text,ARRAY[p.pronargs::int])) ELSE (SELECT COALESCE(pg_catalog.jsonb_agg(mode ORDER BY ord),'[]'::jsonb) FROM pg_catalog.unnest(p.proargmodes) WITH ORDINALITY a(mode,ord) WHERE mode IN ('i','b','v')) END",
    owner=who('p.proowner'),security_definer='p.prosecdef',acl_state=state('p.proacl'))+f' FROM {PROC} WHERE {PUBLIC} ORDER BY p.oid',
}

ACL_FIELDS = dict(grantor=who('a.grantor'),grantee=principal('a.grantee'),privilege='a.privilege_type',grantable='a.is_grantable')
# Null column ACL is no direct grant; other objects expand their own built-in
# default, independently of pg_default_acl's rules for future objects.
objects = [
 ("'DATABASE'",'pg_catalog.jsonb_build_array(d.datname)',"pg_catalog.pg_database d",'d.datacl',"'d'",'d.datdba',"d.datname=pg_catalog.current_database()"),
 ("'SCHEMA'",'pg_catalog.jsonb_build_array(n.nspname)',"pg_catalog.pg_namespace n",'n.nspacl',"'n'",'n.nspowner',PUBLIC),
 ("CASE WHEN c.relkind='S' THEN 'SEQUENCE' ELSE 'RELATION' END",RID,REL,'c.relacl',"CASE WHEN c.relkind='S' THEN 's' ELSE 'r' END",'c.relowner',PUBLIC+" AND c.relkind IN ('r','p','v','m','f','S')"),
 ("'COLUMN'","pg_catalog.jsonb_build_array(n.nspname,c.relname,col.attname)",REL+' JOIN pg_catalog.pg_attribute col ON col.attrelid=c.oid','col.attacl',None,None,PUBLIC+' AND col.attnum>0 AND NOT col.attisdropped'),
 ("'ROUTINE'",PID,PROC,'p.proacl',"'f'",'p.proowner',PUBLIC),
]
parts=[]
for kind,identity,source,acl,code,owner,predicate in objects:
    expanded=acl if code is None else f'COALESCE({acl},pg_catalog.acldefault(({code})::"char",{owner}))'
    parts.append('SELECT '+obj(kind=kind,object=identity,**ACL_FIELDS)+f' AS row FROM {source} CROSS JOIN LATERAL pg_catalog.aclexplode({expanded}) a WHERE {predicate}')
QUERIES['acls']='SELECT row FROM ('+' UNION ALL '.join(parts)+') all_acls ORDER BY row::text'
QUERIES['default_acls']='SELECT '+obj(owner=who('d.defaclrole'),scope="CASE WHEN d.defaclnamespace=0 THEN 'GLOBAL' ELSE 'PUBLIC' END",
    kind="CASE d.defaclobjtype WHEN 'r' THEN 'RELATION' WHEN 'S' THEN 'SEQUENCE' WHEN 'f' THEN 'ROUTINE' WHEN 'T' THEN 'TYPE' WHEN 'n' THEN 'SCHEMA' END",
    acl_state=state('d.defaclacl'),entries='(SELECT COALESCE(pg_catalog.jsonb_agg('+obj(**ACL_FIELDS)+" ORDER BY a.grantor,a.grantee,a.privilege_type),'[]'::jsonb) FROM pg_catalog.aclexplode(d.defaclacl) a)")+" FROM pg_catalog.pg_default_acl d LEFT JOIN pg_catalog.pg_namespace n ON n.oid=d.defaclnamespace WHERE d.defaclnamespace=0 OR n.nspname='public' ORDER BY d.oid"

def expr(col):
    return f"CASE WHEN {col} IS NULL THEN 'ABSENT' WHEN pg_catalog.pg_get_expr({col},pol.polrelid)='true' THEN 'TRUE' WHEN pg_catalog.pg_get_expr({col},pol.polrelid)='false' THEN 'FALSE' ELSE 'UNSUPPORTED_EXPRESSION' END"

QUERIES['policies']='SELECT '+obj(relation=RID,name='pol.polname',command='pol.polcmd',permissive='pol.polpermissive',
    roles='(SELECT pg_catalog.jsonb_agg('+principal('a.role')+' ORDER BY a.role) FROM pg_catalog.unnest(pol.polroles) a(role))',
    using=expr('pol.polqual'),with_check=expr('pol.polwithcheck'))+f' FROM {REL} JOIN pg_catalog.pg_policy pol ON pol.polrelid=c.oid WHERE {PUBLIC} ORDER BY pol.oid'
SCOPE="CASE WHEN s.dbid=0 THEN 'SHARED' WHEN s.dbid=(SELECT oid FROM pg_catalog.pg_database WHERE datname=pg_catalog.current_database()) THEN 'CURRENT' ELSE 'OTHER' END"
QUERIES['role_settings']='SELECT '+obj(role=who('s.roleid'),scope='s.scope',rows='pg_catalog.count(*)',config_count='pg_catalog.sum(s.n)')+" FROM (SELECT setrole AS roleid,"+SCOPE.replace('s.dbid','s.setdatabase')+" AS scope, COALESCE(pg_catalog.cardinality(setconfig),0) AS n FROM pg_catalog.pg_db_role_setting s) s GROUP BY s.roleid,s.scope ORDER BY s.roleid,s.scope"
MIGRATIONS="'polis_queue_owner','polis_queue_executor','polis_coordinator_owner','polis_coordinator_control','polis_coordinator_publication_owner','polis_coordinator_publisher','polis_coordinator_observer'"
QUERIES['role_dependencies']='SELECT '+obj(role='r.rolname',scope=SCOPE,dependency_type='s.deptype',count='pg_catalog.count(*)')+f" FROM pg_catalog.pg_shdepend s JOIN pg_catalog.pg_roles r ON s.refobjid=r.oid WHERE s.refclassid='pg_catalog.pg_authid'::pg_catalog.regclass AND r.rolname IN ({MIGRATIONS}) GROUP BY r.rolname,s.deptype,{SCOPE} ORDER BY r.rolname,s.deptype,{SCOPE}"

# One extra row proves the fixed cap was exceeded without unbounded fetching.
QUERIES = {name: sql + f' LIMIT {MAX_FAMILY_ROWS + 1}' for name, sql in QUERIES.items()}
