#!/usr/bin/env python3
"""The driver of shadow-stack.sh: one series of comments through nginx to the
real Node server, with nothing selected and then with both shadows selected
while the shadow service is started without the comment observer's switch,
started with it, paused, stopped and started again. Node's replies are
compared byte for byte between the two runs.

Every comment carries a pass as its author's vote, and the two votes cast are
passes, all through Node's own routes; nothing here writes a vote or reads
one. The conversation and its owner are the only rows written directly.
"""
import http.client
import json
import os
import re
import shutil
import subprocess
import time

ROOT = os.environ['SHADOW_STACK_ROOT']
WORK = os.environ['SHADOW_STACK_WORK']
PROJECT = os.environ['SHADOW_STACK_PROJECT']
PORT = int(os.environ['SHADOW_STACK_PORT'])
IMAGES = {name: os.environ[f'SHADOW_STACK_{name}_IMAGE'] for name in ('API', 'SERVER', 'POSTGRES', 'NGINX')}
CONVERSATION = '2shadowstack'
BOTH = 'votesShadow,commentsShadow'
COMMENTS_PATH = '/api/v3/comments'
JSON_UTF8 = 'application/json; charset=UTF-8'  # the participation page's XMLHttpRequest
TOKEN = re.compile(r'[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}')
# The line the deploy hook writes into its Compose override for the shadow
# service when the route list names commentsShadow (scripts/after_install.sh).
HOOK_SWITCH = '    environment:\n      - POLIS_API_POST_COMMENTS=observe\n'


def compose(*args, routes='', check=True):
    command = ['docker', 'compose', '-p', PROJECT, '--env-file', f'{WORK}/stack.env',
               '-f', f'{ROOT}/docker-compose.yml', '-f', f'{WORK}/override.yml', '--profile', 'rust-api', *args]
    result = subprocess.run(command, env=dict(os.environ, RUST_API_ROUTES=routes), text=True,
                            capture_output=True)
    if check and result.returncode != 0:
        raise AssertionError(f'{" ".join(args)} failed: {result.stdout[-2000:]}{result.stderr[-2000:]}')
    return result


def write_override(comments):
    """Images for the services of docker-compose.yml, the shadow service's
    part exactly as the deploy hook writes it, a database and the one
    stand-in: the participation client nginx resolves when it starts."""
    with open(f'{WORK}/override.yml', 'w') as file:
        file.write('services:\n')
        for name, image in (('server', IMAGES['SERVER']), ('nginx-proxy', IMAGES['NGINX'])):
            file.write(f'  {name}:\n    image: {image}\n')
        file.write(f'  polis-api-shadow:\n    image: {IMAGES["API"]}\n' + (HOOK_SWITCH if comments else ''))
        file.write(f'''  stack-postgres:
    image: {IMAGES["POSTGRES"]}
    environment:
      POSTGRES_DB: polis-test
      POSTGRES_USER: postgres
      POSTGRES_PASSWORD: shadow-stack
    networks:
      polis-net:
        aliases: [postgres]
  stack-alpha:
    image: {IMAGES["NGINX"]}
    entrypoint: ["sh", "-c", "printf 'server {{ listen 4321; location / {{ return 200 alpha; }} }}' > /etc/nginx/conf.d/default.conf && exec nginx -g 'daemon off;'"]
    networks:
      polis-net:
        aliases: [client-participation-alpha]
''')


def hook_read_back(*more_files):
    """The deploy hook's two read-backs (scripts/after_install.sh), run with
    jq on what Compose composes from docker-compose.yml, the override and any
    further files: the comment observer's switch, and the names of the shadow
    service's own settings that are not what docker-compose.yml gives it."""
    assert shutil.which('jq'), 'this test runs the deploy hook\'s jq programs: jq must be installed'
    hook = open(f'{ROOT}/scripts/after_install.sh').read()
    (switch,) = re.findall(r"^  SHADOW_COMMENTS_SWITCH=\$\(.* \| jq -r '([^']*)'\)$", hook, re.M)
    (settings,) = re.findall(r"^  SHADOW_SETTINGS_WRONG=\$\(.* \| jq -r '([^']*)'\)$", hook, re.M)
    files = [argument for file in more_files for argument in ('-f', file)]
    composed = subprocess.run(
        ['docker', 'compose', '-p', PROJECT, '--env-file', f'{WORK}/stack.env', '-f', f'{ROOT}/docker-compose.yml',
         '-f', f'{WORK}/override.yml', *files, '--profile', 'rust-api', 'config', '--format', 'json'],
        env=dict(os.environ, RUST_API_ROUTES=BOTH), text=True, capture_output=True, check=True).stdout
    return tuple(subprocess.run(['jq', '-r', program], input=composed, text=True, capture_output=True,
                                check=True).stdout.rstrip('\n') for program in (switch, settings))


def check_read_back():
    """The hook's read-backs against the real Compose: both overrides the
    hook writes are accepted, and a composition in which the override's
    environment replaces the service's own list is caught by the second."""
    write_override(comments=False)
    assert hook_read_back() == ('', ''), hook_read_back()
    write_override(comments=True)
    assert hook_read_back() == ('observe', ''), hook_read_back()
    # The same one entry, replacing the service's list instead of joining it.
    with open(f'{WORK}/replaced.yml', 'w') as file:
        file.write('services:\n  polis-api-shadow:\n    environment: !override\n'
                   '      - POLIS_API_POST_COMMENTS=observe\n')
    switch, wrong = hook_read_back(f'{WORK}/replaced.yml')
    assert switch == 'observe', switch  # the switch's own check would pass
    assert wrong.split()[:3] == ['POLIS_API_ROLE', 'POLIS_API_SHADOW_LISTEN', 'POLIS_API_POST_VOTES'], wrong
    assert set(wrong.split()) <= {'POLIS_API_ROLE', 'POLIS_API_SHADOW_LISTEN', 'POLIS_API_POST_VOTES',
                                  'JWT_PRIVATE_KEY', 'JWT_PRIVATE_KEY_PATH'}, wrong
    write_override(comments=False)
    print(f'ok read-back: on what Compose composes, the deploy hook\'s read-backs accept the override it writes '
          f'without and with the comment switch; with the service\'s environment list replaced by that one '
          f'entry the switch still reads observe and the second read-back names {wrong}', flush=True)


def wait_for(check, label, seconds=90.0, pause=0.5):
    deadline = time.time() + seconds
    while True:
        try:
            value = check()
        except (OSError, http.client.HTTPException, AssertionError):
            value = None
        if value:
            return value
        if time.time() > deadline:
            raise AssertionError(f'not observed: {label}')
        time.sleep(pause)


def sql(statement):
    # Over TCP: it answers only once the image has applied the migrations.
    return compose('exec', '-T', '-e', 'PGPASSWORD=shadow-stack', 'stack-postgres', 'psql', '-h', '127.0.0.1',
                   '-U', 'postgres', '-d', 'polis-test', '-v', 'ON_ERROR_STOP=1', '-At', '-c', statement).stdout.strip()


def request(method, path, body=None, token=None, content_type=JSON_UTF8):
    headers = {}
    if body is not None:
        headers['Content-Type'] = content_type
    if token:
        headers['Authorization'] = 'Bearer ' + token
    connection = http.client.HTTPConnection('127.0.0.1', PORT, timeout=30)
    connection.request(method, path, body=body, headers=headers)
    response = connection.getresponse()
    payload = response.read()
    connection.close()
    kept = sorted([k.lower(), v] for k, v in response.getheaders() if k.lower() != 'date')
    return response.status, kept, payload.decode()


def start(routes):
    """A new database, the conversation, Node and nginx with this selection."""
    compose('down', '-v', '--remove-orphans')
    compose('up', '-d', '--no-deps', '--no-build', 'stack-postgres', 'stack-alpha')
    wait_for(lambda: sql('select count(*) from conversations') == '0', 'the migrated database')
    sql("insert into users(uid,hname,email,is_owner,site_id,created) values "
        "(1000,'Owner','owner@example.invalid',true,'site1000',1700000000000); "
        "with made as (insert into conversations(owner,topic,is_active,is_draft,is_public,profanity_filter,"
        "spam_filter,treevite_enabled) values (1000,'Shadow stack',true,false,true,false,false,false) "
        f"returning zid) insert into zinvites(zid,zinvite,created) select zid,'{CONVERSATION}',1700000000000 from made")
    compose('up', '-d', '--no-deps', '--no-build', 'server', routes=routes)
    compose('up', '-d', '--no-deps', '--no-build', '--force-recreate', 'nginx-proxy', routes=routes)
    wait_for(lambda: request('GET', '/api/v3/testConnection')[0] == 200, 'Node behind nginx')
    rendered = compose('exec', '-T', 'nginx-proxy', 'cat', '/etc/nginx/rust-api/locations.conf').stdout
    for name in filter(None, routes.split(',')):
        assert f'location @polis_shadow_{name} ' in rendered, f'{name} was not rendered'
    assert bool(routes) == bool(rendered.strip()), 'the selection and the rendered locations disagree'


def shadow(state, routes=BOTH):
    """Puts the shadow service in a state: `plain` (as docker-compose.yml
    alone starts it), `observing` (with the hook's line), `paused`, `stopped`."""
    if state in ('plain', 'observing'):
        write_override(comments=state == 'observing')
        compose('up', '-d', '--no-deps', '--no-build', '--force-recreate', 'polis-api-shadow', routes=routes)
        wait_for(lambda: health()['status'] == 'ok', f'the shadow service, {state}')
    elif state == 'paused':
        compose('pause', 'polis-api-shadow')
    elif state == 'resumed':
        compose('unpause', 'polis-api-shadow')
    elif state == 'stopped':
        compose('stop', '-t', '2', 'polis-api-shadow')
    else:
        raise ValueError(state)


def from_server(script, *arguments):
    """Runs JavaScript in the Node server's container, where the deploy's
    validation runs its checks."""
    return compose('exec', '-T', 'server', 'node', '-e', script, *arguments, check=False)


def health():
    result = from_server('fetch("http://polis-api-shadow:5101/health",{signal:AbortSignal.timeout(4000)})'
                         '.then(r=>r.text()).then(t=>process.stdout.write(t)).catch(()=>process.exit(1))')
    assert result.returncode == 0, 'the shadow service did not answer /health'
    return json.loads(result.stdout)


def validates(comments_selected):
    """scripts/validate_service.sh's own predicate for the shadow service,
    run as the hook runs it, with what it is told about commentsShadow. The
    release's commit and version, which the hook takes from the deployment,
    are taken here from the image under test: its identity is not what this
    checks."""
    source = open(f'{ROOT}/scripts/validate_service.sh').read()
    script = source.split('shadow_ready() {')[1].split("compose exec -T server node -e '")[1].split("\n    ' \"$(sed")[0]
    identity = health()
    assert identity['commit'] and identity['version'], identity
    refused = from_server(script, 'another commit', identity['version'], '1' if comments_selected else '0')
    assert refused.returncode == 1, 'the predicate accepted another release\'s commit'
    return from_server(script, identity['commit'], identity['version'],
                       '1' if comments_selected else '0').returncode == 0


def logged(service, prefix):
    lines = []
    for line in compose('logs', '--no-log-prefix', '--no-color', service).stdout.splitlines():
        if line.startswith(prefix):
            try:
                lines.append(json.loads(line))
            except ValueError:
                pass
    return lines


def comment_body(text, vote=True, **extra):
    body = {'txt': text, 'pid': 'mypid', 'conversation_id': CONVERSATION, 'agid': 1, **extra}
    if vote:
        body['vote'] = 0
    return json.dumps(body)


def series(shadow_states):
    """The fixed series. `shadow_states` is called with a label before each
    group of requests; the run with nothing selected passes a function that
    does nothing. Returns the transcript: every reply, in order."""
    transcript = []

    def post(label, text, token=None, vote=True, content_type=JSON_UTF8, path=COMMENTS_PATH, body=None, pace=0.6):
        # Paced inside the comment copies' rate, except the run of twelve.
        time.sleep(pace)
        started = time.perf_counter()
        status, headers, payload = request('POST', path, body or comment_body(text, vote), token, content_type)
        if path == COMMENTS_PATH and status == 200:
            TIMES.setdefault(id(transcript), []).append((time.perf_counter() - started) * 1000)
        transcript.append([label, status, headers, payload])
        return status, payload

    shadow_states('before the switch')
    status, payload = post('a first comment, without a token', 'The first comment of the series.')
    assert status == 200, (status, payload)
    token = json.loads(payload)['auth']['token']
    shadow_states('observing')
    assert post('a comment', 'Meetings should be open to everyone.', token)[0] == 200
    assert post('a comment in another script', '会議は誰にでも開かれているべきだ。', token)[0] == 200
    assert post('a comment without a vote', 'A comment sent as the command line sends it.', token, vote=False,
                content_type='application/json')[0] == 200
    assert post('the same text again', 'Meetings should be open to everyone.', token)[0] == 409
    assert post('an empty text', '', token)[0] == 400
    assert post('the longest text', 'x' * 997, token)[0] == 200
    assert post('one unit too long', 'y' * 998, token)[0] == 400
    for index in range(2):
        status, _ = post('a vote', None, token, path='/api/v3/votes',
                         body=json.dumps({'conversation_id': CONVERSATION, 'tid': index, 'vote': 0, 'agid': 1}))
        assert status == 200, status
    shadow_states('paused')
    assert post('a comment while the shadow service is paused', 'Paused, and still heard.', token)[0] == 200
    assert post('a repeat while it is paused', 'Paused, and still heard.', token)[0] == 409
    shadow_states('stopped')
    assert post('a comment while the shadow service is stopped', 'Stopped, and still heard.', token)[0] == 200
    shadow_states('observing again')
    for index in range(12):
        assert post(f'comment {index + 1} of a run of twelve', f'One of twelve in a run, number {index + 1}.', token,
                    pace=0)[0] == 200
    # A comment and a vote posted with a query string. Node's two routes read
    # their parameters from the body alone: with the conversation in the body
    # too, Node answers as if the query string were not there; with it only
    # in the query string, Node refuses the request (400).
    shadow_states('a query string')
    query = f'?conversation_id={CONVERSATION}'
    queried = post('a comment with a query string', 'Posted with a query string.', token,
                   path=COMMENTS_PATH + query)
    assert queried[0] == 200, queried
    queried = post('a comment whose conversation is only in the query string', None, token,
                   path=COMMENTS_PATH + query,
                   body=json.dumps({'txt': 'The conversation is only in the query string.', 'pid': 'mypid',
                                    'agid': 1, 'vote': 0}))
    assert queried[0] == 400, queried
    queried = post('a vote with a query string', None, token, path='/api/v3/votes' + query,
                   body=json.dumps({'conversation_id': CONVERSATION, 'tid': 2, 'vote': 0, 'agid': 1}))
    assert queried[0] == 200, queried
    queried = post('a vote whose conversation is only in the query string', None, token,
                   path='/api/v3/votes' + query, body=json.dumps({'tid': 3, 'vote': 0, 'agid': 1}))
    assert queried[0] == 400, queried
    read = request('GET', f'{COMMENTS_PATH}?conversation_id={CONVERSATION}')
    transcript.append(['the comment list', read[0], [h for h in read[1] if h[0] != 'etag'], '<compared with Node directly>'])
    return transcript, token, read


# How long each stored comment took its client, by run (milliseconds).
TIMES = {}


def comparable(transcript):
    """A transcript without what differs between two runs by design: the
    token Node issues with the first reply (and that reply's length and
    validator, which follow from it), and the next comment a vote's reply
    draws at random."""
    out = []
    for label, status, headers, payload in transcript:
        if label.startswith('a vote'):
            out.append([label, status])
        elif 'without a token' in label:
            out.append([label, status, TOKEN.sub('<token>', payload),
                        [h for h in headers if h[0] not in ('content-length', 'etag')]])
        else:
            out.append([label, status, headers, payload])
    return out


def main():
    check_read_back()
    write_override(comments=False)
    # Nothing selected: what Node answers.
    start('')
    control, _, _ = series(lambda label: None)
    print(f'ok control: {len(control)} requests through nginx to Node with nothing selected', flush=True)

    # Both shadows selected, on a new database, with the shadow service
    # changing state under the same series.
    start(BOTH)
    seen = {}

    def states(label):
        if label == 'before the switch':
            # The service as docker-compose.yml alone starts it: the vote
            # shadow as it runs today, though nginx already copies comments.
            shadow('plain')
            seen['plain health'] = health()
            seen['plain validates'] = (validates(False), validates(True))
        elif label == 'observing':
            seen['plain mirrors'] = logged('nginx-proxy', '{"message":"shadow_mirror"')
            seen['plain observations'] = logged('polis-api-shadow', '{"message":"shadow_observation"')
            shadow('observing')
            seen['observing health'] = health()
            seen['observing validates'] = (validates(True), validates(False))
        elif label == 'paused':
            time.sleep(13)  # every read-back of the group before has printed its line
            seen['observations'] = logged('polis-api-shadow', '{"message":"shadow_observation"')
            seen['connections'] = sql("select application_name, count(*) from pg_stat_activity where "
                                      "application_name like 'polis-api%' group by 1 order by 1")
            seen['working health'] = health()
            shadow('paused')
        elif label == 'stopped':
            shadow('resumed')
            shadow('stopped')
        elif label == 'observing again':
            shadow('observing')
            time.sleep(3)  # an empty bucket for the run of twelve
        elif label == 'a query string':
            time.sleep(3)  # the run of twelve has drained from the bucket

    shadowed, token, read = series(states)
    assert comparable(shadowed) == comparable(control), 'a reply differs with the shadows selected'
    without, with_shadows = sorted(TIMES[id(control)]), sorted(TIMES[id(shadowed)])
    print(f'info the client\'s time for a stored comment on the real Node server: median '
          f'{without[len(without) // 2]:.1f} ms with nothing selected, {with_shadows[len(with_shadows) // 2]:.1f} ms '
          f'with both shadows (n={len(without)} and {len(with_shadows)}; max {without[-1]:.1f} and '
          f'{with_shadows[-1]:.1f} ms)', flush=True)
    print(f'ok replies: all {len(shadowed)} replies are the same status, headers and bytes with both shadows '
          f'selected as with nothing selected, while the shadow service was started without the comment '
          f'switch, started with it, paused, stopped and started again (the first reply\'s token and the '
          f'next comment a vote\'s reply draws apart)', flush=True)

    # GET on the comment path: nginx's answer is Node's own bytes.
    direct = from_server('fetch("http://127.0.0.1:5000' + f'{COMMENTS_PATH}?conversation_id={CONVERSATION}' +
                         '").then(r=>r.text()).then(t=>process.stdout.write(t))')
    assert direct.returncode == 0 and read[0] == 200 and read[2] == direct.stdout, 'the comment list differs'
    assert len(json.loads(read[2])) == 20, len(json.loads(read[2]))
    print('ok reads: GET on the comment path through nginx is byte for byte what Node answers directly '
          '(20 comments)', flush=True)

    # Without the switch: exactly the vote shadow's service.
    plain = seen['plain health']
    assert 'postComments' not in plain and plain['postVotes']['mode'] == 'observe' and plain['role'] == 'shadow', plain
    assert sorted(plain) == ['commit', 'postVotes', 'role', 'shadow', 'status', 'version'], sorted(plain)
    assert seen['plain validates'] == (True, False), seen['plain validates']
    (unserved,) = [m for m in seen['plain mirrors'] if m['shadow'] == 'commentsShadow']
    assert unserved['mirror_status'] == 404 and unserved['mirror_upstream_status'] == '404', unserved
    assert not seen['plain observations'], seen['plain observations']
    print('ok without the switch: the shadow service starts as docker-compose.yml defines it, /health has the '
          'vote shadow\'s six keys and no postComments, the deploy\'s predicate accepts it for a route list '
          'without commentsShadow and refuses it for one with; the comment copy nginx sent was answered 404 '
          'and nothing was observed', flush=True)

    # With the hook's line: the comment observer, as the predicate requires it.
    observing = seen['observing health']['postComments']
    assert observing['enabled'] is False and observing['mode'] == 'observe', observing
    assert sorted(observing['pools']) == ['readback', 'reads'], observing['pools']
    assert all(pool['readOnly'] and pool['reachable'] for pool in observing['pools'].values()), observing['pools']
    assert (observing['capacity'], observing['readbackCapacity'], observing['maxPerSecond']) == (8, 64, 5), observing
    assert seen['observing validates'] == (True, False), seen['observing validates']
    print('ok with the switch: /health gains postComments (observe, never enabled, pools readback and reads, '
          'read-only and reachable, room for 8 and 64, 5 a second); the deploy\'s predicate accepts it with '
          'commentsShadow and refuses it without', flush=True)

    # Every copy nginx sent, by its state.
    time.sleep(13)
    mirrors = [m for m in logged('nginx-proxy', '{"message":"shadow_mirror"') if m['shadow'] == 'commentsShadow']
    edges = [e for e in logged('nginx-proxy', '{"message":"shadow_edge"') if e['route'] == f'POST {COMMENTS_PATH}']
    assert len(edges) == len(mirrors) == 25, (len(edges), len(mirrors))
    by_id = {m['request_id']: m for m in mirrors}
    statuses = [by_id[e['request_id']]['mirror_status'] for e in edges]
    assert statuses[0] == 404, statuses
    assert statuses[1:8] == [204] * 7, statuses
    # Paused: the copy's read times out. Stopped: the name no longer
    # resolves (502), or nginx still holds its address for a few seconds and
    # the connection times out (504).
    assert statuses[8:10] == [504, 504] and statuses[10] in (502, 504), statuses
    run = statuses[11:23]
    passed = run.count(204)
    assert set(run) <= {204, 429} and 5 <= passed <= 8 and run[:5] == [204] * 5, run
    assert [e['edge_status'] for e in edges] == [entry[1] for entry in shadowed
                                                  if not entry[0].startswith(('a vote', 'the comment list'))]
    # Node received nginx's id on a shadowed request: its reply line for each
    # vote its handler answered carries the id nginx logged. (This stack runs Node in
    # development mode, in which Node writes no access line, and Node has no
    # reply line for a comment, so a comment's id is not on a Node line here.)
    vote_ids = {e['request_id'] for e in logged('nginx-proxy', '{"message":"shadow_edge"')
                if e['route'] == 'POST /api/v3/votes'}
    node_log = compose('logs', '--no-log-prefix', '--no-color', 'server').stdout
    replied = set(re.findall(r'"request_id":"([0-9a-f]{32})"', '\n'.join(
        line for line in node_log.splitlines() if 'vote_reply' in line)))
    # (The vote Node refused for its missing conversation never reached the
    # handler that writes that line.)
    refused_votes = {e['request_id'] for e in logged('nginx-proxy', '{"message":"shadow_edge"')
                     if e['route'] == 'POST /api/v3/votes' and e['edge_status'] == 400}
    assert len(vote_ids) == 4 and len(refused_votes) == 1 and vote_ids - refused_votes == replied, (vote_ids, replied)
    # The observer printed one line for each copy it was sent while observing.
    first = {o['request_id']: o for o in seen['observations'] if o['shadow'] == 'commentsShadow'}
    ids = [e['request_id'] for e in edges]
    assert set(first) == set(ids[1:8]), (len(first), ids[1:8])
    outcomes = [(first[i]['outcome'], first[i]['status'], first[i]['reason']) for i in ids[1:8]]
    served = first[ids[1]]
    assert (served['outcome'], served['status'], served['node_comment'], served['node_txt'], served['node_author'],
            served['node_row'], served['node_lang'], served['node_vote']) == (
                'would_serve', 200, 'own', 'same', 'same', 'as_expected', 'unset', 'same'), served
    assert first[ids[3]]['node_vote'] == 'not_sent' and first[ids[3]]['outcome'] == 'would_serve', first[ids[3]]
    assert (first[ids[5]]['outcome'], first[ids[5]]['reason']) == ('would_hand_back', 'txt_empty'), first[ids[5]]
    assert first[ids[6]]['outcome'] == 'would_serve' and first[ids[7]]['outcome'] == 'would_hand_back', outcomes
    later = {o['request_id']: o for o in logged('polis-api-shadow', '{"message":"shadow_observation"')
             if o['shadow'] == 'commentsShadow'}
    # The copies of the two comments posted with a query string carried it,
    # as the request a write route would be handed carries it, so the
    # observer says what the handler does with such a request: it hands it
    # back because of the query string, whatever Node answered. And the two
    # votes' copies, the same.
    assert statuses[23:] == [204, 204], statuses
    assert [e['edge_status'] for e in edges[23:]] == [200, 400], edges[23:]
    for request_id in ids[23:]:
        queried = later.pop(request_id)
        assert (queried['outcome'], queried['reason']) == ('would_hand_back', 'shape_query'), queried
    queried_votes = [o for o in logged('polis-api-shadow', '{"message":"shadow_observation"')
                     if o['shadow'] == 'votesShadow' and o['reason'] == 'shape_query']
    assert len(queried_votes) == 2 and all(o['outcome'] == 'would_hand_back' for o in queried_votes), queried_votes
    queried_ids = {o['request_id'] for o in queried_votes}
    assert queried_ids <= vote_ids and len(queried_ids & refused_votes) == 1, (queried_ids, vote_ids, refused_votes)
    print('ok query strings: a comment and a vote posted with a query string and the conversation in the body '
          'were answered 200 by Node, and one of each with the conversation only in the query string 400 (Node '
          'reads these routes\' parameters from the body alone); each of the four copies reached the shadow '
          'service with the query string and was observed as would_hand_back for the reason shape_query',
          flush=True)
    assert set(later) == {i for i, status in zip(ids[11:23], run) if status == 204}, (len(later), passed)
    assert all(o['outcome'] == 'would_serve' and o['node_comment'] == 'own' for o in later.values()), later
    final = health()['postComments']
    assert final['shed'] == 0 and final['observed'] == passed + 2, final
    print(f'ok copies: of the first 23 comments, the copy sent before the switch was answered 404; 7 were observed '
          f'(outcomes {outcomes}); 2 timed out against the paused service (504) and 1 failed against the '
          f'stopped one ({statuses[10]}); of the run of twelve {passed} were sent and observed (would_serve, Node\'s own '
          f'row read back) and {12 - passed} ended with 429 in nginx; the observer shed none; Node\'s reply line '
          f'for each of the {len(replied)} votes it answered carries the id nginx logged', flush=True)

    # Connections the shadow service held with both observers at work.
    connections = dict(row.split('|') for row in seen['connections'].splitlines())
    total = sum(int(count) for count in connections.values())
    assert seen['working health']['postVotes']['observed'] == 2, seen['working health']['postVotes']
    assert total <= 7, connections
    print(f'ok connections: with both observers at work the shadow service held {total} database connections '
          f'({connections}); at most 7', flush=True)


if __name__ == '__main__':
    main()
