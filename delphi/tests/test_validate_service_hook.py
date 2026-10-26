"""Actual validation shell control flow, deterministic command-level failure probes."""
import os
import subprocess
from pathlib import Path
import pytest

def _validate_service_path():
    # The container flattens delphi/tests to /app/tests. Use the same explicit
    # checkout root as the other hook tests; never silently skip a missing hook.
    override = os.environ.get("POLIS_CHECKOUT_DIR")
    candidates = [Path(override)] if override else Path(__file__).resolve().parents
    for root in candidates:
        path = root / "scripts/validate_service.sh"
        if path.is_file():
            return path
    raise FileNotFoundError(
        "scripts/validate_service.sh not found; run scripts/test-deploy-hooks.sh "
        "or set POLIS_CHECKOUT_DIR to the checkout root"
    )


VALIDATE_SERVICE_PATH = _validate_service_path()

def probe(tmp_path, role='server', state='running false none', http=0, missing=False, drain=0, start='0', routes='', rust_http=0, rust_state='running false none', config_status=0):
    bin_dir=tmp_path/'bin';bin_dir.mkdir()
    (tmp_path/'service_type.txt').write_text(role)
    (tmp_path/'VERSION').write_text('2.0.0\n')
    (tmp_path/'deployed-images.txt').write_text('revision=' + 'a'*40 + '\n')
    source=VALIDATE_SERVICE_PATH.read_text()
    source=source.replace('/opt/polis/deployed-images.txt',str(tmp_path/'deployed-images.txt'))
    source=source.replace('/opt/polis/polis',str(tmp_path)).replace('/etc/app-info/service_type.txt',str(tmp_path/'service_type.txt')).replace('/usr/local/bin/docker-compose','docker-compose')
    script=tmp_path/'validate.sh';script.write_text(source)
    fakes={
        'sudo':'exec "$@"',
        'sleep':'exit 0',
        'docker-compose':'''shift 4
case "$*" in *"config --format json"*) exit "$CONFIG_STATUS";; esac
case "$1" in
 ps) [ "$MISSING" = 1 ] || { [ "${@: -1}" != polis-api ] && echo owned || echo rust; } ;;
 exec) case "$*" in *polis-api:5100*) echo rust >> "$CALLS"; exit "$RUST_HTTP";;
       *) echo http >> "$CALLS"; exit "$HTTP_STATUS";; esac ;;
 *) exit 90 ;; esac''',
        'jq':'''cat >/dev/null
case "$*" in *POLIS_API_START*) echo "$START";; *) echo "$ROUTES";; esac''',
        'docker':'''case "$*" in *' rust') echo "$RUST_STATE";; *Health*) echo "$STATE";; *) echo 'running false';; esac''',
        'systemctl':'''n=0; [ ! -f "$COUNT" ] || n=$(cat "$COUNT"); n=$((n+1)); echo "$n" > "$COUNT"; [ "$n" -gt "$DRAIN" ]''',
    }
    for name,body in fakes.items():
        f=bin_dir/name;f.write_text('#!/bin/bash\n'+body+'\n');f.chmod(0o755)
    env=dict(os.environ,PATH=str(bin_dir)+':/usr/bin:/bin',STATE=state,HTTP_STATUS=str(http),START=start,ROUTES=routes,RUST_HTTP=str(rust_http),RUST_STATE=rust_state,CONFIG_STATUS=str(config_status),MISSING=str(int(missing)),DRAIN=str(drain),COUNT=str(tmp_path/'count'),CALLS=str(tmp_path/'calls'))
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


@pytest.mark.parametrize("start,routes", [("1", ""), ("0", "pca2")])
def test_healthy_warm_or_selected_rust_is_probed_three_times(tmp_path, start, routes):
    p = probe(tmp_path, start=start, routes=routes)
    assert p.returncode == 0, p.stderr
    assert (tmp_path/'calls').read_text().splitlines() == ['http', 'rust'] * 3
    assert p.stdout.count('polis-api health ok') == 3


@pytest.mark.parametrize("kw", [dict(rust_http=1), dict(rust_state='running true none'),
                              dict(rust_state='exited false none')])
@pytest.mark.parametrize("routes", ["", " , ", "pca2"])
def test_rust_failure_only_rejects_validation_when_a_route_is_selected(tmp_path, kw, routes):
    p = probe(tmp_path, start='1', routes=routes, **kw)
    assert (p.returncode != 0) == (routes == "pca2")
    assert 'polis-api health failed' in p.stderr
    if routes != "pca2":
        assert 'ValidateService passed' in p.stdout
        assert (tmp_path/'calls').read_text().splitlines().count('http') == 3


@pytest.mark.parametrize("kw", [dict(start='true'), dict(config_status=1)])
def test_invalid_or_unreadable_config_cannot_skip_health(tmp_path, kw):
    assert probe(tmp_path, **kw).returncode != 0
