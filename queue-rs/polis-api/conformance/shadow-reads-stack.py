#!/usr/bin/env python3
"""The read shadow under shadow-stack.sh: polis-api-shadow-reads as
docker-compose.yml defines it, with the override the web deploy writes
(scripts/after_install.sh), behind the production nginx image, beside the
real Node server, the write shadows' service and PostgreSQL built from the
migrations.

  - The deploy hook's read-backs, run with jq on what Compose composes: the
    override it writes for each read selector is accepted; a composition
    whose service environment was replaced is not; and an env document that
    sets every read switch, the vote, identity and comment observers' switches
    and a signing key changes nothing the hook reads back, for either shadow
    service.
  - One fixed series of reads (the vote list, the comment list, the next
    comment; anonymous, with a participant token, with a cookie, with the
    language) through nginx with nothing selected, then with every shadow
    selected while the read shadow service is started without its lane
    switches, with them, paused, stopped and started again. Every reply is
    Node's: the same status in both runs, and the same bytes as Node answers
    the same request directly, at that moment.
  - Against the real /health: without the switches the service has no lane
    and the deploy's predicate refuses it; with them the predicate accepts
    exactly the named lanes; the write shadows' service holds no read lane.
  - Each copy nginx sent while the lanes were built is observed once, under
    the request id nginx logged, by the read shadow service and by nothing
    else; and how many database connections the read lanes hold.
"""
import importlib.util
import json
import os
import re
import shutil
import subprocess
import time
import http.client

HERE = os.path.dirname(os.path.abspath(__file__))
spec = importlib.util.spec_from_file_location('stack', os.path.join(HERE, 'shadow-stack.py'))
stack = importlib.util.module_from_spec(spec)
spec.loader.exec_module(stack)

ROOT, WORK, PROJECT, PORT, IMAGES = stack.ROOT, stack.WORK, stack.PROJECT, stack.PORT, stack.IMAGES
CONVERSATION = stack.CONVERSATION
READS = {'votesReadShadow': ('POLIS_API_VOTES_READS', '/api/v3/votes', 'getVotes'),
         'commentsReadShadow': ('POLIS_API_COMMENT_READS', '/api/v3/comments', 'getComments'),
         'nextCommentShadow': ('POLIS_API_NEXT_COMMENT_READS', '/api/v3/nextComment', 'getNextComment')}
EVERY = 'votesShadow,commentsShadow,' + ','.join(READS)
# nginx sends at most 4 copies a second of each read, one a quarter second.
SPACING = 0.3


def write_override(lanes=(), comments=True):
    """The images, the write shadows' service and the read shadow service
    exactly as the deploy hook writes them for these lane selectors (none:
    the read shadow service as docker-compose.yml alone starts it), a
    database and the participation client nginx resolves."""
    stack.write_override(comments)
    with open(f'{WORK}/override.yml', 'a') as file:
        file.write(f'  polis-api-shadow-reads:\n    image: {IMAGES["API"]}\n')
        if lanes:
            file.write('    environment:\n')
            for name in READS:
                if name in lanes:
                    file.write(f'      - {READS[name][0]}=observe\n')


def program(name):
    hook = open(f'{ROOT}/scripts/after_install.sh').read()
    (found,) = re.findall(rf"^  {name}=\$\(.* \| jq -r (?:--arg \S+ \S+ )*'([^']*)'\)$", hook, re.M)
    return found


def composed(*more_files, env_file=None):
    files = [argument for file in more_files for argument in ('-f', file)]
    return subprocess.run(
        ['docker', 'compose', '-p', PROJECT, '--env-file', env_file or f'{WORK}/stack.env', '-f',
         f'{ROOT}/docker-compose.yml', '-f', f'{WORK}/override.yml', *files, '--profile', 'rust-api', 'config',
         '--format', 'json'], env=dict(os.environ, RUST_API_ROUTES=EVERY), text=True, capture_output=True,
        check=True).stdout


def jq(text, name, *arguments):
    return subprocess.run(['jq', '-r', *arguments, program(name)], input=text, text=True, capture_output=True,
                          check=True).stdout.rstrip('\n')


def flags(lanes):
    return [a for name, flag in zip(READS, ('votes', 'comments', 'next'))
            for a in ('--arg', flag, '1' if name in lanes else '0')]


def check_read_back():
    assert shutil.which('jq'), 'this test runs the deploy hook\'s jq programs: jq must be installed'
    choices = [('votesReadShadow',), ('commentsReadShadow',), ('nextCommentShadow',), tuple(READS)]
    for lanes in choices:
        write_override(lanes)
        text = composed()
        assert jq(text, 'READS_SHADOW_SWITCHES_WRONG', *flags(lanes)) == '', lanes
        assert jq(text, 'READS_SHADOW_SETTINGS_WRONG') == '', lanes
        assert jq(text, 'SHADOW_SETTINGS_WRONG') == '', lanes
        for other in choices:
            if other != lanes:
                assert jq(text, 'READS_SHADOW_SWITCHES_WRONG', *flags(other)) != '', (lanes, other)
    # The env document cannot turn a lane on or an observer into the read
    # shadow service, nor a lane into the write shadows' service.
    with open(f'{WORK}/stack.env') as file:
        env = file.read()
    # The services read the document SERVER_ENV_FILE names: this one.
    env = '\n'.join(line for line in env.splitlines() if not line.startswith('SERVER_ENV_FILE='))
    with open(f'{WORK}/hostile.env', 'w') as file:
        file.write(env + f'\nSERVER_ENV_FILE={WORK}/hostile.env' + ''.join(f'\n{switch}=observe' for switch, _, _ in READS.values()) +
                   '\nPOLIS_API_POST_VOTES=1\nPOLIS_API_POST_VOTES_IDENTITY=observe\nPOLIS_API_POST_COMMENTS=observe'
                   '\nPOLIS_API_PARTICIPANT_READS=1\nJWT_PRIVATE_KEY_PATH=/run/not-printed\n')
    write_override(('commentsReadShadow',))
    text = composed(env_file=f'{WORK}/hostile.env')
    assert jq(text, 'READS_SHADOW_SWITCHES_WRONG', *flags(('commentsReadShadow',))) == ''
    assert jq(text, 'READS_SHADOW_SETTINGS_WRONG') == ''
    assert jq(text, 'SHADOW_SETTINGS_WRONG') == ''
    services = json.loads(text)['services']
    for switch, _, _ in READS.values():
        assert services['polis-api-shadow']['environment'][switch] == '', switch
    # The read shadow service's own list replaced by the override's entries.
    with open(f'{WORK}/replaced.yml', 'w') as file:
        file.write('services:\n  polis-api-shadow-reads:\n    environment: !override\n'
                   '      - POLIS_API_COMMENT_READS=observe\n')
    text = composed(f'{WORK}/replaced.yml', env_file=f'{WORK}/hostile.env')
    switches = jq(text, 'READS_SHADOW_SWITCHES_WRONG', *flags(('commentsReadShadow',)))
    wrong = jq(text, 'READS_SHADOW_SETTINGS_WRONG')
    assert switches != '', switches  # the env document's switches now reach the service
    for name in ('POLIS_API_ROLE', 'POLIS_API_SHADOW_LISTEN', 'POLIS_API_POST_VOTES', 'POLIS_API_POST_COMMENTS',
                 'POLIS_API_PARTICIPANT_READS', 'JWT_PRIVATE_KEY_PATH'):
        assert name in wrong.split(), (name, wrong)
    assert 'not-printed' not in wrong + switches
    print(f'ok read-back: on what Compose composes, the deploy hook\'s read-backs accept the override it writes for '
          f'each read selector and all three, and refuse the others\' switches; an env document that sets every '
          f'read switch, the observers\' switches and a signing key changes nothing either shadow service is '
          f'composed with; with the read shadow service\'s list replaced the read-backs name {wrong}', flush=True)


def get(path, headers=None):
    connection = http.client.HTTPConnection('127.0.0.1', PORT, timeout=30)
    started = time.perf_counter()
    connection.request('GET', path, headers=headers or {})
    response = connection.getresponse()
    payload = response.read()
    took = (time.perf_counter() - started) * 1000
    connection.close()
    # The length follows the bytes, which are compared with Node's own below.
    kept = sorted([k.lower(), v] for k, v in response.getheaders()
                  if k.lower() not in ('date', 'etag', 'content-length'))
    return response.status, kept, payload.decode(), took


def direct(path, headers):
    """The same request, sent to Node directly from its own container."""
    script = ('fetch("http://127.0.0.1:5000" + process.argv[1], {headers: JSON.parse(process.argv[2])})'
              '.then(async r => process.stdout.write(JSON.stringify([r.status, await r.text()])))'
              '.catch(() => process.exit(1))')
    result = stack.from_server(script, path, json.dumps(headers))
    assert result.returncode == 0, result.stderr
    return json.loads(result.stdout)


def drawn(text):
    """A next comment's reply without the random value of its draw."""
    try:
        value = json.loads(text)
    except ValueError:
        return text
    if isinstance(value, dict):
        value.pop('randomN', None)
    return value


def series(states, token):
    """The fixed series of reads. `states` is called with a label before
    each group. Returns the transcript: every reply's label, status, headers
    and whether it was Node's own bytes."""
    transcript = []
    auth = {'Authorization': 'Bearer ' + token}
    reads = [
        ('the vote list, anonymous', f'/api/v3/votes?conversation_id={CONVERSATION}&pid=0', {}),
        ('the vote list, with a token', f'/api/v3/votes?conversation_id={CONVERSATION}', auth),
        ('the comment list', f'/api/v3/comments?conversation_id={CONVERSATION}', {}),
        ('the comment list, with a cookie', f'/api/v3/comments?conversation_id={CONVERSATION}',
         {'Cookie': 'token2=not-printed'}),
        ('the moderation list, anonymous', f'/api/v3/comments?conversation_id={CONVERSATION}&moderation=true'
         '&include_voting_patterns=true', {}),
        ('the next comment, anonymous', f'/api/v3/nextComment?conversation_id={CONVERSATION}', {}),
        ('the next comment, with a token', f'/api/v3/nextComment?conversation_id={CONVERSATION}', auth),
        ('the next comment, with the language', f'/api/v3/nextComment?conversation_id={CONVERSATION}&lang=en', {}),
    ]
    for group in ('before the switches', 'observing', 'paused', 'stopped', 'observing again'):
        states(group)
        for label, path, headers in reads:
            time.sleep(SPACING)
            status, kept, payload, took = get(path, headers)
            node = direct(path, headers)
            same = (status == node[0] and (drawn(payload) == drawn(node[1]) if 'nextComment' in path
                                           else payload == node[1]))
            TIMES.setdefault(id(transcript), []).append(took)
            transcript.append([f'{label} ({group})', status, kept, same])
    return transcript


TIMES = {}


def health(service, port):
    result = stack.from_server(f'fetch("http://{service}:{port}/health",{{signal:AbortSignal.timeout(4000)}})'
                               '.then(r=>r.text()).then(t=>process.stdout.write(t)).catch(()=>process.exit(1))')
    assert result.returncode == 0, f'{service} did not answer /health'
    return json.loads(result.stdout)


def predicate(name):
    source = open(f'{ROOT}/scripts/validate_service.sh').read()
    return source.split(f'{name}() {{')[1].split("compose exec -T server node -e '")[1].split("\n    ' \"$(sed")[0]


def read_validates(named):
    identity = health('polis-api-shadow-reads', 5102)
    script = predicate('read_lanes_ready')
    flags = ['1' if name in named else '0' for name in READS]
    refused = stack.from_server(script, 'another commit', identity['version'], *flags)
    assert refused.returncode == 1, 'the predicate accepted another release\'s commit'
    return stack.from_server(script, identity['commit'], identity['version'], *flags).returncode == 0


def write_validates():
    identity = health('polis-api-shadow', 5101)
    return stack.from_server(predicate('shadow_ready'), identity['commit'], identity['version'], '1').returncode == 0


def reads_service(state, lanes=tuple(READS)):
    if state in ('plain', 'observing'):
        write_override(lanes if state == 'observing' else ())
        stack.compose('up', '-d', '--no-deps', '--no-build', '--force-recreate', 'polis-api-shadow-reads', routes=EVERY)
        stack.wait_for(lambda: health('polis-api-shadow-reads', 5102)['status'] == 'ok', f'the read shadow, {state}')
    elif state == 'paused':
        stack.compose('pause', 'polis-api-shadow-reads')
    elif state == 'resumed':
        stack.compose('unpause', 'polis-api-shadow-reads')
    elif state == 'stopped':
        stack.compose('stop', '-t', '2', 'polis-api-shadow-reads')


def token_and_data():
    """A participant, through Node's own routes: one comment, with its
    author's pass, so the lists have a row and the participant a vote. One
    comment, so that an anonymous next comment has one candidate and Node
    draws the same one for the request through nginx and for the same request
    sent to it directly (the draw's random value apart)."""
    status, _, payload = stack.request('POST', '/api/v3/comments', stack.comment_body('The first read.'))
    assert status == 200, (status, payload)
    return json.loads(payload)['auth']['token']


def main():
    check_read_back()
    write_override()
    stack.start('')
    token = token_and_data()
    control = series(lambda label: None, token)
    assert all(same for *_, same in control), [entry for entry in control if not entry[3]]
    print(f'ok control: {len(control)} reads through nginx to Node with nothing selected, each Node\'s own bytes',
          flush=True)

    write_override()
    stack.start(EVERY)
    stack.shadow('observing', routes=EVERY)
    token = token_and_data()
    seen = {}

    def states(label):
        if label == 'before the switches':
            reads_service('plain')
            seen['plain'] = health('polis-api-shadow-reads', 5102)
            seen['plain validates'] = (read_validates(()), read_validates(tuple(READS)))
        elif label == 'observing':
            seen['plain mirrors'] = stack.logged('nginx-proxy', '{"message":"shadow_mirror"')
            reads_service('observing')
            seen['observing'] = health('polis-api-shadow-reads', 5102)
            seen['observing validates'] = {lanes: read_validates(lanes) for lanes in
                                           (tuple(READS), ('votesReadShadow',), ())}
            seen['write validates'] = write_validates()
            seen['write health'] = health('polis-api-shadow', 5101)
        elif label == 'paused':
            time.sleep(1)
            seen['observations'] = stack.logged('polis-api-shadow-reads', '{"message":"shadow_observation"')
            seen['connections'] = stack.sql(
                "select application_name, count(*) from pg_stat_activity where application_name in "
                "('polis-api-votes-read/1','polis-api-votes-read-auth/1','polis-api-comments/1',"
                "'polis-api-comment-count/1','polis-api-next-comment/1') group by 1 order by 1")
            seen['working'] = health('polis-api-shadow-reads', 5102)
            reads_service('paused')
        elif label == 'stopped':
            reads_service('resumed')
            reads_service('stopped')
        elif label == 'observing again':
            reads_service('observing')

    shadowed = series(states, token)
    assert [[label, status, kept] for label, status, kept, _ in shadowed] == \
        [[label, status, kept] for label, status, kept, _ in control], 'a read\'s status or headers differ'
    assert all(same for *_, same in shadowed), [entry for entry in shadowed if not entry[3]]
    without, with_shadows = sorted(TIMES[id(control)]), sorted(TIMES[id(shadowed)])
    print(f'ok replies: all {len(shadowed)} reads answered with the same status and headers as with nothing '
          f'selected, and each was Node\'s own bytes for the same request, while the read shadow service was '
          f'started without its lane switches, with them, paused, stopped and started again (the next comment\'s '
          f'random value apart); the client\'s median {without[len(without) // 2]:.1f} ms with nothing selected, '
          f'{with_shadows[len(with_shadows) // 2]:.1f} ms with every shadow', flush=True)

    plain = seen['plain']
    assert not any(key in plain for _, _, key in READS.values()), sorted(plain)
    assert plain['postVotes']['mode'] == 'off' and 'postComments' not in plain, plain
    assert seen['plain validates'] == (False, False), seen['plain validates']
    plain_copies = [m for m in seen['plain mirrors'] if m['shadow'] in READS]
    assert plain_copies and all(m['mirror_status'] == 404 for m in plain_copies), plain_copies
    print(f'ok without the switches: the read shadow service starts as docker-compose.yml defines it, with no lane '
          f'and no observer; the deploy\'s predicate refuses it; the {len(plain_copies)} read copies nginx sent were '
          f'answered 404', flush=True)

    observing = seen['observing']
    for name, (_, _, key) in READS.items():
        lane = observing[key]
        assert lane['mode'] == 'observe' and lane['enabled'] is False and lane['selector'] == name, lane
        assert all(pool['readOnly'] and pool['reachable'] for pool in lane['pools'].values()), lane
    assert observing['postVotes']['mode'] == 'off' and not observing['postVotes']['pools'], observing['postVotes']
    assert seen['observing validates'] == {tuple(READS): True, ('votesReadShadow',): False, (): False}
    assert seen['write validates'] and not any(key in seen['write health'] for _, _, key in READS.values())
    print('ok with the switches: /health has the three lanes in observe mode, never enabled, their pools read-only '
          'and reachable, and no observer; the deploy\'s predicate accepts it for the three selectors and refuses it '
          'for one or none; the write shadows\' service holds no read lane and its predicate accepts it', flush=True)

    # Every read copy nginx sent, by state: one observation each while the
    # lanes were built, under nginx's request id, by the read shadow service.
    time.sleep(1)
    mirrors = [m for m in stack.logged('nginx-proxy', '{"message":"shadow_mirror"') if m['shadow'] in READS]
    edges = {e['request_id']: e for e in stack.logged('nginx-proxy', '{"message":"shadow_edge"')
             if e['route'].startswith('GET ')}
    assert len(mirrors) == len(shadowed) == len(edges), (len(mirrors), len(shadowed), len(edges))
    statuses = [m['mirror_status'] for m in mirrors]
    per_group = len(shadowed) // 5
    assert statuses[:per_group] == [404] * per_group, statuses
    assert statuses[per_group:2 * per_group] == [204] * per_group, statuses
    assert set(statuses[2 * per_group:3 * per_group]) == {504}, statuses
    assert set(statuses[3 * per_group:4 * per_group]) <= {502, 504}, statuses
    assert statuses[4 * per_group:] == [204] * per_group, statuses
    observed = {o['request_id']: o for o in seen['observations']}
    sent = [m['request_id'] for m in mirrors[per_group:2 * per_group]]
    assert set(observed) == set(sent), (len(observed), len(sent))
    for request_id in sent:
        line = observed[request_id]
        assert line['shadow'] == next(m['shadow'] for m in mirrors if m['request_id'] == request_id), line
        assert line['outcome'] in ('would_serve', 'would_hand_back', 'would_answer', 'would_fail'), line
        assert not any(part in json.dumps(line) for part in (token, 'not-printed', CONVERSATION + '&', 'lang=')), line
    by_label = dict(zip([entry[0] for entry in shadowed[per_group:2 * per_group]], [observed[i] for i in sent]))
    assert by_label['the comment list, with a cookie (observing)']['reason'] == 'cookie', by_label
    assert by_label['the next comment, with the language (observing)']['reason'] == 'lang', by_label
    assert by_label['the next comment, anonymous (observing)']['outcome'] == 'would_serve', by_label
    assert by_label['the comment list (observing)']['outcome'] == 'would_serve', by_label
    write_lines = stack.logged('polis-api-shadow', '{"message":"shadow_observation"')
    assert not [o for o in write_lines if o.get('shadow') in READS], 'the write shadows\' service observed a read'
    outcomes = {label: (o['outcome'], o['reason']) for label, o in by_label.items()}
    print(f'ok copies: of {len(mirrors)} read copies, the {per_group} sent before the switches were answered 404, '
          f'the {per_group} sent while observing were each observed once under nginx\'s request id ({outcomes}), '
          f'the paused service timed out (504) and the stopped one failed ({sorted(set(statuses[3 * per_group:4 * per_group]))}); '
          f'no observation line carries the token, the cookie or the query; the write shadows\' service observed '
          f'no read', flush=True)

    connections = dict(row.split('|') for row in seen['connections'].splitlines()) if seen['connections'] else {}
    total = sum(int(count) for count in connections.values())
    assert total <= 7, connections
    print(f'ok connections: with its three lanes at work the read shadow service held {total} lane connections '
          f'({connections}); at most 7', flush=True)


if __name__ == '__main__':
    main()
