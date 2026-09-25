"""P-058 closed metadata export. No SQL, driver, settings values or free text."""
from __future__ import annotations
import hashlib
import json
import re

from roles_queries import QUERIES, MAX_FAMILY_ROWS, MAX_ROWS, MAX_BYTES

# Single-object byte ceiling for census, projection and receipt/3 (job/2 only).
LIMIT = MAX_BYTES
# Nested bounds (default-ACL entries, policy principals) are deliberately
# unchanged by the capacity revision and are not part of the top-level tally.
MAX_NESTED_ENTRIES = 1024
FAMILIES = ('roles','memberships','database','schemas','relations','columns','routines',
            'acls','default_acls','policies','role_settings','role_dependencies')
CONTROLS = ('extra-field','duplicate-row','dangling-role','wrong-count','missing-family',
            'wrong-kind','wrong-image','wrong-policy','oversize-name','false-pass')
FLAGS = ('superuser','inherit','create_role','create_db','login','replication','bypass_rls')
PRIVILEGES = {
    'DATABASE': {'CREATE','CONNECT','TEMPORARY'}, 'SCHEMA': {'USAGE','CREATE'},
    'RELATION': {'SELECT','INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER','MAINTAIN'},
    'SEQUENCE': {'USAGE','SELECT','UPDATE'}, 'COLUMN': {'SELECT','INSERT','UPDATE','REFERENCES'},
    'ROUTINE': {'EXECUTE'}, 'TYPE': {'USAGE'},
}
# This identifier versions the complete reviewed catalog policy, not a digest of
# an omitted value. Recipes also bind every executable source byte.
POLICY = {'schema':'polis-roles-census-policy/2','postgres_major':17,'schema_scope':'public',
          'families':list(FAMILIES),'expressions':['ABSENT','TRUE','FALSE'],
          'max_identifier_bytes':63,'max_family_rows':MAX_FAMILY_ROWS,'max_rows':MAX_ROWS,'max_bytes':LIMIT}
POLICY_SHA = hashlib.sha256(json.dumps({'policy':POLICY,'queries':QUERIES},sort_keys=True,separators=(',',':')).encode()).hexdigest()
MIGRATION_ROLES = ('polis_queue_owner','polis_queue_executor','polis_coordinator_owner',
    'polis_coordinator_control','polis_coordinator_publication_owner','polis_coordinator_publisher',
    'polis_coordinator_observer')


def encoded(v):
    return json.dumps(v,sort_keys=True,separators=(',',':'),ensure_ascii=False,allow_nan=False).encode()


def fail(code='CENSUS_SCHEMA'):
    raise ValueError(code)


def closed(v, keys):
    if type(v) is not dict or set(v) != set(keys): fail()
    return v


def name(v):
    if type(v) is not str or not 1 <= len(v.encode('utf-8')) <= 63 or '\0' in v: fail('CENSUS_IDENTIFIER')
    return v


def integer(v, low=0, high=2**31-1):
    if type(v) is not int or not low <= v <= high: fail('CENSUS_COUNT')
    return v


def flag(v):
    if type(v) is not bool: fail()


def enum(v, choices):
    if type(v) is not str or v not in choices: fail()


def principal(v, roles):
    closed(v, ('kind','name'))
    if v == {'kind':'PUBLIC','name':None}: return
    if v['kind'] != 'ROLE' or v['name'] not in roles: fail('CENSUS_REFERENCE')


def acl_state(v): enum(v, ('DEFAULT','EMPTY','EXPLICIT'))


def identity(row, family):
    keys = {'roles':['name'],'memberships':['role','member','grantor'],'database':['name'],
        'schemas':['name'],'relations':['schema','name'],'columns':['relation','name'],
        'routines':['schema','name','input_types'],'acls':['kind','object','grantor','grantee','privilege'],
        'default_acls':['owner','scope','kind'],'policies':['relation','name'],
        'role_settings':['role','scope'],'role_dependencies':['role','scope','dependency_type']}[family]
    return encoded([row[k] for k in keys])


def normalize(census):
    closed(census,FAMILIES)
    return {f:sorted(census[f],key=lambda r:identity(r,f)) for f in FAMILIES}


def validate_census(c, complete=True):
    closed(c,FAMILIES)
    if any(type(c[f]) is not list or len(c[f])>MAX_FAMILY_ROWS for f in FAMILIES) or sum(map(len,c.values()))>MAX_ROWS: fail('CENSUS_LIMIT')
    roles=set()
    for r in c['roles']:
        closed(r, ('name',*FLAGS,'connection_limit','valid_until','config_present','config_count'))
        name(r['name']); roles.add(r['name'])
        for k in (*FLAGS,'config_present'): flag(r[k])
        integer(r['connection_limit'],-1); integer(r['config_count'])
        if not r['config_present'] and r['config_count']: fail()
        v=r['valid_until']
        if v is not None and (type(v) is not str or not re.fullmatch(r'(?:-?infinity|\d{4,6}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(?:\.\d{1,6})?\+00(?: BC)?)',v)): fail()
    def role(v):
        if type(v) is not str or v not in roles: fail('CENSUS_REFERENCE')
    def public(v):
        if v != 'public': fail('CENSUS_SCOPE')
    for r in c['memberships']:
        closed(r,('role','member','grantor','admin','inherit','set'))
        for k in ('role','member','grantor'): role(r[k])
        for k in ('admin','inherit','set'): flag(r[k])
    for r in c['database']:
        closed(r,('name','owner','allow_connections','connection_limit','acl_state'))
        name(r['name']);role(r['owner']);flag(r['allow_connections']);integer(r['connection_limit'],-1);acl_state(r['acl_state'])
    if len(c['database'])>1 or complete and len(c['database'])!=1: fail('CENSUS_INCOMPLETE')
    for r in c['schemas']:
        closed(r,('name','owner','acl_state'));public(r['name']);role(r['owner']);acl_state(r['acl_state'])
    if len(c['schemas'])>1 or complete and len(c['schemas'])!=1: fail('CENSUS_INCOMPLETE')
    relations={}
    for r in c['relations']:
        closed(r,('schema','name','kind','owner','row_security','force_row_security','acl_state'))
        public(r['schema']);name(r['name']);role(r['owner']);enum(r['kind'],('r','p','v','m','f','S','i','I','c','t'))
        flag(r['row_security']);flag(r['force_row_security']);acl_state(r['acl_state'])
        relations[encoded([r['schema'],r['name']])]=r
    def relation(v):
        if type(v) is not list or len(v)!=2 or encoded(v) not in relations: fail('CENSUS_REFERENCE')
        return relations[encoded(v)]
    columns=set();column_numbers=set()
    for r in c['columns']:
        closed(r,('relation','name','number','acl_state'));relation(r['relation']);name(r['name']);integer(r['number'],1,32767);acl_state(r['acl_state'])
        number_key=encoded([r['relation'],r['number']])
        if number_key in column_numbers:fail('CENSUS_DUPLICATE')
        column_numbers.add(number_key)
        columns.add(encoded([*r['relation'],r['name']]))
    routines=set()
    for r in c['routines']:
        closed(r,('schema','name','kind','input_types','argument_modes','owner','security_definer','acl_state'))
        public(r['schema']);name(r['name']);enum(r['kind'],('f','p','a','w'));role(r['owner']);flag(r['security_definer']);acl_state(r['acl_state'])
        if type(r['input_types']) is not list or len(r['input_types'])>100 or type(r['argument_modes']) is not list or len(r['argument_modes'])!=len(r['input_types']): fail()
        for t in r['input_types']:
            if type(t) is not list or len(t)!=2: fail()
            for n in t:name(n)
        for m in r['argument_modes']:enum(m,('i','b','v'))
        routines.add(encoded([r['schema'],r['name'],r['input_types']]))
    def grant(r, kind):
        closed(r,('grantor','grantee','privilege','grantable'));role(r['grantor']);principal(r['grantee'],roles)
        enum(r['privilege'],PRIVILEGES[kind]);flag(r['grantable'])
    for r in c['acls']:
        closed(r,('kind','object','grantor','grantee','privilege','grantable'));enum(r['kind'],set(PRIVILEGES)-{'TYPE'})
        o=r['object'];kind=r['kind']
        if kind=='DATABASE': ok=type(o) is list and len(o)==1 and c['database'] and o[0]==c['database'][0]['name']
        elif kind=='SCHEMA': ok=o==['public'] and bool(c['schemas'])
        elif kind in ('RELATION','SEQUENCE'):
            rel=relation(o);ok=(rel['kind']=='S')==(kind=='SEQUENCE')
        elif kind=='COLUMN':ok=encoded(o) in columns
        else:ok=encoded(o) in routines
        if not ok: fail('CENSUS_REFERENCE')
        grant({k:r[k] for k in ('grantor','grantee','privilege','grantable')},kind)
    for r in c['default_acls']:
        closed(r,('owner','scope','kind','acl_state','entries'));role(r['owner']);enum(r['scope'],('GLOBAL','PUBLIC'))
        enum(r['kind'],('RELATION','SEQUENCE','ROUTINE','TYPE','SCHEMA'));acl_state(r['acl_state'])
        if type(r['entries']) is not list or len(r['entries'])>MAX_NESTED_ENTRIES:fail('CENSUS_LIMIT')
        for e in r['entries']:grant(e,r['kind'])
        if r['entries']!=sorted(r['entries'],key=encoded) or len({encoded(e) for e in r['entries']})!=len(r['entries']):fail('CENSUS_ORDER')
    for r in c['policies']:
        closed(r,('relation','name','command','permissive','roles','using','with_check'))
        relation(r['relation']);name(r['name']);enum(r['command'],('*','r','a','w','d'));flag(r['permissive'])
        if type(r['roles']) is not list or not 1<=len(r['roles'])<=MAX_NESTED_ENTRIES:fail()
        for p in r['roles']:principal(p,roles)
        if r['roles']!=sorted(r['roles'],key=encoded) or len({encoded(p) for p in r['roles']})!=len(r['roles']):fail('CENSUS_ORDER')
        for k in ('using','with_check'):enum(r[k],('ABSENT','TRUE','FALSE','UNSUPPORTED_EXPRESSION'))
        if complete and 'UNSUPPORTED_EXPRESSION' in (r['using'],r['with_check']):fail('CENSUS_INCOMPLETE')
    for r in c['role_settings']:
        closed(r,('role','scope','rows','config_count'))
        if r['role'] is not None:role(r['role'])
        enum(r['scope'],('CURRENT','OTHER','SHARED'));integer(r['rows'],1);integer(r['config_count'])
    for r in c['role_dependencies']:
        closed(r,('role','scope','dependency_type','count'));role(r['role'])
        if r['role'] not in MIGRATION_ROLES:fail('CENSUS_SCOPE')
        enum(r['scope'],('CURRENT','OTHER','SHARED'));enum(r['dependency_type'],('o','a','i','r','t'));integer(r['count'],1)
    for f in FAMILIES:
        keys=[identity(r,f) for r in c[f]]
        if keys!=sorted(keys) or len(set(keys))!=len(keys):fail('CENSUS_ORDER')
    if complete and not roles:fail('CENSUS_INCOMPLETE')
    return c


def validate_receipt(r, job):
    from receipt import sha
    closed(r,('schema','kind','run_id','job_sha256','verdict','bindings','coverage','census','controls'))
    if r['schema']!='polis-probe-receipt/3' or r['kind']!='roles-census' or r['run_id']!=job['run_id'] or r['job_sha256']!=sha(job):fail('CENSUS_BINDING')
    enum(r['verdict'],('PASS','FAIL','INCOMPLETE'))
    b=closed(r['bindings'],('source_commit','reader','producer','verifier','query_policy','census','server_version_num'))
    if type(b['source_commit']) is not str or not re.fullmatch('[a-f0-9]{40}',b['source_commit']):fail('CENSUS_BINDING')
    for k in ('reader','producer','verifier'):
        if b[k]!=job[k]['image'].split('@sha256:')[1]:fail('CENSUS_IMAGE')
    if b['query_policy']!=POLICY_SHA or b['census']!=hashlib.sha256(encoded(r['census'])).hexdigest():fail('CENSUS_DIGEST')
    integer(b['server_version_num'])
    c=closed(r['coverage'],(*FAMILIES,'scope','password_state','provenance','data_state','reversal','unsupported_policies','settings_rows','external_dependencies'))
    if c['scope']!={'schema':'public','database':'CURRENT'} or any(c[k]!='NOT_COLLECTED' for k in ('password_state','provenance','data_state')) or c['reversal']!='NOT_EVALUATED':fail('CENSUS_SCOPE')
    for f in FAMILIES:enum(c[f],('COMPLETE','NOT_VISIBLE','UNSUPPORTED_VERSION','LIMIT_EXCEEDED','UNSUPPORTED_EXPRESSION'))
    for k in ('unsupported_policies','settings_rows','external_dependencies'):integer(c[k])
    controls=closed(r['controls'],CONTROLS)
    for v in controls.values():flag(v)
    validate_census(r['census'],r['verdict']=='PASS')
    expected=(sum(p[k]=='UNSUPPORTED_EXPRESSION' for p in r['census']['policies'] for k in ('using','with_check')),
        sum(s['rows'] for s in r['census']['role_settings']),sum(s['count'] for s in r['census']['role_dependencies'] if s['scope']!='CURRENT'))
    if tuple(c[k] for k in ('unsupported_policies','settings_rows','external_dependencies'))!=expected:fail('CENSUS_COUNT')
    if r['verdict']=='PASS' and (b['server_version_num']//10000!=17 or any(c[f]!='COMPLETE' for f in FAMILIES) or not all(controls.values())):fail('CENSUS_FALSE_PASS')
    if len(encoded(r))>LIMIT:fail('CENSUS_LIMIT')
    return r
