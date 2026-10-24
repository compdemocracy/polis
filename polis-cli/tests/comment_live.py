#!/usr/bin/env python3
"""Participant comment proof against an owned, isolated Node stack.

Generated fixtures only. Every comment is submitted through the real CLI.
No seed bypass, raw vote insertion, external provider, or server change.
"""
import argparse
import json
import os
from pathlib import Path
import secrets
import stat
import subprocess
import sys
import tempfile
import urllib.request

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
    proofs, private_values, outputs = [], [], []
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
    def next_statement(code):
        with urllib.request.urlopen(origin+'/api/v3/nextComment?conversation_id='+code, timeout=30) as response:
            return json.load(response)
    owner = int(sql("INSERT INTO users(hname,email,is_owner) VALUES('Generated comment owner','comment-"+secrets.token_hex(8)+"@example.invalid',true) RETURNING uid;"))
    def conversation(strict=False, tree=False, active=True):
        zid = int(sql(f"INSERT INTO conversations(owner,topic,is_active,is_draft,is_public,strict_moderation,treevite_enabled,profanity_filter,spam_filter) VALUES({owner},'Generated CLI comment',{'true' if active else 'false'},false,true,{'true' if strict else 'false'},{'true' if tree else 'false'},false,false) RETURNING zid;"))
        code = '2' + secrets.token_hex(10)
        sql(f"INSERT INTO zinvites(zid,zinvite) VALUES({zid},'{code}');")
        return zid,code
    open_zid,open_code=conversation()
    strict_zid,strict_code=conversation(strict=True)
    tree_zid,tree_code=conversation(strict=True,tree=True)
    closed_zid,closed_code=conversation(active=False)
    wave=int(sql(f"INSERT INTO treevite_waves(zid,wave,parent_wave,invites_per_user,owner_invites,size) VALUES({tree_zid},1,0,0,1,1) RETURNING id;"))
    invite=secrets.token_hex(16);private_values.append(invite)
    sql(f"INSERT INTO treevite_invites(zid,wave_id,invite_code) VALUES({tree_zid},{wave},'{invite}');")
    def rows(zid):
        return json.loads(sql(f"SELECT coalesce(json_agg(r ORDER BY tid),'[]') FROM (SELECT c.tid,c.pid,c.txt,c.mod,c.active,c.is_seed,c.uid,p.uid AS participant_uid FROM comments c JOIN participants p ON p.zid=c.zid AND p.pid=c.pid WHERE c.zid={zid}) r;"))
    with tempfile.TemporaryDirectory(prefix='polis-comment-live-') as temp:
        temp=Path(temp)
        def config(name):
            p=temp/name;p.mkdir();(p/'profiles.json').write_text(json.dumps({'default':'local','sites':{'local':origin}}));return p
        first,invited=[config(n) for n in ['first','invited']]
        def call(directory,args,expected=0,human=False):
            e={k:v for k,v in os.environ.items() if not k.startswith(('POLIS_TOKEN','POLIS_URL_')) and k!='POLIS_SITE'}
            e['POLIS_CONFIG_DIR']=str(directory)
            p=subprocess.run([binary,*args,'--no-interactive',*([] if human else ['--json'])],env=e,capture_output=True,text=True,timeout=40)
            outputs.append(p.stdout+p.stderr)
            if p.returncode!=expected:
                error=json.loads(p.stdout).get('error',{})
                raise RuntimeError(f"CLI exited {p.returncode}, expected {expected}; safe code={error.get('code')}, status={error.get('upstream',{}).get('status')}; body withheld")
            check(not any(s in outputs[-1] for s in private_values),'output omits submitted text and known credentials')
            return p.stdout if human else json.loads(p.stdout)
        def credentials(directory):
            files=list((directory/'credentials').glob('*.json'))
            check(all(stat.S_IMODE(f.stat().st_mode)==0o600 for f in files) and stat.S_IMODE((directory/'credentials').stat().st_mode)==0o700,'owner-only credential permissions')
            values=[json.loads(f.read_text()) for f in files]
            for v in values:
                private_values.append(v['token'])
                if v.get('participant_login'):private_values.append(v['participant_login'])
            return values
        def submit(directory,code,expected=0,human=False,text=None):
            text=text or 'Generated participant comment '+secrets.token_hex(8)
            private_values.append(text)
            return call(directory,['comment',code,text],expected,human),text
        first_receipt,text=submit(first,open_code)
        credentials(first)
        r=rows(open_zid)[0]
        check(r['txt']==text and r['tid']==first_receipt['data']['statement'],'first anonymous comment lands without prior join')
        check(sql(f"SELECT count(*) FROM users a JOIN users o ON a.site_id=o.site_id WHERE a.uid={r['uid']} AND o.uid={owner};")=='0','generated participant is not an owner-site moderator')
        check(r['pid']==first_receipt['data']['participant_id'] and r['uid']==r['participant_uid'],'comment belongs to the issued participant')
        check(not r['is_seed'] and r['mod']==0,'ordinary participant comment has no seed bypass or moderator approval')
        visible=next_statement(open_code)
        check(visible.get('tid')==r['tid'],'unmoderated comment is votable in an open non-strict conversation')
        # Vote through the existing semantic CLI choice, never write storage signs.
        vote=call(first,['vote',open_code,'--statement',str(r['tid']),'--agree'])
        check(vote['data']['participant_id']==r['pid'],'comment-issued identity is reused for voting')
        submit(first,open_code,human=True)
        check(len(rows(open_zid))==2 and len({r['pid'] for r in rows(open_zid)})==1,'following comments reuse one participant')
        submit(first,open_code,expected=5,text=text)
        check(len(rows(open_zid))==2,'duplicate refusal does not add or retry a comment')
        strict_receipt,strict_text=submit(first,strict_code)
        strict_row=rows(strict_zid)[0]
        check(strict_row['txt']==strict_text and strict_row['pid']==strict_receipt['data']['participant_id'],'strict comment is stored under its participant')
        check(strict_row['mod']==0 and not strict_row['is_seed'],'strict comment remains unmoderated and non-seed')
        check('tid' not in next_statement(strict_code),'strict moderation withholds pending comment from next-statement routing')
        check(len(credentials(first))==2,'conversation credentials remain separate')
        submit(invited,tree_code,expected=3)
        check(rows(tree_zid)==[],'uninvited comment is refused')
        call(invited,['join',tree_code,'--invite',invite]);before=credentials(invited)[0]
        invited_receipt,_=submit(invited,tree_code);after=credentials(invited)[0]
        check(before['participant_login']==after['participant_login'],'comment preserves the returning invite login secret')
        check(rows(tree_zid)[0]['pid']==invited_receipt['data']['participant_id'] and sql(f'SELECT count(*) FROM participants WHERE zid={tree_zid};')=='1','invited comment lands as the joined participant')
        check(rows(tree_zid)[0]['mod']==0 and not rows(tree_zid)[0]['is_seed'],'invited participant also remains subject to strict moderation')
        submit(first,closed_code,expected=4)
        check(rows(closed_zid)==[],'closed conversation stores no comment')
        submit(first,open_code,expected=1,text='x'*998)
        check(len(rows(open_zid))==2,'Node length refusal stores no comment and hides submitted text')
        check(sql(f'SELECT count(*) FROM votes WHERE zid IN ({open_zid},{strict_zid},{tree_zid},{closed_zid});')=='1','comments create no implicit author votes (only the explicit vote exists)')
        check(not any(secret in out for secret in private_values for out in outputs),'all outputs omit newly issued credentials and submitted texts')
    print(json.dumps({'passed':len(proofs),'failed':0,'checks':proofs,'strict_moderation_held':True,'anonymous_without_join':True},indent=2))


if __name__=='__main__':
    main()
