#!/usr/bin/env python3
"""CLI voting proof against an owned, isolated Node characterization stack.

All votes are submitted by the CLI. Storage is READ through the server's vote
convention module. Generated conversation, statement and invite fixtures only.
"""
import argparse
import errno
import json
import os
from pathlib import Path
import pty
import re
import secrets
import select
import stat
import subprocess
import sys
import tempfile
import time

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / 'server/characterization'))
from isolation import isolated_environment


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--binary', required=True)
    parser.add_argument('--compose-file', action='append', required=True)
    args = parser.parse_args()
    env = isolated_environment(os.environ)
    compose = ['docker', 'compose', '-p', env['COMPOSE_PROJECT_NAME']]
    for file in args.compose_file:
        compose += ['-f', str(Path(file).resolve())]
    origin = 'http://127.0.0.1:' + env['P027_HTTP_PORT']
    binary = str(Path(args.binary).resolve())
    proofs, runtime_secrets = [], []
    def sql(query):
        p = subprocess.run(compose + ['exec', '-T', 'postgres', 'psql', '-X', '-qAt', '-v', 'ON_ERROR_STOP=1', '-U', 'postgres', '-d', 'p027'],
                           input=query, text=True, capture_output=True, env=env, timeout=30)
        if p.returncode:
            raise RuntimeError('generated fixture query failed (details withheld)')
        return p.stdout.strip()
    def check(ok, name):
        if not ok:
            raise RuntimeError(name)
        proofs.append(name)
    def rows(zid):
        # No storage sign literal or conversion is duplicated in this driver.
        script = """
require('ts-node/register/transpile-only');
const {storageToSemantic} = require('./src/votes/convention.ts');
const {Pool} = require('pg');
(async () => {
 const pool = new Pool({connectionString: process.env.DATABASE_URL});
 const {rows} = await pool.query('SELECT v.tid,v.pid,v.vote,p.uid FROM votes v JOIN participants p ON p.zid=v.zid AND p.pid=v.pid WHERE v.zid=$1 ORDER BY v.tid', [Number(process.argv[1])]);
 console.log(JSON.stringify(rows.map(r => ({...r, choice:storageToSemantic(r.vote)}))));
 await pool.end();
})().catch(() => { process.stderr.write('storage verification failed');process.exit(1); });
"""
        p = subprocess.run(compose + ['exec','-T','server','node','-e',script,str(zid)], env=env, text=True, capture_output=True, timeout=30)
        if p.returncode:
            raise RuntimeError('storage convention read failed (details withheld)')
        return json.loads(p.stdout)
    owner = int(sql("INSERT INTO users(hname,email,is_owner) VALUES('Generated voting owner','vote-"+secrets.token_hex(8)+"@example.invalid',true) RETURNING uid;"))
    def conversation(tree=False, active=True):
        zid = int(sql(f"INSERT INTO conversations(owner,topic,is_active,is_draft,is_public,treevite_enabled,profanity_filter,spam_filter) VALUES({owner},'Generated CLI voting',{'true' if active else 'false'},false,true,{'true' if tree else 'false'},false,false) RETURNING zid;"))
        code = '2' + secrets.token_hex(10)
        sql(f"INSERT INTO zinvites(zid,zinvite) VALUES({zid},'{code}');")
        seed_pid=int(sql(f"INSERT INTO participants(zid,uid) VALUES({zid},{owner}) RETURNING pid;"))
        tids=[]
        for index in range(3):
            tids.append(int(sql(f"INSERT INTO comments(zid,pid,uid,txt,mod,active,is_seed,lang) VALUES({zid},{seed_pid},{owner},'Generated statement {index}',0,true,true,'en') RETURNING tid;")))
        return zid, code, tids
    open_zid, open_code, tids = conversation()
    other_zid, other_code, other_tids = conversation()
    tree_zid, tree_code, tree_tids = conversation(True)
    loop_zid, loop_code, _ = conversation()
    quit_zid, quit_code, _ = conversation()
    closed_zid, closed_code, closed_tids = conversation(active=False)
    wave = int(sql(f"INSERT INTO treevite_waves(zid,wave,parent_wave,invites_per_user,owner_invites,size) VALUES({tree_zid},1,0,0,1,1) RETURNING id;"))
    invite = secrets.token_hex(16); runtime_secrets.append(invite)
    sql(f"INSERT INTO treevite_invites(zid,wave_id,invite_code) VALUES({tree_zid},{wave},'{invite}');")
    with tempfile.TemporaryDirectory(prefix='polis-vote-live-') as temp:
        temp=Path(temp)
        def config(name):
            p=temp/name;p.mkdir();(p/'profiles.json').write_text(json.dumps({'default':'local','sites':{'local':origin}}));return p
        first, invited, interactive, quitting = [config(n) for n in ['first','invited','interactive','quitting']]
        def childenv(directory):
            e={k:v for k,v in os.environ.items() if not k.startswith(('POLIS_TOKEN','POLIS_URL_')) and k!='POLIS_SITE'}
            e['POLIS_CONFIG_DIR']=str(directory);return e
        def call(directory, args, expected=0, human=False):
            p=subprocess.run([binary,*args,'--no-interactive',*([] if human else ['--json'])],env=childenv(directory),capture_output=True,text=True,timeout=40)
            if p.returncode!=expected:
                raise RuntimeError(f'CLI exited {p.returncode}, expected {expected}; response withheld')
            check(not any(s in p.stdout or s in p.stderr for s in runtime_secrets),'command output omits known credentials')
            return p.stdout if human else json.loads(p.stdout)
        def credentials(directory):
            files=list((directory/'credentials').glob('*.json'))
            check(all(stat.S_IMODE(f.stat().st_mode)==0o600 for f in files) and stat.S_IMODE((directory/'credentials').stat().st_mode)==0o700,'owner-only participant credentials')
            values=[json.loads(f.read_text()) for f in files]
            for v in values:
                runtime_secrets.append(v['token'])
                if v.get('participant_login'):runtime_secrets.append(v['participant_login'])
            return values
        check(sql(f'SELECT count(*) FROM participants WHERE uid<>{owner} AND zid={open_zid};')=='0','open conversation starts with no anonymous participant (seed author excluded)')
        output=[]
        for tid,choice in zip(tids,['agree','disagree','pass']):
            result=call(first,['vote',open_code,'--statement',str(tid),'--'+choice])
            output.append(result)
            check(result['data']['state']=='recorded' and result['data']['choice']==choice,'direct anonymous '+choice+' succeeds without join')
            credentials(first)
        check(sql(f'SELECT count(*) FROM participants WHERE uid<>{owner} AND zid={open_zid};')=='1','all three anonymous votes reuse exactly one participant')
        stored=rows(open_zid)
        check([r['choice'] for r in stored]==['agree','disagree','pass'],'all stored values decode through server convention to requested choices')
        check(len({r['pid'] for r in stored})==1 and all(r['pid']==v['data']['participant_id'] for r,v in zip(stored,output)),'every stored vote joins to the issued participant')
        check(not any(s in json.dumps(output) for s in runtime_secrets),'first issuance and following outputs omit issued tokens')
        call(first,['join',open_code])
        check(sql(f'SELECT count(*) FROM participants WHERE uid<>{owner} AND zid={open_zid};')=='1','optional join after voting reuses participant')
        call(first,['vote',other_code,'--statement',str(other_tids[0]),'--pass'],human=True)
        check(len(credentials(first))==2,'another conversation gets separate credentials')
        check(sql(f'SELECT count(*) FROM participants WHERE uid<>{owner} AND zid={other_zid};')=='1','second conversation gets its own participant')
        call(invited,['vote',tree_code,'--statement',str(tree_tids[0]),'--agree'],expected=3)
        check(rows(tree_zid)==[],'uninvited vote is refused without a vote')
        call(invited,['join',tree_code,'--invite',invite])
        before=credentials(invited)[0]
        result=call(invited,['vote',tree_code,'--statement',str(tree_tids[0]),'--agree'])
        after=credentials(invited)[0]
        check(before['participant_login']==after['participant_login'],'voting preserves returning invite login secret')
        check(rows(tree_zid)[0]['choice']=='agree' and sql(f'SELECT count(*) FROM participants WHERE uid<>{owner} AND zid={tree_zid};')=='1','invited vote is correctly signed and reuses enrolled participant')
        call(first,['vote',closed_code,'--statement',str(closed_tids[0]),'--agree'],expected=4)
        check(rows(closed_zid)==[],'closed conversation stores no vote')
        def terminal(directory,code,answers):
            master,slave=pty.openpty()
            proc=subprocess.Popen([binary,'vote',code],env=childenv(directory),stdin=slave,stdout=slave,stderr=slave,close_fds=True)
            os.close(slave); data=b'';sent=0; deadline=time.monotonic()+60
            try:
                while time.monotonic()<deadline:
                    if select.select([master],[],[],0.2)[0]:
                        try: chunk=os.read(master,65536)
                        except OSError as e:
                            if e.errno==errno.EIO:break
                            raise
                        if not chunk:break
                        data+=chunk
                        prompts=data.count(b'[q]uit: ')
                        while sent<prompts and sent<len(answers):
                            os.write(master,(answers[sent]+'\n').encode());sent+=1
                    if proc.poll() is not None:break
                check(proc.wait(timeout=2)==0,'terminal voting exits successfully')
            finally:
                if proc.poll() is None:proc.kill();proc.wait()
                os.close(master)
            check(not any(s.encode() in data for s in runtime_secrets),'terminal output omits known credentials')
            return data.decode(),sent
        transcript,sent=terminal(interactive,loop_code,['a','d','p'])
        credentials(interactive)
        check(sent==3 and 'No more comments available.' in transcript,'interactive loop advances through three statements to exhaustion')
        live=rows(loop_zid)
        shown=[int(tid) for tid in re.findall(r'Statement (\d+):',transcript)]
        check({r['tid']:r['choice'] for r in live}==dict(zip(shown,['agree','disagree','pass'])), 'interactive answers match each displayed statement in storage')
        check(sorted(r['choice'] for r in live)==['agree','disagree','pass'] and len({r['pid'] for r in live})==1,'interactive choices are correctly stored under one anonymous participant')
        check(not any(s in transcript for s in runtime_secrets),'terminal never prints newly issued credentials')
        transcript,sent=terminal(quitting,quit_code,['q'])
        check(sent==1 and rows(quit_zid)==[] and sql(f'SELECT count(*) FROM participants WHERE uid<>{owner} AND zid={quit_zid};')=='0','quit never manufactures a participant or vote')
    print(json.dumps({'passed':len(proofs),'failed':0,'checks':proofs,'storage_choices':[r['choice'] for r in stored],'anonymous_without_join':True,'interactive':True},indent=2))


if __name__=='__main__':
    main()
