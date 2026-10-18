#!/usr/bin/env python3
"""All CLI commands, identical JSON and exits, real Node/Rust routing.

Requires prebuilt images and binary. Owns one disposable stack; never reads a
byte-replay archive. Every JSON field, list order and type is compared. Reports
contain command names and differing paths, never token/text response values.
"""
import argparse
from concurrent.futures import ThreadPoolExecutor
import hashlib
import json
import os
import re
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import time
import urllib.request

HERE=Path(__file__).resolve().parent
ROOT=HERE.parents[2]
sys.path.insert(0,str(ROOT/'server/characterization'))
from isolation import isolated_environment
from cases import cases


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


def census(schema):
    nodes={}
    def visit(node):
        name=node['command'].removeprefix('polis ')
        if name!='polis' and (node['implemented'] or not node['commands']):nodes[name]=node['implemented']
        for child in node['commands']:visit(child)
    visit(schema)
    return nodes


def check_census(nodes,rows):
    names=[x['command'] for x in rows]
    if len(names)!=len(set(names)):raise RuntimeError('duplicate scenario command')
    missing={k for k,v in nodes.items() if v}-set(names)
    extra=set(names)-set(nodes)
    if missing or extra:raise RuntimeError(f'command census mismatch: missing={sorted(missing)}, extra={sorted(extra)}')


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


def main():
    p=argparse.ArgumentParser(description=__doc__)
    p.add_argument('--binary',required=True)
    p.add_argument('--output',required=True)
    args=p.parse_args()
    binary=str(Path(args.binary).resolve());output=Path(args.output).resolve()
    routes=json.loads((HERE/'routes.json').read_text())
    available={f.name.removesuffix('.location.conf.template') for f in (ROOT/'file-server/nginx/rust-api').glob('*.location.conf.template') if not f.name.startswith('node.')}
    if available!=set(routes):raise RuntimeError('routing census changed; add route scenarios and serving assertions')
    env=isolated_environment(os.environ)
    for name in ['CLI_DIFF_POSTGRES_IMAGE','CLI_DIFF_OIDC_IMAGE','CLI_DIFF_NODE_IMAGE','CLI_DIFF_RUST_IMAGE']:
        if not env.get(name):raise RuntimeError(name+' must name a prebuilt local image')
    compose=['docker','compose','-p',env['COMPOSE_PROJECT_NAME'],'-f',str(ROOT/'server/characterization/compose.yml'),'-f',str(HERE/'compose.yml')]
    def shell(argv,*,input=None,check=True,timeout=120):
        r=subprocess.run(argv,input=input,capture_output=True,text=True,env=env,timeout=timeout)
        if check and r.returncode:raise RuntimeError('local harness operation failed: '+argv[0]+' '+(' '.join(argv[len(compose):3+len(compose)]) if argv[:len(compose)]==compose else '')+'; details withheld')
        return r
    def dc(*argv,**kw):return shell(compose+list(argv),**kw)
    if shell(['docker','ps','-aq','--filter','label=com.docker.compose.project='+env['COMPOSE_PROJECT_NAME']]).stdout.strip():
        raise RuntimeError('project already exists; refusing to touch it')
    origin='http://127.0.0.1:'+env['P027_HTTP_PORT']
    control='http://127.0.0.1:'+env['P027_CONTROL_PORT']
    def get(path):
        with urllib.request.urlopen(control+path,timeout=5) as r:return json.load(r)
    def ready():
        end=time.monotonic()+60
        while time.monotonic()<end:
            try:
                if get('/ready')['ready']:return
            except (OSError,ValueError):pass
            time.sleep(.5)
        raise RuntimeError('readiness deadline')
    report={'schema':'polis-cli-differential/1','rows':[],'rust_only':[],'mismatches':0,'byte_replays_run':False,'switches':sorted(routes),'scope':'pca2 equality plus the new owner-list contract; Rust-only scenarios reported separately','complete':False}
    started=time.monotonic()
    # Same URL, profile, paths, inputs and credentials in both phases. We reset
    # generated database state and CLI files, never rewrite captured responses.
    try:
        dc('up','-d','--pull','never','postgres','dynamodb','oidc-simulator','server')
        def publish_keys():
            dc('exec','-T','server','node','-e', "(async()=>{const fs=require('fs');let response;for(let i=0;i<60;i++){try{response=await fetch('http://localhost:5001/public-key');if(response.ok)break;}catch{}await new Promise(r=>setTimeout(r,500));}if(!response?.ok)throw Error('key readiness');const jwks=await fetch('https://oidc-simulator:3000/.well-known/jwks.json');if(!jwks.ok)throw Error('jwks readiness');fs.writeFileSync('/artifacts/read-jwks.json',JSON.stringify(await jwks.json()));})().catch(()=>process.exit(1))")
        publish_keys()
        dc('up','-d','--pull','never','polis-api','proxy','gateway')
        ready();tokens=get('/tokens')
        with tempfile.TemporaryDirectory(prefix='polis-cli-diff-') as directory:
            workspace=Path(directory)
            child={k:v for k,v in os.environ.items() if not k.startswith('POLIS_')}
            child['POLIS_KEYCHAIN_SERVICE']='org.pol.is.cli.differential.'+env['COMPOSE_PROJECT_NAME']
            def config(actor):
                d=workspace/actor;d.mkdir(exist_ok=True)
                if not (d/'profiles.json').exists():
                    (d/'profiles.json').write_text(json.dumps({'default':'local','sites':{'local':origin}}))
                return d
            def invoke(row):
                e=dict(child,POLIS_CONFIG_DIR=str(config(row.get('actor','owner'))))
                if row.get('actor','owner') in ['owner','admin']:e['POLIS_TOKEN_LOCAL']=tokens[row.get('actor','owner')]
                # Used only by the explicit fixture-ids CLI build. A normal
                # binary ignores this and will fail the seed receipt comparison.
                import uuid
                e['POLIS_CLI_FIXTURE_UUID']=str(uuid.uuid5(uuid.NAMESPACE_URL,'generated-cli/'+row.get('scenario',row['command'])))
                r=subprocess.run([binary,*row['args'],'--json','--no-interactive'],cwd=workspace,env=e,
                    input=tokens['owner']+'\n' if row.get('stdin')=='owner' else None,capture_output=True,text=True,timeout=90)
                try:data=json.loads(r.stdout)
                except ValueError:raise RuntimeError('non-JSON command response: '+row['command']) from None
                return {'exit':r.returncode,'json':data}
            nodes=census(invoke({'command':'schema','args':['schema']})['json']['data'])
            rows=cases();check_census(nodes,rows)
            rows.insert(18,dict(command='math view',scenario='math view subset',args=['math','view','--conversation','2p027generated','--key','math_tick'],expected_exit=0,scope='live',actor='owner'))
            rows.insert(19,dict(command='conversation list',scenario='conversation list owner pagination',args=['conversation','list','--sort','newest','--limit','10'],expected_exit=0,scope='rust-only',contract='owner-list',actor='owner'))
            rows.insert(20,dict(command='conversation list',scenario='conversation list owner minimum',args=['conversation','list','--min-participants','1','--limit','10'],expected_exit=0,scope='rust-only',contract='owner-list',actor='owner'))
            rows += [dict(command=name,args=name.split(),expected_exit=8,scope='planned',actor='owner') for name,implemented in sorted(nodes.items()) if not implemented]
            captured={}
            for phase,switch in [('node',''),('rust',','.join(sorted(routes)))]:
                env['RUST_API_ROUTES']=switch
                # Recreate proxy with the real renderer. Fresh backend caches
                # and generated rows keep phases independent after writes.
                if phase=='rust':
                    dc('restart','-t','1','server','dynamodb');ready();publish_keys();dc('restart','-t','1','polis-api')
                dc('up','-d','--no-deps','--force-recreate','--pull','never','proxy')
                fixture=dc('exec','-T','server','node','/differential/seed.cjs',input=json.dumps(tokens),check=False)
                if fixture.returncode:
                    print(fixture.stderr,file=sys.stderr)
                    raise RuntimeError('generated fixture install failed')
                # Gateway has no DNS cache / reused upstream sockets.
                for item in workspace.iterdir():
                    if item.is_dir():shutil.rmtree(item)
                    else:item.unlink()
                (workspace/'seeds.csv').write_text('comment_text,original_id\nGenerated imported statement,generated-import\n')
                (workspace/'invalid-result.json').write_text('{}')
                (workspace/'allowlist.json').write_text('["generated-external"]')
                (workspace/'agenda.json').write_text('[{"topic_key":"generated-topic","selected":true}]')
                (workspace/'agenda-replace.json').write_text('[{"topic_key":"generated-topic","selected":false}]')
                (workspace/'capability.txt').write_text('00000000-0000-4000-8000-000000000027')
                (workspace/'invalid-capability.txt').write_text('generated-invalid-capability')
                (workspace/'verification.txt').write_text('generated-verification')
                capabilities=json.loads(dc('exec','-T','server','node','/differential/admin-capabilities.cjs').stdout)
                for name,signature in capabilities.items():
                    (workspace/(name+'.txt')).write_text(signature)
                (workspace/'setup.json').write_text(json.dumps({
                    'topic':'Generated typed setup','description':'Generated description','context':'',
                    'activity':'open','listing':'listed','join':{'invitations':{'mode':'optional','waves':[]},'external_identity':{'mode':'optional'}},
                    'moderation':'after_submission','visibility':'hide_social_list','data_access':'owner',
                    'profanity_filter':False,'short_url':False,'seeds':['Generated setup statement']}))
                phase_start=time.monotonic();phase_values=[];timings=[]
                for index,row in enumerate(rows):
                    if row['scope']=='planned':continue
                    if row['command']=='node doctor':
                        report[phase+'_admin_fixture']=json.loads(dc('exec','-T','server','node','/differential/admin-seed.cjs').stdout)
                    get('/begin?seed='+hashlib.sha256(row.get('scenario',row['command']).encode()).hexdigest()[:12]+'&case=cli'+str(index))
                    command_start=time.monotonic()
                    value=invoke(row)
                    timings.append({'command':row.get('scenario',row['command']),'seconds':round(time.monotonic()-command_start,3)})
                    print(phase+' '+row['command']+' exit='+str(value['exit']),file=sys.stderr,flush=True)
                    # Await tracked asynchronous side effects before the next
                    # command or reset; no blind fixed delay hides late writes.
                    deadline=time.monotonic()+5
                    while True:
                        try:
                            get('/barrier');break
                        except urllib.error.HTTPError:
                            if time.monotonic()>=deadline:raise RuntimeError('request effects did not drain: '+row['command']) from None
                            time.sleep(.02)
                    if row['command'] in ['notification subscribe','notification unsubscribe','notification set','agenda add','agenda replace','agenda remove','delphi run','delphi batch','support contribute']:
                        check='final' if row['command']=='support contribute' else row['command']
                        verified=dc('exec','-T','server','node','/differential/admin-verify.cjs',check,check=False)
                        if verified.returncode:
                            print(verified.stderr,file=sys.stderr)
                            raise RuntimeError('durable admin proof failed: '+check)
                        report.setdefault(phase+'_admin_proof',[]).extend(json.loads(verified.stdout)['checks'])
                    expected=RUST_ONLY[row['contract']]['node_exit'] if row['scope']=='rust-only' and phase=='node' else row['expected_exit']
                    if expected is not None and value['exit']!=expected:
                        report.setdefault('unexpected_outcomes',[]).append({'phase':phase,'command':row['command'],'expected_exit':expected,'actual_exit':value['exit'],'code':value['json'].get('error',{}).get('code') if value['json'].get('error') else None})
                    # A missing-store scenario may exercise a server refusal,
                    # never a parser/auth/connectivity error as a success proxy.
                    if expected is None and value['exit'] in [2,3,7,8]:
                        report.setdefault('unexpected_outcomes',[]).append({'phase':phase,'command':row['command'],'actual_exit':value['exit'],'reason':'not a stored-data outcome'})
                    artifacts={}
                    for f in workspace.rglob('*'):
                        if f.is_file() and not any(a in f.relative_to(workspace).parts for a in ['owner','participant','admin']):
                            artifacts[str(f.relative_to(workspace))]=hashlib.sha256(f.read_bytes()).hexdigest()
                    value['artifacts']=artifacts;phase_values.append(value)
                    if row['command']=='vote':participant_id=value['json']['data']['participant_id']
                    if row['command']=='comment':
                        proof=json.loads(dc('exec','-T','server','node','/differential/verify-participant.cjs').stdout)
                        if proof!={'votes':[{'pid':participant_id,'choice':'agree'}],'comments':[{'pid':participant_id}]}:
                            raise RuntimeError('participant identity or semantic vote proof failed')
                        report[phase+'_participant_proof']={'semantic_choice':'agree','votes':1,'comments':1,'same_participant':True}
                # Planned commands cannot do HTTP or mutate credentials. Run
                # those independent parser/availability checks concurrently;
                # keep real participant/admin flows sequential.
                planned=[row for row in rows if row['scope']=='planned']
                before=dc('exec','-T','proxy','cat','/var/log/nginx/differential.log').stdout
                with ThreadPoolExecutor(max_workers=4) as pool:
                    for row,value in zip(planned,pool.map(invoke,planned)):
                        if value['exit']!=8:raise RuntimeError('planned command no longer returns exit 8: '+row['command'])
                        value['artifacts']=artifacts.copy();phase_values.append(value)
                after=dc('exec','-T','proxy','cat','/var/log/nginx/differential.log').stdout
                if before!=after:raise RuntimeError('planned command unexpectedly made an HTTP request')
                captured[phase]=phase_values
                report[phase+'_seconds']=round(time.monotonic()-phase_start,3)
                report[phase+'_slowest']=sorted(timings,key=lambda r:r['seconds'],reverse=True)[:5]
                log=dc('exec','-T','proxy','cat','/var/log/nginx/differential.log').stdout
                report[phase+'_routing']={}
                serving_failures=[]
                for route,contract in routes.items():
                    matched_lines=route_lines(log,contract)
                    counts=routing_counts(matched_lines)
                    served=counts['rust_200'];fallback=counts['rust_fallbacks']
                    report[phase+'_routing'][route]=counts
                    if phase=='rust' and not serving_matches(counts, contract):serving_failures.append(route)
                    if phase=='node' and served:raise RuntimeError('off switch still served Rust: '+route)
                if serving_failures:report['serving_failures']=serving_failures
            for row,a,b in zip(rows,captured['node'],captured['rust']):
                if row['scope']=='rust-only':
                    checks=rust_only_checks(row,a,b)
                    report['rust_only'].append({'scenario':row['scenario'],'contract':row['contract'],**RUST_ONLY[row['contract']],'node_actual_exit':a['exit'],'rust_actual_exit':b['exit'],'checks':checks,'passed':all(checks.values())})
                    continue
                diff=differences(a,b)
                report['rows'].append({'command':row['command'],'scenario':row.get('scenario',row['command']),'scope':row['scope'],'node_exit':a['exit'],'rust_exit':b['exit'],'equal':not diff,'different_paths':diff,'node_error':(a['json'].get('error') or {}).get('code'),'node_status':((a['json'].get('error') or {}).get('upstream') or {}).get('status'),'rust_status':((b['json'].get('error') or {}).get('upstream') or {}).get('status'),'rust_error':(b['json'].get('error') or {}).get('code')})
            report['scenarios']=len(rows);report['commands']=len(nodes);report['implemented']=sum(nodes.values())
            report['planned']=sum(not v for v in nodes.values())
            report['rust_only_failures']=sum(not row['passed'] for row in report['rust_only'])
            report['equality_scenarios']=len(report['rows'])
            report['mismatches']=sum(not row['equal'] for row in report['rows'])
            report['complete']=True
    except subprocess.TimeoutExpired:
        report['harness_error']='local operation exceeded its deadline; arguments withheld'
    except Exception as error:
        report['harness_error']=str(error)
    finally:
        # All containers/volumes belong to this unique claimed project.
        cleanup=dc('down','-v','--remove-orphans','--timeout','1',check=False)
        report['cleanup_passed']=cleanup.returncode==0
        report['elapsed_seconds']=round(time.monotonic()-started,3)
        output.parent.mkdir(parents=True,exist_ok=True)
        output.write_text(json.dumps(report,indent=2)+'\n')
    print(json.dumps({k:v for k,v in report.items() if k not in ['rows','rust_only']},indent=2))
    return 0 if report['complete'] and not report['mismatches'] and not report.get('rust_only_failures') and not report.get('unexpected_outcomes') and report['cleanup_passed'] and not report.get('serving_failures') else 1

if __name__=='__main__':sys.exit(main())
