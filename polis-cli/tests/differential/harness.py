"""Shared machinery of the CLI differential loops.

One disposable, sealed stack; the real nginx renderer per phase; the real CLI
binary with one POLIS_CONFIG_DIR per actor; the JSON comparison and the
routing counts. Used by the fixed-scenario loop (run.py here) and by the
generated-sequence loop (polis-cli/tests/fuzz/run.py). Standard library only.
Errors name the operation, never its arguments or response values.
"""
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import time
import urllib.error
import urllib.request
import uuid
from urllib.parse import quote, urlsplit

from numeric_wire import compare_recording

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[2]
sys.path.insert(0, str(ROOT / 'server/characterization'))
from isolation import isolated_environment  # noqa: E402

IMAGES = ['CLI_DIFF_POSTGRES_IMAGE', 'CLI_DIFF_OIDC_IMAGE', 'CLI_DIFF_NODE_IMAGE', 'CLI_DIFF_RUST_IMAGE']
NGINX_LOG = '/var/log/nginx/differential.log'


def differences(left,right,path='$'):
    """Object order is immaterial; type, array order and every value matter."""
    if type(left) is not type(right):return [path]
    if isinstance(left,dict):
        return [path+'.'+k for k in sorted(left.keys()^right.keys())]+[
            p for k in sorted(left.keys()&right.keys()) for p in differences(left[k],right[k],path+'.'+k)]
    if isinstance(left,list):
        if len(left)!=len(right):return [path+'.length']
        return [p for i,(a,b) in enumerate(zip(left,right)) for p in differences(a,b,f'{path}[{i}]')]
    return [] if left==right else [path]


def route_lines(log, contract):
    path = contract['path']
    def matches(line):
        fields = line.split()
        if len(fields) < 4:
            return False
        return bool(re.search(path, fields[1])) if path.startswith('^') else fields[1] == path
    return [line for line in log.splitlines() if matches(line)]


def routing_counts(lines):
    served = fallback = 0
    for line in lines:
        fields = line.split()
        if len(fields) < 4:
            continue
        # A named-location handoff separates upstream groups with a colon;
        # within-group retries use commas. Neither is a Rust success.
        sole_rust = len(fields) == 4 and fields[2].endswith(':5100')
        served += sole_rust and fields[3] == '200'
        fallback += ':5100' in line and not sole_rust
    return {'requests': len(lines), 'rust_200': served, 'rust_fallbacks': fallback}


RUST_ONLY = {
    'report-importance': {
        'route': 'statementImportance',
        'reason': 'Optional public importance display: Node-off is unknown; enabled Rust returns the zero-vote fixture counts.',
        'node_exit': 0,
        'tests': ['polis-cli/crates/polis/tests/importance.rs', 'queue-rs/polis-api/conformance/statement-importance-replay.py'],
    },
    'owner-list': {
        'route': 'owner-conversations',
        'reason': 'Cursor-based owner listing is a new Rust contract with no Node counterpart.',
        'node_exit': 8,
        'node_code': 'capability_unavailable',
        'node_message': 'This site does not serve the owner-list feature.',
        'tests': ['polis-cli/crates/polis/tests/owner_conversations.rs',
                  'queue-rs/polis-api/src/owner.rs'],
    },
}


def rust_only_checks(row, node, rust):
    contract = RUST_ONLY[row['contract']]
    if row['contract'] == 'report-importance':
        return importance_display_checks(node, rust)
    error = node['json'].get('error') or {}
    checks = {
        'node_exit': node['exit'] == contract['node_exit'],
        'node_refusal': node['json'].get('ok') is False and node['json'].get('data') is None,
        'node_code': error.get('code') == contract['node_code'],
        'node_message': error.get('message') == contract['node_message'],
        'rust_exit': rust['exit'] == 0,
        'rust_success': rust['json'].get('ok') is True and rust['json'].get('error') is None,
        'artifacts_unchanged': node['artifacts'] == rust['artifacts'],
    }
    # The binary enforces the owner response type, bounds and cursor shape.
    # Its unit/integration contract suites are the semantic oracle, not Node.
    return checks


def serving_matches(counts, contract):
    return (counts['rust_200'] >= contract['minimum_rust_successes']
            and counts['rust_fallbacks'] == contract.get('expected_node_handoffs', 0)
            and counts['requests'] == contract['expected_requests'])


def route_contracts(routes):
    """Check each selector's total and each explicitly inventoried path."""
    for route, contract in routes.items():
        yield route, contract
        for path in contract.get('paths', []):
            yield route + ':' + path['path'], path


def load_routes():
    """The switch set under test; refuses a template census that differs."""
    routes=json.loads((HERE/'routes.json').read_text())
    available={f.name.removesuffix('.location.conf.template') for f in (ROOT/'file-server/nginx/rust-api').glob('*.location.conf.template') if not f.name.startswith('node.')}
    if available!=set(routes):raise RuntimeError('routing census changed; add route scenarios and serving assertions')
    return routes


class Stack:
    """One disposable compose project. Refuses a project that already exists;
    down() removes only this project's containers and volumes."""

    def __init__(self, environ=os.environ):
        self.env=isolated_environment(environ)
        for name in IMAGES:
            if not self.env.get(name):raise RuntimeError(name+' must name a prebuilt local image')
        self.project=self.env['COMPOSE_PROJECT_NAME']
        self.compose=['docker','compose','-p',self.project,'-f',str(ROOT/'server/characterization/compose.yml'),'-f',str(HERE/'compose.yml')]
        if self.shell(['docker','ps','-aq','--filter','label=com.docker.compose.project='+self.project]).stdout.strip():
            raise RuntimeError('project already exists; refusing to touch it')
        self.origin='http://127.0.0.1:'+self.env['P027_HTTP_PORT']
        self.control='http://127.0.0.1:'+self.env['P027_CONTROL_PORT']
        self.tokens=None

    def shell(self,argv,*,input=None,check=True,timeout=120):
        compose=self.compose
        r=subprocess.run(argv,input=input,capture_output=True,text=True,env=self.env,timeout=timeout)
        if check and r.returncode:raise RuntimeError('local harness operation failed: '+argv[0]+' '+(' '.join(argv[len(compose):3+len(compose)]) if argv[:len(compose)]==compose else '')+'; details withheld')
        return r

    def dc(self,*argv,**kw):return self.shell(self.compose+list(argv),**kw)

    def get(self,path):
        with urllib.request.urlopen(self.control+path,timeout=5) as r:return json.load(r)

    def ready(self):
        end=time.monotonic()+60
        while time.monotonic()<end:
            try:
                if self.get('/ready')['ready']:return
            except (OSError,ValueError):pass
            time.sleep(.5)
        raise RuntimeError('readiness deadline')

    def publish_keys(self):
        self.dc('exec','-T','server','node','-e', "(async()=>{const fs=require('fs');let response;for(let i=0;i<60;i++){try{response=await fetch('http://localhost:5001/public-key');if(response.ok)break;}catch{}await new Promise(r=>setTimeout(r,500));}if(!response?.ok)throw Error('key readiness');fs.writeFileSync('/artifacts/participant-public.pem',(await response.json()).publicKey);const jwks=await fetch('https://oidc-simulator:3000/.well-known/jwks.json');if(!jwks.ok)throw Error('jwks readiness');fs.writeFileSync('/artifacts/read-jwks.json',JSON.stringify(await jwks.json()));})().catch(()=>process.exit(1))")

    def up(self):
        """Start every service; return the control port's generated tokens."""
        self.dc('up','-d','--pull','never','postgres','dynamodb','oidc-simulator','server','file-server')
        self.publish_keys()
        self.dc('up','-d','--pull','never','polis-api','proxy','gateway')
        self.ready();self.tokens=self.get('/tokens')
        return self.tokens

    def enter_phase(self,switch,*,fresh_backends):
        """Reload the proxy with the real route helper and reinstall the fixture.
        Fresh backend processes clear process caches between phases."""
        self.env['RUST_API_ROUTES']=switch
        if fresh_backends:
            self.dc('restart','-t','1','server','dynamodb');self.ready();self.publish_keys();self.dc('restart','-t','1','polis-api')
        self.dc('exec','-T','-e','RUST_API_ROUTES='+switch,
                'proxy','/usr/local/bin/polis-rust-routes','--reload')
        # The proxy survives phase changes. After old workers drain, clear
        # only the access log so routing counts still describe one phase.
        self.dc('exec','-T','proxy','sh','-c',': > '+NGINX_LOG)
        fixture=self.dc('exec','-T','server','node','/differential/seed.cjs',input=json.dumps(self.tokens),check=False)
        if fixture.returncode:
            print(fixture.stderr,file=sys.stderr)
            raise RuntimeError('generated fixture install failed')

    def begin(self,seed,case,*,clock=None):
        """Reseed one case, optionally advancing the test-only fixture clock."""
        suffix = '' if clock is None else '&clock=' + str(clock)
        self.get('/begin?seed='+seed+'&case='+case+suffix)

    def barrier(self,label):
        # Await tracked asynchronous side effects before the next
        # command or reset; no blind fixed delay hides late writes.
        deadline=time.monotonic()+5
        while True:
            try:
                self.get('/barrier');break
            except urllib.error.HTTPError:
                if time.monotonic()>=deadline:raise RuntimeError('request effects did not drain: '+label) from None
                time.sleep(.02)

    def nginx_log(self):
        return self.dc('exec','-T','proxy','cat',NGINX_LOG).stdout

    def down(self):
        # All containers/volumes belong to this unique claimed project.
        return self.dc('down','-v','--remove-orphans','--timeout','1',check=False).returncode==0


class Cli:
    """The real binary in one workspace, one POLIS_CONFIG_DIR per actor.
    Owner and admin use the control port's tokens; participants hold only
    what the CLI itself saved."""

    def __init__(self,binary,stack,workspace):
        self.binary=binary;self.stack=stack;self.workspace=Path(workspace)
        self.numeric_checks=[]
        self.child={k:v for k,v in os.environ.items() if not k.startswith('POLIS_')}
        self.child['POLIS_KEYCHAIN_SERVICE']='org.pol.is.cli.differential.'+stack.project

    def config(self,actor):
        d=self.workspace/actor;d.mkdir(exist_ok=True)
        if not (d/'profiles.json').exists():
            (d/'profiles.json').write_text(json.dumps({'default':'local','sites':{'local':self.stack.origin}}))
        return d

    def invoke(self,row,fixture_uuid=None):
        tokens=self.stack.tokens
        e=dict(self.child,POLIS_CONFIG_DIR=str(self.config(row.get('actor','owner'))))
        if row.get('actor','owner') in ['owner','admin']:e['POLIS_TOKEN_LOCAL']=tokens[row.get('actor','owner')]
        # Used only by the explicit fixture-ids CLI build. A normal
        # binary ignores this and will fail the seed receipt comparison.
        e['POLIS_CLI_FIXTURE_UUID']=fixture_uuid or str(uuid.uuid5(uuid.NAMESPACE_URL,'generated-cli/'+row.get('scenario',row['command'])))
        # These commands return the API payload directly under data. Other
        # commands reshape it and retain the existing semantic comparisons.
        numeric_path = None
        if row['command'] == 'math view':
            numeric_path = '/api/v3/math/pca2'
        elif row['command'] == 'api' and len(row['args']) > 1:
            numeric_path = urlsplit(row['args'][1]).path
        if numeric_path:
            self.stack.get('/numeric-recording/reset?path=' + quote(numeric_path, safe=''))
        r=subprocess.run([self.binary,*row['args'],'--json','--no-interactive'],cwd=self.workspace,env=e,
            input=tokens['owner']+'\n' if row.get('stdin')=='owner' else None,capture_output=True,text=True,timeout=90)
        try:data=json.loads(r.stdout)
        except ValueError:raise RuntimeError('non-JSON command response: '+row['command']) from None
        if numeric_path and r.returncode == 0:
            check = compare_recording(self.stack.get('/numeric-recording')['records'], r.stdout.encode())
            check['scenario'] = row.get('scenario', row['command'])
            self.numeric_checks.append(check)
            if not check['passed']:
                raise RuntimeError('CLI numeric wire drift: ' + row['command'] + ' at ' + ', '.join(check['different_paths']))
        return {'exit':r.returncode,'json':data}

    def reset(self):
        self.numeric_checks=[]
        for item in self.workspace.iterdir():
            if item.is_dir():shutil.rmtree(item)
            else:item.unlink()


def run_phases(stack,cli,plan):
    """The phase loop: for each (name, RUST_API_ROUTES) the proxy is
    re-rendered, backends after the first phase are restarted, the fixture is
    reinstalled and the CLI workspace emptied; then the phase name is yielded.
    Same URL, profile, paths, inputs and credentials in every phase. We reset
    generated database state and CLI files, never rewrite captured responses."""
    for index,(name,switch) in enumerate(plan):
        stack.enter_phase(switch,fresh_backends=index>0)
        # Gateway has no DNS cache / reused upstream sockets.
        cli.reset()
        yield name


def importance_display_checks(node, rust):
    """Named fixture contract, not a general normalization of current counts.
    This command precedes every vote in cases.py; the two participant-visible comments
    therefore have zero vote rows. Preserve every other byte-derived value.
    """
    import copy
    a, b = copy.deepcopy(node), copy.deepcopy(rust)
    checks = {'successes': all(v.get('exit') == 0 and v.get('json', {}).get('ok') is True
                              and v['json'].get('error') is None for v in [a, b])}
    try:
        left, right = a['json']['data'], b['json']['data']
        # This sealed fixture has no static-file upstream. Node's unmatched-route
        # proxy reports operation_failed; this is not a claim that all missing
        # routes return that code. Reject every other error in this fixture.
        checks['node_unknown'] = left.pop('importance') == {'state':'unavailable','error':'operation_failed','read_at_ms':None}
        meta = right.pop('importance')
        timestamp = meta.pop('read_at_ms')
        checks['timestamp'] = type(timestamp) is int and 0 < timestamp <= 9007199254740991
        checks['metadata'] = meta == {'schema':'statement-importance/1','conversation_id':'2p027generated','state':'observed',
            'scope':'current active, unmuted, participant-visible comments; latest vote per participant; not verified people or historical job inputs'}
        checks['fixture_ids'] = [r['tid'] for r in right['comments']] == [0, 1]
        checks['unknown_rows'] = all(r.pop('important') is None and r.pop('voters') is None for r in left['comments'])
        checks['zero_rows'] = all(type(r['important']) is int and type(r['voters']) is int
                                 and r.pop('important') == 0 and r.pop('voters') == 0 for r in right['comments'])
        checks['unchanged_fields'] = not differences(a, b)
    except (KeyError, TypeError, AttributeError):
        checks['shape'] = False
    return checks
