#!/usr/bin/env python3
"""Typed conversation setup, participant entry and partial-failure proof.

Only generated fixtures on an isolated Node stack. No provider or production
traffic. Every vote uses the semantic CLI, with storage read through Node's
convention module. Initial statements never use a seed bypass flag.
"""
import argparse
import errno
import http.client
from http.server import BaseHTTPRequestHandler, HTTPServer
import json
import os
from pathlib import Path
import pty
import secrets
import select
import stat
import subprocess
import sys
import tempfile
import threading
import time
import urllib.request

ROOT=Path(__file__).resolve().parents[2]
sys.path.insert(0,str(ROOT/'server/characterization'))
from isolation import isolated_environment


def main():
    p=argparse.ArgumentParser(description=__doc__)
    p.add_argument('--binary',required=True);p.add_argument('--compose-file',action='append',required=True)
    args=p.parse_args();env=isolated_environment(os.environ)
    compose=['docker','compose','-p',env['COMPOSE_PROJECT_NAME']]
    for f in args.compose_file:compose+=['-f',str(Path(f).resolve())]
    origin='http://127.0.0.1:'+env['P027_HTTP_PORT'];binary=str(Path(args.binary).resolve())
    proofs=[];private=[]
    def check(ok,name):
        if not ok:raise RuntimeError(name)
        proofs.append(name)
    def sql(query):
        r=subprocess.run(compose+['exec','-T','postgres','psql','-X','-qAt','-v','ON_ERROR_STOP=1','-U','postgres','-d','p027'],input=query,text=True,capture_output=True,env=env,timeout=30)
        if r.returncode:raise RuntimeError('generated fixture query failed; details withheld')
        return r.stdout.strip()
    def api(path,token=None):
        req=urllib.request.Request(origin+path,headers={'Authorization':'Bearer '+token} if token else {})
        with urllib.request.urlopen(req,timeout=30) as r:return json.load(r)
    with urllib.request.urlopen('http://127.0.0.1:'+env['P027_CONTROL_PORT']+'/tokens',timeout=30) as r:owner=json.load(r)['owner']
    private.append(owner);api('/api/v3/users',owner)
    def basic():
        return {'topic':'Generated setup '+secrets.token_hex(8),'description':'Generated description','context':'generated-context','activity':'open','listing':'listed',
                'join':{'invitations':{'mode':'required','first_wave':{'owner_invites':2,'per_participant':0},'later_waves':[]},'external_identity':{'mode':'optional'}},
                'moderation':'before_visibility','visibility':'hide_social_list','data_access':'owner','profanity_filter':False,'short_url':False,'seeds':['Generated initial statement '+secrets.token_hex(8)]}
    with tempfile.TemporaryDirectory(prefix='polis-setup-live-') as temp:
        temp=Path(temp)
        def config(name,url=origin):
            d=temp/name;d.mkdir();(d/'profiles.json').write_text(json.dumps({'default':'local','sites':{'local':url}}));return d
        admin=config('admin');participant=config('participant')
        def childenv(directory,account=False):
            e={k:v for k,v in os.environ.items() if not k.startswith(('POLIS_TOKEN','POLIS_URL_')) and k!='POLIS_SITE'}
            e['POLIS_CONFIG_DIR']=str(directory)
            if account:e['POLIS_TOKEN_LOCAL']=owner
            return e
        def call(directory,args,expected=0,account=False):
            r=subprocess.run([binary,*args,'--json','--no-interactive'],env=childenv(directory,account),text=True,capture_output=True,timeout=90)
            data=json.loads(r.stdout)
            if r.returncode!=expected:
                raise RuntimeError(f"CLI exit {r.returncode}, expected {expected}; safe code={data.get('error',{}).get('code')}; step={data.get('data',{}).get('failed_step')}; details withheld")
            check(not any(s in r.stdout+r.stderr for s in private),'command output omits generated credentials')
            return data
        def create(s,directory=admin):
            f=temp/(secrets.token_hex(8)+'.json');f.write_text(json.dumps(s))
            r=call(directory,['conversation','new','--from',str(f)],account=True)['data']
            check(r['state']=='created' and all(x['state']=='confirmed' for x in r['steps']),'setup completes every readback step')
            return r
        def inspect(code):return api('/api/v3/conversations?conversation_id='+code,owner)
        def sign_proof(code,tid,pid):
            script="""require('ts-node/register/transpile-only');const {Pool}=require('pg');const {storageToSemantic}=require('./src/votes/convention.ts');(async()=>{const p=new Pool({connectionString:process.env.DATABASE_URL});const {rows}=await p.query('SELECT v.vote,v.pid,p.uid FROM votes v JOIN participants p ON p.zid=v.zid AND p.pid=v.pid WHERE v.zid=(SELECT zid FROM zinvites WHERE zinvite=$1) AND v.tid=$2',[process.argv[1],Number(process.argv[2])]);console.log(JSON.stringify(rows.map(r=>({pid:r.pid,choice:storageToSemantic(r.vote)}))));await p.end()})().catch(()=>process.exit(1))"""
            r=subprocess.run(compose+['exec','-T','server','node','-e',script,code,str(tid)],env=env,text=True,capture_output=True,timeout=30)
            check(r.returncode==0 and json.loads(r.stdout)==[{'pid':pid,'choice':'agree'}],'CLI vote lands as requested meaning and participant')
        s=basic();first=create(s);code=first['conversation_id'];conv=inspect(code)
        check(conv['treevite_enabled'] and conv['is_active'] and conv['strict_moderation'],'required-invitation final settings match file')
        check(conv['is_anon'] and conv['context']==s['context'] and conv['description']==s['description'],'content, context and social visibility persist')
        invites=api('/api/v3/treevite/invites?conversation_id='+code,owner)['invites']
        check(len(invites)==2,'wizard mints the requested owner codes')
        invite=invites[0]['invite_code'];private.append(invite)
        call(participant,['join',code,'--invite',invite])
        tid=next(x['statement'] for x in first['steps'] if x['step']=='statement_1')
        vote=call(participant,['vote',code,'--statement',str(tid),'--agree'])['data'];sign_proof(code,tid,vote['participant_id'])
        check(sql("SELECT count(*) FROM votes WHERE zid=(SELECT zid FROM zinvites WHERE zinvite='"+code+"');")=='1','initial statements create no implicit author votes')
        check(sql("SELECT bool_and(NOT is_seed) FROM comments WHERE zid=(SELECT zid FROM zinvites WHERE zinvite='"+code+"');")=='t','initial statements use moderator authority without seed flag')
        anon=config('anonymous');call(anon,['vote',code,'--statement',str(tid),'--agree'],expected=3)
        check(inspect(code)['treevite_enabled'],'uninvited vote refusal preserves required invitations')
        # Optional invitations and anonymous entry coexist.
        s=basic();s['join']['invitations']={'mode':'optional','waves':[{'owner_invites':1,'per_participant':0}]};s['moderation']='after_submission';s['data_access']='public';s['short_url']=True
        second=create(s);code2=second['conversation_id'];tid2=next(x['statement'] for x in second['steps'] if x['step']=='statement_1')
        check(not inspect(code2)['treevite_enabled'] and inspect(code2)['is_data_open'],'optional invitation/data-access settings match file')
        joined=call(anon,['join',code2]);check(joined['data']['state']=='ready_not_enrolled','anonymous join remains optional readiness')
        voted=call(anon,['vote',code2,'--statement',str(tid2),'--agree'])['data'];sign_proof(code2,tid2,voted['participant_id'])
        optional_invite=api('/api/v3/treevite/invites?conversation_id='+code2,owner)['invites'][0]['invite_code'];private.append(optional_invite)
        optional=config('optional-invited');check(call(optional,['join',code2,'--invite',optional_invite])['data']['enrolled'],'invite acceptance works alongside anonymous entry')
        # All overlapping admission flags, multiple waves, closed + draft remain representable.
        s=basic();s['activity']='closed';s['listing']='draft';s['join']['external_identity']={'mode':'allowlist','ids':['generated-a','generated-b']};s['join']['invitations']['later_waves']=[{'owner_invites':1,'per_participant':1}]
        third=create(s);c3=inspect(third['conversation_id'])
        check(not c3['is_active'] and c3['is_draft'] and c3['treevite_enabled'] and c3['xid_required'] and c3['use_xid_whitelist'],'closed draft preserves overlapping invitation and XID gates')
        listed=api('/api/v3/xidAllowList?conversation_id='+third['conversation_id'],owner)
        check({x['xid'] for x in listed['xids']}=={'generated-a','generated-b'},'allowlist is read back with exact generated IDs')
        check(len(api('/api/v3/treevite/waves?conversation_id='+third['conversation_id'],owner))==2,'both requested waves persist')
        # Real terminal wizard and saved file; approval comes after the summary.
        saved=temp/'wizard.json';topic='Generated terminal '+secrets.token_hex(8)
        answers=[topic,'Description','','1','1','2','1','1','0','1','1','1','1','2','1','1','Terminal initial statement']
        master,slave=pty.openpty();proc=subprocess.Popen([binary,'conversation','new','--save',str(saved)],env=childenv(admin,True),stdin=slave,stdout=slave,stderr=slave,close_fds=True);os.close(slave)
        data=b'';approved=False;deadline=time.monotonic()+90
        try:
            os.write(master,('\n'.join(answers)+'\n').encode())
            while time.monotonic()<deadline:
                if select.select([master],[],[],0.2)[0]:
                    try:chunk=os.read(master,65536)
                    except OSError as e:
                        if e.errno==errno.EIO:break
                        raise
                    if not chunk:break
                    data+=chunk
                    if b'Type yes to create it:' in data and not approved:
                        check(b'Setup summary:' in data,'terminal wizard summarizes before approval');os.write(master,b'yes\n');approved=True
                if proc.poll() is not None:break
            check(proc.wait(timeout=2)==0,'terminal wizard applies successfully')
        finally:
            if proc.poll() is None:proc.kill();proc.wait()
            os.close(master)
        check(approved and b'"state": "created"' in data,'interactive setup reaches created receipt')
        check(stat.S_IMODE(saved.stat().st_mode)==0o600 and json.loads(saved.read_text())['topic']==topic,'wizard saves its same typed model privately')
        check(not any(s.encode() in data for s in private),'terminal output omits credentials')
        # Controlled failure of settings after real creation: do not retry or publish.
        requests=[]
        class FailSettings(BaseHTTPRequestHandler):
            def log_message(self,*args):pass
            def forward(self):
                requests.append(self.command)
                if self.command=='PUT':self.send_response(500);self.end_headers();self.wfile.write(b'{}');return
                body=self.rfile.read(int(self.headers.get('Content-Length','0')))
                conn=http.client.HTTPConnection('127.0.0.1',int(env['P027_HTTP_PORT']),timeout=30)
                headers={k:v for k,v in self.headers.items() if k.lower() not in ['connection','host']};headers['Connection']='close'
                conn.request(self.command,self.path,body=body,headers=headers);r=conn.getresponse();data=r.read()
                self.send_response(r.status);self.send_header('Content-Type',r.getheader('Content-Type','application/json'));self.send_header('Content-Length',str(len(data)));self.end_headers();self.wfile.write(data);conn.close()
            do_POST=forward;do_GET=forward;do_PUT=forward
        proxy=HTTPServer(('127.0.0.1',0),FailSettings);t=threading.Thread(target=proxy.serve_forever,daemon=True);t.start()
        try:
            d=config('partial','http://127.0.0.1:'+str(proxy.server_port));s=basic();f=temp/'partial.json';f.write_text(json.dumps(s))
            r=call(d,['conversation','new','--from',str(f)],expected=7,account=True)['data']
            check(r['failed_step']=='settings' and r['steps']==[{'step':'create','state':'confirmed','conversation_id':r['conversation_id']}],'partial receipt identifies exactly the confirmed create')
            check(requests==['POST','GET','PUT'],'failed settings call is never retried or followed by more steps')
            partial=inspect(r['conversation_id']);check(not partial['is_active'] and partial['treevite_enabled'],'partial setup stays staged and is not opened')
        finally:proxy.shutdown();proxy.server_close();t.join()
    print(json.dumps({'passed':len(proofs),'failed':0,'checks':proofs,'interactive':True,'invite_and_anonymous':True,'partial_failure':True},indent=2))


if __name__=='__main__':main()
