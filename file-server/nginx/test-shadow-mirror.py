#!/usr/bin/env python3
"""The vote shadow behind the production nginx image, driven by
queue-rs/polis-api/conformance/nginx-shadow.sh against shadow-stubs.py.

  test-shadow-mirror.py baseline PREFIX OUT        Node's view of a vote, nothing selected
  test-shadow-mirror.py behaviour PREFIX MODE BASE one shadow mode, votesShadow selected
  test-shadow-mirror.py load PREFIX OUT            16 keepalive connections of votes
  test-shadow-mirror.py compare CONTROL SHADOW     the load criteria

Containers: PREFIX-proxy (nginx, port 80 published on loopback), PREFIX-node
(Node's stand-in) and PREFIX-shadow (the shadow's, absent in mode `absent`).
Every vote is a pass with an unused body field; no stand-in reads the vote.
"""
import hashlib
import http.client
import json
import re
import socket
import statistics
import subprocess
import sys
import threading
import time
import uuid

HEX32 = re.compile(r'[0-9a-f]{32}')
EDGE_KEYS = {'message', 'listener', 'service', 'route', 'request_id', 'edge_status',
             'edge_upstream_status', 'edge_upstream_s', 'edge_request_s', 'time'}
MIRROR_KEYS = {'message', 'listener', 'service', 'shadow', 'request_id', 'mirror_status',
               'mirror_upstream_status', 'mirror_s', 'time'}
# What nginx logs for a copy in each mode of the shadow service.
MIRROR_STATUS = {'answer': 204, 'delay40': 504, 'delay5s': 504, 'silent': 504,
                 'close': 502, 'refuse': 502, 'absent': 502}
RECORDING = {'answer', 'delay40', 'delay5s', 'silent'}
# The X-Forwarded-For chain every test request carries, as a load balancer in
# front of nginx sends it: the participant's address, then the edge's. Both
# are documentation addresses.
FORWARDED_FOR = '203.0.113.77, 198.51.100.9'
ADDRESSES = ('203.0.113.77', '198.51.100.9')
# The image's `main` access line: peer, user, time, request line, status,
# bytes, Referer, User-Agent, X-Forwarded-For.
ACCESS_LINE = re.compile(r'(\S+) - (\S+) \[([^\]]+)\] "([^"]*)" (\d{3}) (\d+) "([^"]*)" "([^"]*)" "([^"]*)"')
FORWARDED_FOR_FIELD = '"$http_x_forwarded_for"'
# The peer address: the participant's own where no load balancer is in front.
PEER_FIELD = '$remote_addr'
# A line of nginx's error log. It names the peer as `client:`.
ERROR_LINE = re.compile(r'\d{4}/\d\d/\d\d \d\d:\d\d:\d\d \[\w+\] ')
REQUEST_ID = re.compile(r'[0-9a-f]{32}')
# Variables that can hold an address a client or a proxy sent.
ADDRESS_VARIABLES = ('$http_x_forwarded_for', '$proxy_add_x_forwarded_for', '$http_x_real_ip',
                     '$realip_remote_addr', '$http_forwarded', '$http_cf_connecting_ip',
                     '$http_true_client_ip')
LOG_FORMAT = re.compile(r"log_format\s+(\S+)\s+(?:escape=\S+\s+)?((?:'[^']*'\s*)+);")


def docker(*args):
    return subprocess.check_output(['docker', *args], text=True, stderr=subprocess.STDOUT)


def records(container):
    try:
        out = subprocess.check_output(['docker', 'exec', container, 'cat', '/tmp/requests.jsonl'],
                                      text=True, stderr=subprocess.DEVNULL)
    except subprocess.CalledProcessError:
        return []
    return [json.loads(line) for line in out.splitlines() if line]


def proxy_port(prefix):
    host, port = docker('port', prefix + '-proxy', '80/tcp').strip().splitlines()[0].rsplit(':', 1)
    assert host == '127.0.0.1', f'the test proxy must bind loopback only: {host}'
    return int(port)


def header(record, name):
    values = [v for k, v in record['headers'] if k == name]
    return values


def raw(port, method, path, headers=(), body=b'', chunked=False):
    """One request on its own connection, with exactly these headers."""
    lines = [f'{method} {path} HTTP/1.1', 'Host: localhost', 'Connection: close', *headers]
    if chunked:
        lines.append('Transfer-Encoding: chunked')
        payload = f'{len(body):x}\r\n'.encode() + body + b'\r\n0\r\n\r\n'
    else:
        if body or method in ('POST', 'PUT'):
            lines.append(f'Content-Length: {len(body)}')
        payload = body
    with socket.create_connection(('127.0.0.1', port), timeout=15) as client:
        client.sendall(('\r\n'.join(lines) + '\r\n\r\n').encode() + payload)
        response = http.client.HTTPResponse(client, method=method)
        response.begin()
        return response.status, [(k.lower(), v) for k, v in response.getheaders()], response.read()


def vote(case, extra=''):
    return json.dumps({'conversation_id': '2fixture', 'tid': 0, 'vote': 0, 'case': case, 'pad': extra}).encode()


def case_headers(case):
    return ['Content-Type: application/json', 'Authorization: Bearer stand-in-token',
            f'X-Test-Case: {case}', f'User-Agent: shadow-test/{case}',
            f'X-Forwarded-For: {FORWARDED_FOR}']


def find(entries, case):
    return [e for e in entries if header(e, 'x-test-case') == [case]]


def wait_for(check, label, seconds=10.0):
    deadline = time.time() + seconds
    while True:
        value = check()
        if value:
            return value
        if time.time() > deadline:
            raise AssertionError(f'not observed: {label}')
        time.sleep(0.05)


def shadow_lines(prefix):
    lines = []
    for line in docker('logs', prefix + '-proxy').splitlines():
        if line.startswith('{"message":"shadow_'):
            lines.append(json.loads(line))
    return lines


def normalized(headers):
    """Node's request headers, without the values that differ by design."""
    return [[k, '<case>' if k in ('x-test-case', 'user-agent') else v] for k, v in headers
            if k != 'x-request-id']


def proxy_lines(prefix):
    return docker('logs', prefix + '-proxy').splitlines()


def access_fields(prefix, case):
    """The fields of the one ordinary access line nginx wrote for a case."""
    def found():
        return [m.groups() for m in map(ACCESS_LINE.fullmatch, proxy_lines(prefix))
                if m and m.group(8) == f'shadow-test/{case}']
    lines = wait_for(found, f'access line of {case}')
    time.sleep(0.2)
    lines = found()
    assert len(lines) == 1, f'{len(lines)} access lines for one request: {lines}'
    return lines[0]


def comparable(fields, case):
    """An access line's fields that do not differ by request or by format:
    all but the peer, the time and the X-Forwarded-For field, with the case
    masked."""
    return [fields[1], fields[3], fields[4], fields[5], fields[6], fields[7].replace(case, '<case>')]


def log_formats(prefix, path):
    text = docker('exec', prefix + '-proxy', 'cat', path)
    return {name: ''.join(re.findall(r"'([^']*)'", pieces)) for name, pieces in LOG_FORMAT.findall(text)}


def check_formats(prefix):
    """The shadowed location's access format is the image's `main` with its
    two address fields, the peer and X-Forwarded-For, each written as "-" in
    its place; no shadow format reads the peer address or an address a client
    or a proxy sent."""
    main = log_formats(prefix, '/etc/nginx/nginx.conf')['main']
    assert main.count(FORWARDED_FOR_FIELD) == 1 and main.endswith(FORWARDED_FOR_FIELD), main
    assert main.count(PEER_FIELD) == 1 and main.startswith(PEER_FIELD + ' - '), main
    shadow = log_formats(prefix, '/etc/nginx/rust-api/upstreams.conf')
    assert set(shadow) == {'polis_shadow_edge', 'polis_shadow_mirror', 'polis_shadow_access'}, sorted(shadow)
    expected = main.replace(FORWARDED_FOR_FIELD, '"-"').replace(PEER_FIELD, '-')
    assert shadow['polis_shadow_access'] == expected, (shadow['polis_shadow_access'], main)
    for name, text in shadow.items():
        for variable in ADDRESS_VARIABLES + (PEER_FIELD,):
            assert variable not in text, f'{name} reads {variable}'


def baseline(prefix, out):
    port = proxy_port(prefix)
    case = uuid.uuid4().hex
    status, headers, body = raw(port, 'POST', '/api/v3/votes', case_headers(case), vote(case))
    assert status == 200, status
    (seen,) = wait_for(lambda: find(records(prefix + '-node'), case), 'baseline vote at Node')
    assert not header(seen, 'x-request-id'), 'nothing selected: Node got a request id'
    assert header(seen, 'x-forwarded-for') == [FORWARDED_FOR], seen['headers']
    # With nothing selected the access line is `main`, addresses included:
    # what the shadowed location's line is compared with. Its first field is
    # the address this test's requests reach nginx from, with no load
    # balancer between: the known client address of every later request.
    fields = access_fields(prefix, case)
    assert fields[8] == FORWARDED_FOR, fields
    assert fields[0] != '-' and re.search(r'\d', fields[0]), fields
    with open(out, 'w') as file:
        json.dump({'headers': normalized(seen['headers']), 'response_headers': sorted(
            k for k, _ in headers if k not in ('date',)), 'body': body.decode(),
            'access': comparable(fields, case), 'peer': fields[0]}, file)
    print('ok baseline: Node\'s view of a vote with nothing selected', flush=True)


def check_vote(prefix, port, mode, base, extra_headers=(), client_id=None):
    case = uuid.uuid4().hex
    body = vote(case)
    headers = case_headers(case) + list(extra_headers)
    status, response_headers, reply = raw(port, 'POST', '/api/v3/votes', headers, body)
    # The participant gets Node's answer, byte for byte.
    expected = f'node POST /api/v3/votes {hashlib.sha256(body).hexdigest()}\n'
    assert status == 200 and reply.decode() == expected, (mode, status, reply)
    assert sorted(k for k, _ in response_headers if k != 'date') == base['response_headers'], response_headers
    # Node receives it exactly once, with the same headers as without the
    # shadow except one nginx request id.
    seen = wait_for(lambda: find(records(prefix + '-node'), case), f'{mode}: vote at Node')
    time.sleep(0.2)
    seen = find(records(prefix + '-node'), case)
    assert len(seen) == 1, f'{mode}: Node received the vote {len(seen)} times'
    (seen,) = seen
    ids = header(seen, 'x-request-id')
    assert len(ids) == 1 and HEX32.fullmatch(ids[0]), (mode, ids)
    if client_id is not None:
        assert ids[0] != client_id, f'{mode}: a client-sent request id reached Node'
    # A client-sent X-Request-Id is replaced, not added to.
    assert normalized(seen['headers']) == base['headers'], (mode, seen['headers'], base['headers'])
    # Node still receives the forwarded addresses, exactly as sent.
    assert header(seen, 'x-forwarded-for') == [FORWARDED_FOR], (mode, seen['headers'])
    assert seen['sha256'] == hashlib.sha256(body).hexdigest()
    request_id = ids[0]
    # The shadow receives the same body under the same id, once.
    if mode in RECORDING:
        copies = wait_for(lambda: find(records(prefix + '-shadow'), case), f'{mode}: copy at the shadow')
        time.sleep(0.2)
        copies = find(records(prefix + '-shadow'), case)
        assert len(copies) == 1, f'{mode}: the shadow received {len(copies)} copies'
        (copy,) = copies
        assert copy['method'] == 'POST' and copy['path'] == '/api/v3/votes', copy
        assert copy['sha256'] == seen['sha256'] and copy['length'] == seen['length'], copy
        assert header(copy, 'x-request-id') == [request_id], copy['headers']
        assert header(copy, 'x-polis-shadow') == ['votesShadow'], copy['headers']
        for name in ('authorization', 'content-type', 'host', 'x-forwarded-proto'):
            assert header(copy, name) == header(seen, name), (name, copy['headers'], seen['headers'])
    # One edge line and one copy line, joined by the request id.
    lines = wait_for(lambda: [l for l in shadow_lines(prefix) if l['request_id'] == request_id
                              and l['message'] == 'shadow_mirror'], f'{mode}: copy line')
    lines = [l for l in shadow_lines(prefix) if l['request_id'] == request_id]
    edges = [l for l in lines if l['message'] == 'shadow_edge']
    mirrors = [l for l in lines if l['message'] == 'shadow_mirror']
    assert len(edges) == 1 and len(mirrors) == 1, (mode, lines)
    assert set(edges[0]) == EDGE_KEYS and set(mirrors[0]) == MIRROR_KEYS, lines
    assert edges[0]['listener'] == mirrors[0]['listener'] == 'shadow'
    assert edges[0]['edge_status'] == 200 and edges[0]['route'] == 'POST /api/v3/votes', edges
    assert mirrors[0]['shadow'] == 'votesShadow', mirrors
    assert mirrors[0]['mirror_status'] == MIRROR_STATUS[mode], (mode, mirrors)
    # A name that does not resolve contacts no upstream, so none is logged.
    if mode == 'absent':
        assert mirrors[0]['mirror_upstream_status'] == '', mirrors
    else:
        assert mirrors[0]['mirror_upstream_status'] not in ('', '-'), mirrors
    # The ordinary access line of a shadowed vote is `main` with the peer
    # address and the X-Forwarded-For field each written "-": every other
    # field as without the shadow, and neither the address the request came
    # from nor an address it carried.
    fields = access_fields(prefix, case)
    assert fields[0] == '-', f'{mode}: the access line records the peer address: {fields}'
    assert fields[8] == '-', f'{mode}: the access line records X-Forwarded-For: {fields}'
    assert comparable(fields, case) == base['access'], (mode, fields, base['access'])
    # No line that names this request (its access line, its edge line, its
    # copy's line) holds any of them.
    for line in proxy_lines(prefix):
        if case in line or request_id in line:
            for address in ADDRESSES + (base['peer'],):
                assert address not in line, f'{mode}: a line of a shadowed vote holds {address}: {line}'
    return request_id, mirrors[0]


def behaviour(prefix, mode, base_file):
    with open(base_file) as file:
        base = json.load(file)
    port = proxy_port(prefix)
    check_formats(prefix)
    request_id, mirror = check_vote(prefix, port, mode, base)
    print(f'ok {mode}: the participant gets Node\'s exact answer; Node gets the vote once, with the same '
          f'headers plus X-Request-Id; one edge line and one copy line ({mirror["mirror_status"]} '
          f'in {mirror["mirror_s"]} s)' + ('; the shadow got the same body and id' if mode in RECORDING else ''),
          flush=True)
    # A client-sent request id is replaced, on both sides.
    check_vote(prefix, port, mode, base, ['X-Request-Id: client-chosen-id'], client_id='client-chosen-id')
    print(f'ok {mode}: a client-sent X-Request-Id is replaced by nginx\'s own', flush=True)
    print(f'ok {mode}: the access line of a shadowed vote is `main` with the peer address and '
          f'X-Forwarded-For written "-"; no line naming the vote holds the address it came from or one it '
          f'carried; Node receives the header as sent', flush=True)
    # What is never copied: other methods, bodies outside 1..9999 bytes or of
    # unknown length, and paths other than the exact one.
    cases = {
        'GET': ('GET', '/api/v3/votes', b'', False),
        'HEAD': ('HEAD', '/api/v3/votes', b'', False),
        'PUT': ('PUT', '/api/v3/votes', b'{}', False),
        'empty body': ('POST', '/api/v3/votes', b'', False),
        '10000 bytes': ('POST', '/api/v3/votes', b'x' * 10000, False),
        '20000 bytes': ('POST', '/api/v3/votes', b'x' * 20000, False),
        'chunked': ('POST', '/api/v3/votes', b'{"vote":0}', True),
        'trailing slash': ('POST', '/api/v3/votes/', b'{}', False),
        'mixed case': ('POST', '/api/v3/Votes', b'{}', False),
    }
    skipped_by_bound = {'empty body', '10000 bytes', '20000 bytes', 'chunked'}
    sent = {}
    for name, (method, path, body, chunked) in cases.items():
        case = uuid.uuid4().hex
        status, _, reply = raw(port, method, path, case_headers(case), body, chunked=chunked)
        assert status == 200, (mode, name, status, reply)
        sent[name] = case
    time.sleep(0.5)
    node = records(prefix + '-node')
    shadow = records(prefix + '-shadow')
    lines = shadow_lines(prefix)
    for name, case in sent.items():
        (seen,) = find(node, case)
        assert not find(shadow, case), f'{mode}: {name} was copied'
        ids = header(seen, 'x-request-id')
        if name in skipped_by_bound:
            # The POST reached the vote location: its copy stopped at the body
            # bound, without contacting the shadow.
            (request_id,) = ids
            mirrors = [l for l in lines if l['request_id'] == request_id and l['message'] == 'shadow_mirror']
            assert len(mirrors) == 1 and mirrors[0]['mirror_status'] == 204, (name, mirrors)
            # escape=json logs an unset upstream status as an empty string.
            assert mirrors[0]['mirror_upstream_status'] == '', (name, mirrors)
            # It is still a request of the shadowed location: no address.
            fields = access_fields(prefix, case)
            assert (fields[0], fields[8]) == ('-', '-'), (mode, name, fields)
        else:
            assert ids == [], f'{mode}: {name} went through the shadow path'
            # Any other location's access line is `main`, as before: the
            # known client address first, the forwarded addresses last.
            fields = access_fields(prefix, case)
            assert (fields[0], fields[8]) == (base['peer'], FORWARDED_FOR), (mode, name, fields)
    print(f'ok {mode}: GET, HEAD, PUT, empty, 10000 and 20000 byte and chunked bodies, a trailing slash '
          f'and a mixed-case path reach Node once and are not copied', flush=True)
    # The copy's location is internal.
    before = len(records(prefix + '-node'))
    for method in ('GET', 'POST'):
        status, _, _ = raw(port, method, '/_polis_shadow/votesShadow', [], b'{}' if method == 'POST' else b'')
        assert status == 404, (mode, method, status)
    assert len(records(prefix + '-node')) == before, 'a direct request to the copy location reached Node'
    print(f'ok {mode}: a direct request to the copy location is answered 404', flush=True)
    # Everything nginx wrote in this mode, access log and error log alike:
    # a line that holds a forwarded address is the `main` line of a request
    # that is not a POST to the shadowed path.
    held = [line for line in proxy_lines(prefix) if any(address in line for address in ADDRESSES)]
    assert held, f'{mode}: no other request logged its forwarded address'
    for line in held:
        fields = ACCESS_LINE.fullmatch(line)
        assert fields and fields.group(4) != 'POST /api/v3/votes HTTP/1.1', (
            f'{mode}: a forwarded address beside a shadowed vote: {line}')
    # The address the requests came from: on the `main` line of a request
    # that is not a POST to the shadowed path, or on a line of nginx's error
    # log (`client:`), which names no request id. Never on any other line.
    ids = {m['request_id'] for m in shadow_lines(prefix)}
    assert ids, f'{mode}: no shadow line'
    peer = [line for line in proxy_lines(prefix) if base['peer'] in line]
    errors = 0
    for line in peer:
        fields = ACCESS_LINE.fullmatch(line)
        if fields:
            assert fields.group(4) != 'POST /api/v3/votes HTTP/1.1', (
                f'{mode}: the peer address beside a shadowed vote: {line}')
            continue
        assert ERROR_LINE.match(line), f'{mode}: the peer address on a line of another kind: {line}'
        assert not ids & set(REQUEST_ID.findall(line)), f'{mode}: an error line names a request id: {line}'
        errors += 1
    assert len(peer) - errors >= len(held), (mode, len(peer), errors, len(held))
    print(f'ok {mode}: of {len(proxy_lines(prefix))} lines nginx wrote, the {len(held)} that hold a forwarded '
          f'address are all `main` lines of requests that are not a POST to the path; the address the '
          f'requests came from is on {len(peer) - errors} such `main` lines and on {errors} error-log lines, '
          f'which name no request id', flush=True)
    # Informational: how long the next request on the same connection waits.
    waits = hold(port, 30)
    print(f'info {mode}: next request on the same connection p50 {pct(waits, 50):.2f} ms, '
          f'p99 {pct(waits, 99):.2f} ms, max {max(waits):.2f} ms (n={len(waits)})', flush=True)


def pct(values, q):
    values = sorted(values)
    return values[min(len(values) - 1, max(0, int(round(q / 100 * len(values) + 0.5)) - 1))]


def hold(port, n):
    """Votes on one keepalive connection, each followed by a GET on the same
    connection; returns the GETs' latencies in milliseconds."""
    connection = http.client.HTTPConnection('127.0.0.1', port, timeout=15)
    waits = []
    for _ in range(n):
        body = vote(uuid.uuid4().hex)
        connection.request('POST', '/api/v3/votes', body=body,
                           headers={'Content-Type': 'application/json'})
        connection.getresponse().read()
        started = time.perf_counter()
        connection.request('GET', '/api/v3/testConnection')
        connection.getresponse().read()
        waits.append((time.perf_counter() - started) * 1000)
    connection.close()
    return waits


def load(prefix, out, connections=16, votes=100):
    port = proxy_port(prefix)
    results = {'vote_ms': [], 'next_ms': [], 'failures': 0}
    lock = threading.Lock()

    def run():
        connection = http.client.HTTPConnection('127.0.0.1', port, timeout=15)
        vote_ms, next_ms, failures = [], [], 0
        for _ in range(votes):
            try:
                body = vote(uuid.uuid4().hex)
                started = time.perf_counter()
                connection.request('POST', '/api/v3/votes', body=body,
                                   headers={'Content-Type': 'application/json'})
                response = connection.getresponse()
                response.read()
                vote_ms.append((time.perf_counter() - started) * 1000)
                started = time.perf_counter()
                connection.request('GET', '/api/v3/testConnection')
                second = connection.getresponse()
                second.read()
                next_ms.append((time.perf_counter() - started) * 1000)
                if response.status != 200 or second.status != 200:
                    failures += 1
            except (OSError, http.client.HTTPException):
                failures += 1
                connection.close()
                connection = http.client.HTTPConnection('127.0.0.1', port, timeout=15)
        connection.close()
        with lock:
            results['vote_ms'] += vote_ms
            results['next_ms'] += next_ms
            results['failures'] += failures

    hold(port, 5)  # warm the proxy's connections and the stand-ins
    threads = [threading.Thread(target=run) for _ in range(connections)]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join()
    summary = {key: {'n': len(values), 'p50': pct(values, 50), 'p99': pct(values, 99), 'max': max(values)}
               for key, values in (('vote_ms', results['vote_ms']), ('next_ms', results['next_ms']))}
    summary['failures'] = results['failures']
    with open(out, 'w') as file:
        json.dump(summary, file)
    print(f'info load {out}: ' + json.dumps(summary), flush=True)


def compare(control_file, shadow_file):
    with open(control_file) as file:
        control = json.load(file)
    with open(shadow_file) as file:
        shadow = json.load(file)
    assert control['failures'] == 0 and shadow['failures'] == 0, (control, shadow)
    assert shadow['vote_ms']['n'] == control['vote_ms']['n'] == 1600, (control, shadow)
    assert shadow['vote_ms']['p99'] <= control['vote_ms']['p99'] + 5, (
        f'vote p99 {shadow["vote_ms"]["p99"]:.2f} ms against control {control["vote_ms"]["p99"]:.2f} ms')
    assert shadow['next_ms']['p99'] <= 60, f'next request p99 {shadow["next_ms"]["p99"]:.2f} ms'
    print(f'ok load: 16 keepalive connections x 100 votes, silent shadow; vote p99 '
          f'{shadow["vote_ms"]["p99"]:.2f} ms (control {control["vote_ms"]["p99"]:.2f} ms, within 5 ms); '
          f'the next request on each connection p99 {shadow["next_ms"]["p99"]:.2f} ms (at most 60 ms; '
          f'control {control["next_ms"]["p99"]:.2f} ms), max {shadow["next_ms"]["max"]:.2f} ms; '
          f'no client failures', flush=True)


if __name__ == '__main__':
    command, *args = sys.argv[1:]
    {'baseline': baseline, 'behaviour': behaviour, 'load': load, 'compare': compare}[command](*args)
