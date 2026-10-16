#!/usr/bin/env python3
"""Live CLI join proof on an owned generated-data characterization stack.

Run after starting server/characterization/compose.yml with unique project/ports
and locally built images. No account sign-in, vote, or comment is manufactured.
The test writes generated conversation/invite fixtures only in that stack.
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
    proofs = []
    def sql(query):
        p = subprocess.run(compose + ['exec', '-T', 'postgres', 'psql', '-X', '-qAt', '-v', 'ON_ERROR_STOP=1', '-U', 'postgres', '-d', 'p027'],
                           input=query, text=True, capture_output=True, env=env)
        if p.returncode:
            raise RuntimeError('generated fixture query failed (details withheld)')
        return p.stdout.strip()
    def check(ok, name):
        if not ok:
            raise RuntimeError(name)
        proofs.append(name)
    owner = int(sql("INSERT INTO users(hname,email,is_owner) VALUES('Generated CLI owner','cli-join-" + secrets.token_hex(8) + "@example.invalid',true) RETURNING uid;"))
    def conversation(tree):
        zid = int(sql(f"INSERT INTO conversations(owner,topic,is_active,is_draft,is_public,treevite_enabled,profanity_filter,spam_filter) VALUES({owner},'Generated CLI join',true,false,true,{'true' if tree else 'false'},false,false) RETURNING zid;"))
        code = '2' + secrets.token_hex(10)
        sql(f"INSERT INTO zinvites(zid,zinvite) VALUES({zid},'{code}');")
        return zid, code
    open_zid, open_code = conversation(False)
    tree_zid, tree_code = conversation(True)
    wave = int(sql(f"INSERT INTO treevite_waves(zid,wave,parent_wave,invites_per_user,owner_invites,size) VALUES({tree_zid},1,0,0,1,1) RETURNING id;"))
    invite = secrets.token_hex(16)
    sql(f"INSERT INTO treevite_invites(zid,wave_id,invite_code) VALUES({tree_zid},{wave},'{invite}');")
    runtime_secrets = [invite]
    with tempfile.TemporaryDirectory(prefix='polis-join-live-') as temp:
        temp = Path(temp)
        def config(name):
            p = temp / name
            p.mkdir()
            (p/'profiles.json').write_text(json.dumps({'default':'local','sites':{'local':origin}}))
            return p
        first, returning = config('first'), config('returning')
        def call(directory, code, *flags, expected=0, human=False):
            childenv = {k:v for k,v in os.environ.items() if not k.startswith(('POLIS_TOKEN','POLIS_URL_')) and k not in ('POLIS_SITE',)}
            childenv['POLIS_CONFIG_DIR'] = str(directory)
            command = [binary, 'join', code, *flags, '--no-interactive']
            if not human:
                command.append('--json')
            p = subprocess.run(command, env=childenv, text=True, capture_output=True, timeout=40)
            if p.returncode != expected:
                raise RuntimeError(f'join exited {p.returncode}, expected {expected}; response withheld')
            if any(s in p.stdout or s in p.stderr for s in runtime_secrets):
                raise RuntimeError('join disclosed a credential')
            return p.stdout if human else json.loads(p.stdout)
        before = sql(f'SELECT count(*) FROM participants WHERE zid={open_zid};')
        for _ in range(2):
            result = call(first, open_code)
            check(result['data']['state']=='ready_not_enrolled', 'fresh/repeated anonymous bootstrap reports not enrolled')
        check(before == sql(f'SELECT count(*) FROM participants WHERE zid={open_zid};'), 'anonymous join does not create membership')
        check(not list((first/'credentials').glob('*.json')), 'anonymous bootstrap saves no invented token')
        result = call(first, tree_code)
        check(result['data']['state']=='ready_not_enrolled', 'invite conversation bootstrap reflects current Node readiness without enrollment')
        result = call(first, tree_code, '--invite', invite)
        check(result['data']['state']=='enrolled', 'valid invitation enrolls through Node')
        check(sql(f'SELECT count(*) FROM participants WHERE zid={tree_zid};')=='1', 'exactly one participant created')
        check(sql(f'SELECT status FROM treevite_invites WHERE zid={tree_zid} AND wave_id={wave};')=='1', 'one-time invite consumed')
        files = list((first/'credentials').glob('*.json'))
        check(len(files)==1, 'one participant credential file')
        saved = json.loads(files[0].read_text())
        token, login = saved['token'], saved['participant_login']
        runtime_secrets += [token,login]
        check(token not in json.dumps(result) and login not in json.dumps(result), 'acceptance output omits issued token and login secret')
        check(bool(token and login), 'token and returning login code stored privately')
        check(stat.S_IMODE(files[0].stat().st_mode)==0o600 and stat.S_IMODE(files[0].parent.stat().st_mode)==0o700, 'owner-only credential file and directory')
        result = call(first, tree_code)
        check(result['data']['enrolled'], 'repeated join reuses saved participant token')
        check(call(first, tree_code, human=True).startswith('Joined.'), 'human output is concise and credential-free')
        check(sql(f'SELECT count(*) FROM participants WHERE zid={tree_zid};')=='1', 'repeat join does not duplicate participant')
        result = call(returning, tree_code, '--login-code', login)
        check(result['data']['enrolled'], 'explicit returning login succeeds from a new store')
        result = call(returning, tree_code)
        check(result['data']['enrolled'], 'returning login token reused on bootstrap')
        check(sql(f'SELECT count(*) FROM participants WHERE zid={tree_zid};')=='1', 'returning login preserves same participant')
        result = call(returning, tree_code, '--invite', invite, expected=1)
        check(not result['ok'], 'used invitation refused without fallback or retry')
        result = call(returning, tree_code, '--login-code', 'invalidgeneratedlogin', expected=3)
        check(not result['ok'], 'invalid returning login refused')
        result = call(first, open_code)
        check(result['data']['state']=='ready_not_enrolled', 'invite token never crosses conversation scope')
        check(sql(f'SELECT count(*) FROM votes WHERE zid IN ({open_zid},{tree_zid});')=='0', 'join manufactures no votes')
        check(sql(f'SELECT count(*) FROM comments WHERE zid IN ({open_zid},{tree_zid});')=='0', 'join manufactures no comments')
    print(json.dumps({'passed':len(proofs),'failed':0,'checks':proofs}, indent=2))

if __name__ == '__main__':
    main()
