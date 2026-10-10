"""Actual validation shell control flow, deterministic command-level failure probes."""
import os
import subprocess
from pathlib import Path
import pytest

ROOT = Path(__file__).resolve().parents[2]

def probe(tmp_path, role='server', state='running false none', http=0, missing=False, drain=0):
    bin_dir=tmp_path/'bin';bin_dir.mkdir()
    (tmp_path/'service_type.txt').write_text(role)
    source=(ROOT/'scripts/validate_service.sh').read_text()
    source=source.replace('/opt/polis/polis',str(tmp_path)).replace('/etc/app-info/service_type.txt',str(tmp_path/'service_type.txt')).replace('/usr/local/bin/docker-compose','docker-compose')
    script=tmp_path/'validate.sh';script.write_text(source)
    fakes={
        'sudo':'exec "$@"',
        'sleep':'exit 0',
        'docker-compose':'''case "$1" in
 ps) [ "$MISSING" = 1 ] || echo owned ;;
 exec) echo http >> "$CALLS"; exit "$HTTP_STATUS" ;;
 *) exit 90 ;; esac''',
        'docker':'''case "$*" in *Health*) echo "$STATE";; *) echo 'running false';; esac''',
        'systemctl':'''n=0; [ ! -f "$COUNT" ] || n=$(cat "$COUNT"); n=$((n+1)); echo "$n" > "$COUNT"; [ "$n" -gt "$DRAIN" ]''',
    }
    for name,body in fakes.items():
        f=bin_dir/name;f.write_text('#!/bin/bash\n'+body+'\n');f.chmod(0o755)
    env=dict(os.environ,PATH=str(bin_dir)+':/usr/bin:/bin',STATE=state,HTTP_STATUS=str(http),MISSING=str(int(missing)),DRAIN=str(drain),COUNT=str(tmp_path/'count'),CALLS=str(tmp_path/'calls'))
    return subprocess.run(['bash',str(script)],env=env,text=True,capture_output=True,timeout=30)

def test_healthy_server_requires_three_http_successes(tmp_path):
    p=probe(tmp_path);assert p.returncode==0,p.stderr
    assert (tmp_path/'calls').read_text().splitlines()==['http']*3

@pytest.mark.parametrize('kw',[{'http':1},{'missing':True},{'state':'exited false none'},{'state':'running true none'},{'state':'running false unhealthy'}])
def test_unhealthy_server_fails_even_when_other_checks_pass(tmp_path,kw):
    p=probe(tmp_path,**kw);assert p.returncode!=0
    assert 'ValidateService failed' in p.stderr

@pytest.mark.parametrize('role',['delphi-large','delphi-worker'])
def test_worker_drain_can_outlast_server_validation_window(tmp_path,role):
    p=probe(tmp_path,role=role,drain=80);assert p.returncode==0,p.stderr
    assert int((tmp_path/'count').read_text())==83

def test_unknown_role_fails(tmp_path):
    assert probe(tmp_path,role='unknown').returncode!=0

def test_retired_math_role_needs_no_containers(tmp_path):
    assert probe(tmp_path,role='math',missing=True).returncode==0
