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
from pathlib import Path
import subprocess
import sys
import tempfile
import time

from harness import (HERE, RUST_ONLY, Cli, Stack, differences, load_routes, route_lines,  # noqa: F401
                     route_contracts, routing_counts, run_phases, rust_only_checks, serving_matches)
from cases import cases
from reads import add_read_cases, capture_reads, compare_reads
from pages import capture_pages, compare_pages


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


def main():
    p=argparse.ArgumentParser(description=__doc__)
    p.add_argument('--binary',required=True)
    p.add_argument('--output',required=True)
    args=p.parse_args()
    binary=str(Path(args.binary).resolve());output=Path(args.output).resolve()
    routes=load_routes()
    stack=Stack()
    report={'schema':'polis-cli-differential/1','rows':[],'rust_only':[],'mismatches':0,'byte_replays_run':False,'switches':sorted(routes),'scope':'all inventoried staged switches; Rust-only contracts reported separately; scoped Node handoffs counted','complete':False}
    started=time.monotonic()
    try:
        stack.up()
        with tempfile.TemporaryDirectory(prefix='polis-cli-diff-') as directory:
            workspace=Path(directory)
            cli=Cli(binary,stack,workspace)
            invoke=cli.invoke
            nodes=census(invoke({'command':'schema','args':['schema']})['json']['data'])
            rows=cases();check_census(nodes,rows)
            rows.insert(18,dict(command='math view',scenario='math view subset',args=['math','view','--conversation','2p027generated','--key','math_tick'],expected_exit=0,scope='live',actor='owner'))
            rows.insert(19,dict(command='conversation list',scenario='conversation list owner pagination',args=['conversation','list','--sort','newest','--limit','10'],expected_exit=0,scope='rust-only',contract='owner-list',actor='owner'))
            rows.insert(20,dict(command='conversation list',scenario='conversation list owner minimum',args=['conversation','list','--min-participants','1','--limit','10'],expected_exit=0,scope='rust-only',contract='owner-list',actor='owner'))
            # The same participant marks a second statement important, after the
            # participant proof below has counted the first, unmarked vote.
            rows.insert(next(i for i,r in enumerate(rows) if r['command']=='comment')+1,dict(command='vote',scenario='vote important',args=['vote','2p027generated','--statement','1','--agree','--important'],expected_exit=0,scope='live',actor='participant'))
            # The owner has an empty history. Once the participant has voted,
            # read its one-row and two-row results; the latter stay on Node.
            for anchor, commands, state in [
                ('join', ['vote mine'], 'empty'),
                ('vote', ['vote list', 'vote mine'], 'single'),
                ('vote important', ['vote list'], 'multiple'),
            ]:
                index = next(i for i, row in enumerate(rows) if row.get('scenario', row['command']) == anchor) + 1
                rows[index:index] = [dict(command=command, scenario=command+' '+state,
                    args=command.split()+['--conversation','2p027generated']+(['--account'] if state=='empty' else []),
                    expected_exit=0,scope='live',
                    actor='owner' if command=='vote list' or state=='empty' else 'participant',
                    participant_pid=command=='vote list',
                    vote_rows={'empty':0,'single':1,'multiple':2}[state]) for command in commands]
            add_read_cases(rows)
            # Additional reads keep the existing command census intact.
            index = next(i for i, row in enumerate(rows) if row['command'] == 'vote')
            rows[index:index] = [
                dict(command=command, scenario=scenario, args=args,
                     expected_exit=0, scope='live', actor='owner')
                for command, scenario, args in [
                    ('participant status', 'participant status missing', ['participant','status','--conversation','2generatedjoin']),
                    ('participant highlight list', 'participant highlight list filtered', ['participant','highlight','list','--conversation','2p027generated','--mod','1']),
                    ('api', 'participant group owner', ['api','/api/v3/bid?conversation_id=2p027generated']),
                    ('participant locations', 'participant locations missing group', ['participant','locations','--conversation','2p027generated','--group','99']),
                ]]
            # A second invitation code makes reverse lookup ambiguous. Prove
            # the admitted CSV first, then retain the later Node handoff.
            rows.insert(next(i for i, row in enumerate(rows) if row['command'] == 'invite code create'),
                dict(command='invite mine export', scenario='invite mine export empty',
                     args=['invite','mine','export','--conversation','2p027generated','--output','mine-empty.csv'],
                     expected_exit=0, scope='live', actor='participant'))
            page_values = {}
            rows += [dict(command=name,args=name.split(),expected_exit=8,scope='planned',actor='owner') for name,implemented in sorted(nodes.items()) if not implemented]
            captured={}
            captured_reads={}
            for phase in run_phases(stack,cli,[('node',''),('rust',','.join(sorted(routes)))]):
                report[phase+'_numeric_wire']=cli.numeric_checks
                (workspace/'seeds.csv').write_text('comment_text,original_id\nGenerated imported statement,generated-import\n')
                (workspace/'invalid-result.json').write_text('{}')
                (workspace/'allowlist.json').write_text('["generated-external"]')
                (workspace/'agenda.json').write_text('[{"topic_key":"generated-topic","selected":true}]')
                (workspace/'agenda-replace.json').write_text('[{"topic_key":"generated-topic","selected":false}]')
                (workspace/'capability.txt').write_text('00000000-0000-4000-8000-000000000027')
                (workspace/'invalid-capability.txt').write_text('generated-invalid-capability')
                (workspace/'verification.txt').write_text('generated-verification')
                capabilities=json.loads(stack.dc('exec','-T','server','node','/differential/admin-capabilities.cjs').stdout)
                for name,signature in capabilities.items():
                    (workspace/(name+'.txt')).write_text(signature)
                (workspace/'setup.json').write_text(json.dumps({
                    'topic':'Generated typed setup','description':'Generated description','context':'',
                    'activity':'open','listing':'listed','join':{'invitations':{'mode':'optional','waves':[]},'external_identity':{'mode':'optional'}},
                    'moderation':'after_submission','visibility':'hide_social_list','data_access':'owner',
                    'profanity_filter':False,'short_url':False,'seeds':['Generated setup statement']}))
                page_values[phase] = capture_pages(stack.origin)
                phase_start=time.monotonic();phase_values=[];timings=[]
                for index,row in enumerate(rows):
                    if row['scope']=='planned':continue
                    if row['command']=='node doctor':
                        report[phase+'_admin_fixture']=json.loads(stack.dc('exec','-T','server','node','/differential/admin-seed.cjs').stdout)
                    stack.begin(hashlib.sha256(row.get('scenario',row['command']).encode()).hexdigest()[:12],'cli'+str(index))
                    command_start=time.monotonic()
                    invocation = dict(row, args=row['args']+['--pid',str(participant_id)]) if row.get('participant_pid') else row
                    value=invoke(invocation)
                    if 'vote_rows' in row:
                        data = value['json'].get('data') or {}
                        votes = data.get('votes' if row['command']=='vote list' else 'data')
                        if value['exit'] != 0 or not isinstance(votes, list) or len(votes) != row['vote_rows']:
                            raise RuntimeError('vote read fixture row count failed: '+row['scenario'])
                        if votes and any(vote.get('pid') != participant_id for vote in votes):
                            raise RuntimeError('vote read fixture participant failed: '+row['scenario'])
                    timings.append({'command':row.get('scenario',row['command']),'seconds':round(time.monotonic()-command_start,3)})
                    print(phase+' '+row['command']+' exit='+str(value['exit']),file=sys.stderr,flush=True)
                    stack.barrier(row['command'])
                    if row['command'] in ['notification subscribe','notification unsubscribe','notification set','agenda add','agenda replace','agenda remove','delphi run','delphi batch']:
                        check=row['command']
                        verified=stack.dc('exec','-T','server','node','/differential/admin-verify.cjs',check,check=False)
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
                        proof=json.loads(stack.dc('exec','-T','server','node','/differential/verify-participant.cjs').stdout)
                        if proof!={'votes':[{'pid':participant_id,'choice':'agree'}],'comments':[{'pid':participant_id}]}:
                            raise RuntimeError('participant identity or semantic vote proof failed')
                        report[phase+'_participant_proof']={'semantic_choice':'agree','votes':1,'comments':1,'same_participant':True}
                    if row.get('scenario')=='vote important':
                        proof=json.loads(stack.dc('exec','-T','server','node','/differential/verify-participant.cjs','important').stdout)
                        if proof!={'votes':[{'pid':participant_id,'tid':0,'choice':'agree','high_priority':False},{'pid':participant_id,'tid':1,'choice':'agree','high_priority':True}]}:
                            raise RuntimeError('important vote proof failed')
                        report[phase+'_important_proof']={'unmarked_high_priority':False,'marked_high_priority':True,'votes':2,'same_participant':True}
                # Planned commands cannot do HTTP or mutate credentials. Run
                # those independent parser/availability checks concurrently;
                # keep real participant/admin flows sequential.
                planned=[row for row in rows if row['scope']=='planned']
                before=stack.nginx_log()
                with ThreadPoolExecutor(max_workers=4) as pool:
                    for row,value in zip(planned,pool.map(invoke,planned)):
                        if value['exit']!=8:raise RuntimeError('planned command no longer returns exit 8: '+row['command'])
                        value['artifacts']=artifacts.copy();phase_values.append(value)
                after=stack.nginx_log()
                if before!=after:raise RuntimeError('planned command unexpectedly made an HTTP request')
                captured[phase]=phase_values
                report[phase+'_numeric_wire']=cli.numeric_checks.copy()
                report[phase+'_seconds']=round(time.monotonic()-phase_start,3)
                report[phase+'_slowest']=sorted(timings,key=lambda r:r['seconds'],reverse=True)[:5]
                captured_reads[phase]=capture_reads(stack.origin, stack.tokens['owner'])
                log=stack.nginx_log()
                report[phase+'_routing']={}
                serving_failures=[]
                for route,contract in route_contracts(routes):
                    matched_lines=route_lines(log,contract)
                    counts=routing_counts(matched_lines)
                    served=counts['rust_200'];fallback=counts['rust_fallbacks']
                    report[phase+'_routing'][route]=counts
                    if phase=='rust' and not serving_matches(counts, contract):serving_failures.append(route)
                    if phase=='node' and (counts['requests'] != contract['expected_requests']
                            or any(':5100' in line for line in matched_lines)):
                        raise RuntimeError('off-switch routing contract failed: '+route)
                if serving_failures:report['serving_failures']=serving_failures
            for row,a,b in zip(rows,captured['node'],captured['rust']):
                if row['scope']=='rust-only':
                    checks=rust_only_checks(row,a,b)
                    report['rust_only'].append({'scenario':row['scenario'],'contract':row['contract'],**RUST_ONLY[row['contract']],'node_actual_exit':a['exit'],'rust_actual_exit':b['exit'],'checks':checks,'passed':all(checks.values())})
                    continue
                diff=differences(a,b)
                report['rows'].append({'command':row['command'],'scenario':row.get('scenario',row['command']),'scope':row['scope'],'node_exit':a['exit'],'rust_exit':b['exit'],'equal':not diff,'different_paths':diff,'node_error':(a['json'].get('error') or {}).get('code'),'node_status':((a['json'].get('error') or {}).get('upstream') or {}).get('status'),'rust_status':((b['json'].get('error') or {}).get('upstream') or {}).get('status'),'rust_error':(b['json'].get('error') or {}).get('code')})
            report['reads']=compare_reads(captured_reads['node'],captured_reads['rust'])
            report['read_mismatches']=sum(not row['equal'] for row in report['reads'])
            report['pages'] = compare_pages(page_values['node'], page_values['rust'])
            report['page_mismatches'] = sum(not row['equal'] for row in report['pages'])
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
        report['cleanup_passed']=stack.down()
        report['elapsed_seconds']=round(time.monotonic()-started,3)
        output.parent.mkdir(parents=True,exist_ok=True)
        output.write_text(json.dumps(report,indent=2)+'\n')
    print(json.dumps({k:v for k,v in report.items() if k not in ['rows','rust_only']},indent=2))
    return 0 if report['complete'] and not report['mismatches'] and not report.get('read_mismatches') and not report.get('page_mismatches') and not report.get('rust_only_failures') and not report.get('unexpected_outcomes') and report['cleanup_passed'] and not report.get('serving_failures') else 1

if __name__=='__main__':sys.exit(main())
