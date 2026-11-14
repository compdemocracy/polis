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

def probe(tmp_path, role='server', state='running false none', http=0, missing=False, drain=0, start='0', routes='', rust_http=0, rust_state='running false none', config_status=0, shadow_http=0, shadow_state='running false none', reads_http=0, reads_state='running false none', hook=None, absent=''):
    bin_dir=tmp_path/'bin';bin_dir.mkdir()
    (tmp_path/'service_type.txt').write_text(role)
    (tmp_path/'VERSION').write_text('2.0.0\n')
    (tmp_path/'deployed-images.txt').write_text('revision=' + 'a'*40 + '\n')
    # The deploy hook beside the script: the real one unless a test gives its text.
    (tmp_path/'after_install.sh').write_text(
        (VALIDATE_SERVICE_PATH.parent/'after_install.sh').read_text() if hook is None else hook)
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
 ps) echo "${@: -1}" >> "$CALLS.ps"
     [ "$MISSING" = 1 ] || case " $ABSENT " in *" ${@: -1} "*) ;; *)
       case "${@: -1}" in polis-api) echo rust;; polis-api-shadow) echo shadow;; polis-api-shadow-reads) echo reads;; *) echo owned;; esac ;; esac ;;
 exec) case "$*" in *polis-api:5100*) echo rust >> "$CALLS"; exit "$RUST_HTTP";;
       *polis-api-shadow-reads:5102*) echo reads >> "$CALLS"; echo "${@: -3}" >> "$CALLS.reads"; exit "$READS_HTTP";;
       *polis-api-shadow:5101*) echo shadow >> "$CALLS"; echo "${@: -1}" >> "$CALLS.comments"; exit "$SHADOW_HTTP";;
       *) echo http >> "$CALLS"; exit "$HTTP_STATUS";; esac ;;
 *) exit 90 ;; esac''',
        'jq':'''cat >/dev/null
case "$*" in *POLIS_API_START*) echo "$START";; *) echo "$ROUTES";; esac''',
        'docker':'''case "$*" in *' rust') echo "$RUST_STATE";; *' shadow') echo "$SHADOW_STATE";; *' reads') echo "$READS_STATE";; *Health*) echo "$STATE";; *) echo 'running false';; esac''',
        'systemctl':'''n=0; [ ! -f "$COUNT" ] || n=$(cat "$COUNT"); n=$((n+1)); echo "$n" > "$COUNT"; [ "$n" -gt "$DRAIN" ]''',
    }
    for name,body in fakes.items():
        f=bin_dir/name;f.write_text('#!/bin/bash\n'+body+'\n');f.chmod(0o755)
    env=dict(os.environ,PATH=str(bin_dir)+':/usr/bin:/bin',STATE=state,HTTP_STATUS=str(http),START=start,ROUTES=routes,RUST_HTTP=str(rust_http),RUST_STATE=rust_state,CONFIG_STATUS=str(config_status),SHADOW_HTTP=str(shadow_http),SHADOW_STATE=shadow_state,READS_HTTP=str(reads_http),READS_STATE=reads_state,MISSING=str(int(missing)),ABSENT=absent,DRAIN=str(drain),COUNT=str(tmp_path/'count'),CALLS=str(tmp_path/'calls'))
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


# The Delphi box requires exactly the services the deploy hook beside this
# script names in DELPHI_SERVICES: taking math-python off that line (its
# durable stop) must not fail the deployment, which CodeDeploy would roll back
# to the previous revision, starting math-python again.
def _hook_naming(services):
    return f'#!/bin/bash\n  # DELPHI_SERVICES=(not this comment)\n  DELPHI_SERVICES=({services})\n'


def test_the_delphi_box_requires_the_services_the_real_hook_names(tmp_path):
    p = probe(tmp_path, role='delphi')
    assert p.returncode == 0, p.stderr
    assert (tmp_path/'calls.ps').read_text().split() == ['delphi', 'math-python'] * 3


def test_the_delphi_box_fails_when_a_named_service_has_no_container(tmp_path):
    p = probe(tmp_path, role='delphi', absent='math-python')
    assert p.returncode != 0
    assert 'ValidateService failed' in p.stderr


def test_a_service_taken_off_the_list_is_not_required(tmp_path):
    p = probe(tmp_path, role='delphi', hook=_hook_naming('delphi'), absent='math-python')
    assert p.returncode == 0, p.stderr
    assert (tmp_path/'calls.ps').read_text().split() == ['delphi'] * 3


@pytest.mark.parametrize('hook', ['#!/bin/bash\n', _hook_naming(''), _hook_naming('delphi') * 2,
                                  '  DELPHI_SERVICES=("$X")\n'])
def test_the_delphi_box_fails_without_exactly_one_plain_service_line(tmp_path, hook):
    p = probe(tmp_path, role='delphi', hook=hook)
    assert p.returncode != 0
    assert 'exactly one DELPHI_SERVICES=(...) line' in p.stderr
    assert not (tmp_path/'calls.ps').exists()


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


# The vote shadow (votesShadow) is its own service, polis-api-shadow. Selected,
# its health is required on every poll, after the main polis-api's.
@pytest.mark.parametrize("routes", ["votesShadow", "pca2,votesShadow", " pca2 votesShadow "])
def test_selected_shadow_is_probed_three_times_and_required(tmp_path, routes):
    p = probe(tmp_path, routes=routes)
    assert p.returncode == 0, p.stderr
    assert (tmp_path/'calls').read_text().splitlines() == ['http', 'rust', 'shadow'] * 3
    assert p.stdout.count('polis-api-shadow health ok') == 3


@pytest.mark.parametrize("kw", [dict(shadow_http=1), dict(shadow_state='running true none'),
                                dict(shadow_state='exited false none')])
def test_shadow_failure_rejects_validation(tmp_path, kw):
    p = probe(tmp_path, routes='pca2,votesShadow', **kw)
    assert p.returncode != 0
    assert 'polis-api-shadow health failed' in p.stderr
    assert 'ValidateService failed' in p.stderr


@pytest.mark.parametrize("routes", ["", "pca2", "votesShadows", "votesRead"])
def test_unselected_shadow_is_not_probed(tmp_path, routes):
    p = probe(tmp_path, start='1', routes=routes, shadow_http=1)
    assert p.returncode == 0, p.stderr
    assert 'shadow' not in (tmp_path/'calls').read_text().splitlines()


@pytest.mark.parametrize("routes", ["postVotes,votesShadow", "votesShadow postVotes"])
def test_shadow_with_the_live_vote_writer_is_refused_before_polling(tmp_path, routes):
    p = probe(tmp_path, routes=routes)
    assert p.returncode != 0
    assert 'votesShadow and postVotes' in p.stderr
    assert not (tmp_path/'calls').exists()


# The comment shadow (commentsShadow) runs in the same service. The shadow's
# health is required when either shadow is selected, and its predicate is
# told, as its last argument, whether the comment observer must be built
# ("1") or must not be ("0").
def comment_arguments(tmp_path):
    path = tmp_path/'calls.comments'
    return path.read_text().splitlines() if path.exists() else []


@pytest.mark.parametrize("routes,probed,comments", [
    ("", False, None), ("pca2", False, None), ("version", False, None), ("pca2,version", False, None),
    ("pca2,comments", False, None), ("votesRead", False, None),
    ("votesShadow", True, "0"), ("pca2,votesShadow", True, "0"), (" pca2 votesShadow ", True, "0"),
    ("pca2,version,votesShadow", True, "0"), ("votesRead,votesShadow", True, "0"),
    ("commentsShadow", True, "1"), ("pca2,commentsShadow", True, "1"), (" pca2 commentsShadow ", True, "1"),
    ("pca2,comments,commentsShadow", True, "1"),
    ("pca2,votesShadow,commentsShadow", True, "1"), ("commentsShadow,votesShadow", True, "1"),
    ("pca2 votesShadow commentsShadow", True, "1"), ("pca2,commentsShadow,commentsShadow", True, "1"),
    ("commentsShadow,postVotes", True, "1"), ("votesShadow,postComments", True, "0"),
    ("commentsShadows", False, None), ("xcommentsShadow", False, None), ("commentsshadow", False, None),
    ("CommentsShadow", False, None), ("pca2,commentShadow", False, None),
])
def test_the_shadow_is_probed_for_either_shadow_and_told_which(tmp_path, routes, probed, comments):
    # A selected route also makes the main polis-api's health required, as before.
    named = bool(routes.replace(',', ' ').split())
    p = probe(tmp_path, routes=routes)
    assert p.returncode == 0, p.stderr
    expected = ['http'] + (['rust'] if named else []) + (['shadow'] if probed else [])
    assert (tmp_path/'calls').read_text().splitlines() == expected * 3
    assert p.stdout.count('polis-api-shadow health ok') == (3 if probed else 0)
    assert comment_arguments(tmp_path) == ([comments] * 3 if probed else [])


@pytest.mark.parametrize("routes", ["commentsShadow", "pca2,votesShadow,commentsShadow"])
@pytest.mark.parametrize("kw", [dict(shadow_http=1), dict(shadow_state='running true none'),
                                dict(shadow_state='exited false none')])
def test_comment_shadow_failure_rejects_validation(tmp_path, routes, kw):
    p = probe(tmp_path, routes=routes, **kw)
    assert p.returncode != 0
    assert 'polis-api-shadow health failed' in p.stderr
    assert 'ValidateService failed' in p.stderr


@pytest.mark.parametrize("routes", ["postComments,commentsShadow", "commentsShadow postComments",
                                    "pca2,votesShadow, postComments ,commentsShadow"])
def test_comment_shadow_with_a_live_comment_route_is_refused_before_polling(tmp_path, routes):
    p = probe(tmp_path, routes=routes)
    assert p.returncode != 0
    assert 'commentsShadow and postComments' in p.stderr
    assert not (tmp_path/'calls').exists()


def test_both_refusals_name_the_vote_pair_first(tmp_path):
    p = probe(tmp_path, routes='votesShadow,postVotes,commentsShadow,postComments')
    assert p.returncode != 0
    assert 'votesShadow and postVotes' in p.stderr
    assert not (tmp_path/'calls').exists()


# The read shadows (votesReadShadow, commentsReadShadow, nextCommentShadow) run
# in a service of their own, polis-api-shadow-reads. Selected, its health is
# required on every poll, after the write shadows' service's when that is
# selected too, and its predicate is told, as its last three arguments,
# which lanes must be built ("1") and which must not ("0").
def read_arguments(tmp_path):
    path = tmp_path/'calls.reads'
    return path.read_text().splitlines() if path.exists() else []


@pytest.mark.parametrize("routes,write,lanes", [
    ("votesReadShadow", False, "1 0 0"), ("commentsReadShadow", False, "0 1 0"), ("nextCommentShadow", False, "0 0 1"),
    (" pca2 nextCommentShadow ", False, "0 0 1"), ("votesReadShadow,votesReadShadow", False, "1 0 0"),
    ("votesReadShadow,commentsReadShadow,nextCommentShadow", False, "1 1 1"),
    ("pca2,votesShadow,commentsShadow,votesReadShadow,commentsReadShadow,nextCommentShadow", True, "1 1 1"),
    ("votesShadow,nextCommentShadow", True, "0 0 1"), ("postVotes,votesReadShadow", False, "1 0 0"),
    ("comments,votesReadShadow", False, "1 0 0"), ("votesRead,commentsReadShadow", False, "0 1 0"),
])
def test_the_read_shadow_is_probed_three_times_and_told_which_lanes(tmp_path, routes, write, lanes):
    p = probe(tmp_path, routes=routes)
    assert p.returncode == 0, p.stderr
    expected = ['http', 'rust'] + (['shadow'] if write else []) + ['reads']
    assert (tmp_path/'calls').read_text().splitlines() == expected * 3
    assert p.stdout.count('polis-api-shadow-reads health ok') == 3
    assert read_arguments(tmp_path) == [lanes] * 3


@pytest.mark.parametrize("routes", ["", "pca2", "votesShadow", "pca2,votesShadow,commentsShadow", "votesRead",
                                    "comments", "nextComment", "votesreadshadow", "VotesReadShadow",
                                    "nextCommentShadows", "readShadow", "commentReadShadow"])
def test_unselected_read_shadow_is_not_probed(tmp_path, routes):
    p = probe(tmp_path, start='1', routes=routes, reads_http=1)
    assert p.returncode == 0, p.stderr
    assert 'reads' not in (tmp_path/'calls').read_text().splitlines()
    assert read_arguments(tmp_path) == []


@pytest.mark.parametrize("routes", ["nextCommentShadow", "pca2,votesShadow,votesReadShadow"])
@pytest.mark.parametrize("kw", [dict(reads_http=1), dict(reads_state='running true none'),
                                dict(reads_state='exited false none')])
def test_read_shadow_failure_rejects_validation(tmp_path, routes, kw):
    p = probe(tmp_path, routes=routes, **kw)
    assert p.returncode != 0
    assert 'polis-api-shadow-reads health failed' in p.stderr
    assert 'ValidateService failed' in p.stderr


@pytest.mark.parametrize("routes,message", [
    ("votesRead,votesReadShadow", "votesReadShadow and votesRead"),
    ("comments commentsReadShadow", "commentsReadShadow and comments"),
    ("pca2, nextComment ,nextCommentShadow", "nextCommentShadow and nextComment"),
])
def test_read_shadow_with_its_read_route_is_refused_before_polling(tmp_path, routes, message):
    p = probe(tmp_path, routes=routes)
    assert p.returncode != 0
    assert f'{message} cannot be selected together' in p.stderr
    assert not (tmp_path/'calls').exists()
