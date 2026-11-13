#!/usr/bin/env python3
"""The vote shadow and the comment shadow behind the production nginx image,
driven by queue-rs/polis-api/conformance/nginx-shadow.sh against
shadow-stubs.py.

  test-shadow-mirror.py baseline PREFIX OUT [SHADOW]        Node's view of a request, nothing selected
  test-shadow-mirror.py behaviour PREFIX MODE BASE [SHADOW] one shadow mode, the shadow selected
  test-shadow-mirror.py load PREFIX OUT                     16 keepalive connections of votes
  test-shadow-mirror.py compare CONTROL SHADOW              the load criteria
  test-shadow-mirror.py read PREFIX BASE                    GET and HEAD on the comment path
  test-shadow-mirror.py rate PREFIX                         the comment copies' rate
  test-shadow-mirror.py keepalive PREFIX STATE              the rate on one keepalive connection
  test-shadow-mirror.py bodies PREFIX OUT STATE             comment bodies of every size
  test-shadow-mirror.py same-bodies CONTROL SHADOW          the two `bodies` runs answered alike
  test-shadow-mirror.py measure PREFIX NETWORK IMAGE OUT    what the mirror costs a comment
  test-shadow-mirror.py measured CONTROL SHADOW             the two `measure` runs side by side
  test-shadow-mirror.py read-baseline PREFIX OUT            Node's view of the three reads, nothing selected
  test-shadow-mirror.py read-behaviour PREFIX MODE BASE     one read shadow mode, the read shadows selected
  test-shadow-mirror.py read-hold PREFIX MODE               a read's reply does not wait for its copy
  test-shadow-mirror.py read-rate PREFIX                    the read copies' rate
  test-shadow-mirror.py read-keepalive PREFIX STATE         the read rate on one keepalive connection
  test-shadow-mirror.py read-unchanged PREFIX BASE          reads answered as with nothing selected
  test-shadow-mirror.py read-beside PREFIX MODE RBASE VBASE CBASE  every shadow selected
  test-shadow-mirror.py read-load PREFIX OUT                16 keepalive connections of next-comment reads

SHADOW is votesShadow (the default) or commentsShadow. Containers:
PREFIX-proxy (nginx, port 80 published on loopback), PREFIX-node (Node's
stand-in), PREFIX-shadow (the shadow's, absent in mode `absent`) and, for
the read shadows, PREFIX-reads (the read shadow's, absent in mode `absent`).
Every vote is a pass with an unused body field, and so is the vote a comment
carries; no stand-in reads a vote or a comment.
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
                 'close': 502, 'refuse': 502, 'absent': 502, 'status404': 404, 'status500': 500}
RECORDING = {'answer', 'delay40', 'delay5s', 'silent', 'status404', 'status500'}
# The X-Forwarded-For chain every test request carries, as a load balancer in
# front of nginx sends it: the participant's address, then the edge's. Both
# are documentation addresses.
FORWARDED_FOR = '203.0.113.77, 198.51.100.9'
ADDRESSES = ('203.0.113.77', '198.51.100.9')
# The ordinary access line (the image's `main`, with the request line written
# without its query string and the Referer without its query string and
# fragment): peer, user, time, request line, status, bytes, Referer,
# User-Agent, X-Forwarded-For.
ACCESS_LINE = re.compile(r'(\S+) - (\S+) \[([^\]]+)\] "([^"]*)" (\d{3}) (\d+) "([^"]*)" "([^"]*)" "([^"]*)"')
FORWARDED_FOR_FIELD = '"$http_x_forwarded_for"'
# What the ordinary format writes in place of `main`'s request line and
# Referer (nginx-ssl.site.default.conf).
REQUEST_FIELD = '"$request_method $polis_log_path $server_protocol"'
REFERER_FIELD = '"$polis_log_referer"'
# Variables that hold a query string, or a request line or a Referer whole.
WHOLE_VARIABLES = ('$request"', '$request ', '$request_uri', '$args', '$query_string', '$is_args', '$arg_',
                   '$http_referer')
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
# The comment copies' rate, as render-rust-api.sh sets it: copies a second on
# one box, and how many more at once.
COMMENT_RATE = 2
COMMENT_BURST = 4
# When nginx reads a whole request body before proxying (as the mirror makes
# it for a request it copies, and as proxying makes it for a chunked body),
# the body is held in memory when what is left of it, after the bytes that
# arrived in the buffer with the request's headers (1 kB), is under a
# quarter more than its two-page buffer; a longer one is written to a
# temporary file first. BODY_IN_MEMORY is the last size certainly in memory,
# BODY_TO_FILE the first certainly not. The largest body that is copied,
# COPIED_BODY, is in memory.
BODY_BUFFER = 8192
BODY_IN_MEMORY = BODY_BUFFER + BODY_BUFFER // 4 - 1
BODY_TO_FILE = BODY_BUFFER + BODY_BUFFER // 4 + 1024
COPIED_BODY = 9999
assert COPIED_BODY <= BODY_IN_MEMORY
# The largest body nginx (client_max_body_size 50M) and Node's parser (50mb)
# accept.
LARGEST_BODY = 50 * 1024 * 1024


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


def raw(port, method, path, headers=(), body=b'', chunked=False, parts=1, pause=0.0, host='127.0.0.1',
        length=None):
    """One request on its own connection, with exactly these headers. With
    `parts` above 1 the body is sent in that many pieces, `pause` seconds
    apart. `length` is the Content-Length as written, when it is not the
    body's length in plain digits; an empty one sends no such header."""
    lines = [f'{method} {path} HTTP/1.1', 'Host: localhost', 'Connection: close', *headers]
    if chunked:
        lines.append('Transfer-Encoding: chunked')
        payload = f'{len(body):x}\r\n'.encode() + body + b'\r\n0\r\n\r\n'
    else:
        if length is not None:
            lines += [f'Content-Length: {length}'] if length else []
        elif body or method in ('POST', 'PUT'):
            lines.append(f'Content-Length: {len(body)}')
        payload = body
    with socket.create_connection((host, port), timeout=60) as client:
        head = ('\r\n'.join(lines) + '\r\n\r\n').encode()
        if parts > 1:
            size = max(1, len(payload) // parts)
            client.sendall(head + payload[:size])
            for start in range(size, len(payload), size):
                time.sleep(pause)
                client.sendall(payload[start:start + size])
        else:
            client.sendall(head + payload)
        response = http.client.HTTPResponse(client, method=method)
        response.begin()
        return response.status, [(k.lower(), v) for k, v in response.getheaders()], response.read()


def vote(case, extra=''):
    return json.dumps({'conversation_id': '2fixture', 'tid': 0, 'vote': 0, 'case': case, 'pad': extra}).encode()


def comment(case, extra=''):
    """A comment as the participation page sends it: the text, the two keys
    Node ignores, and the author's vote (a pass here)."""
    return json.dumps({'txt': f'A comment the test wrote, {case}', 'pid': 'mypid',
                       'conversation_id': '2fixture', 'vote': 0, 'agid': 1, 'pad': extra}).encode()


def sized_comment(size):
    """A comment body of exactly `size` bytes, the same bytes every time."""
    empty = len(comment('sized'))
    assert size >= empty, f'{size} bytes is shorter than an empty test comment ({empty})'
    body = comment('sized', 'x' * (size - empty))
    assert len(body) == size, (len(body), size)
    return body


# What differs between the two shadows: the selector name, the path, the body
# a client posts, and the Content-Type it posts it with (the page pol.is
# serves posts a comment through XMLHttpRequest, which writes the charset in
# upper case).
ROUTES = {
    'votesShadow': {'name': 'votesShadow', 'path': '/api/v3/votes', 'what': 'vote', 'body': vote,
                    'content_type': 'application/json', 'other_case': '/api/v3/Votes'},
    'commentsShadow': {'name': 'commentsShadow', 'path': '/api/v3/comments', 'what': 'comment', 'body': comment,
                       'content_type': 'application/json; charset=UTF-8', 'other_case': '/api/v3/Comments'},
}


def case_headers(case, route=ROUTES['votesShadow']):
    return [f'Content-Type: {route["content_type"]}', 'Authorization: Bearer stand-in-token',
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


def reply_headers(headers):
    """A reply's headers as the client received them, without its date."""
    return sorted([k, v] for k, v in headers if k != 'date')


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
    """The ordinary access format is the image's `main` with its request
    line and its Referer each replaced by the field that has no query string.
    The shadowed location's access format is that format with its two address
    fields, the peer and X-Forwarded-For, each written as "-" in its place.
    No shadow format reads the peer address or an address a client or a proxy
    sent, and no format reads a query string, or a request line or a Referer
    whole."""
    main = log_formats(prefix, '/etc/nginx/nginx.conf')['main']
    assert main.count(FORWARDED_FOR_FIELD) == 1 and main.endswith(FORWARDED_FOR_FIELD), main
    assert main.count(PEER_FIELD) == 1 and main.startswith(PEER_FIELD + ' - '), main
    assert main.count('"$request"') == 1 and main.count('"$http_referer"') == 1, main
    site = log_formats(prefix, '/etc/nginx/conf.d/default.conf')
    assert set(site) == {'polis_access'}, sorted(site)
    ordinary = main.replace('"$request"', REQUEST_FIELD).replace('"$http_referer"', REFERER_FIELD)
    assert site['polis_access'] == ordinary, (site['polis_access'], main)
    shadow = log_formats(prefix, '/etc/nginx/rust-api/upstreams.conf')
    assert set(shadow) == {'polis_shadow_edge', 'polis_shadow_mirror', 'polis_shadow_access'}, sorted(shadow)
    expected = ordinary.replace(FORWARDED_FOR_FIELD, '"-"').replace(PEER_FIELD, '-')
    assert shadow['polis_shadow_access'] == expected, (shadow['polis_shadow_access'], ordinary)
    for name, text in shadow.items():
        for variable in ADDRESS_VARIABLES + (PEER_FIELD,):
            assert variable not in text, f'{name} reads {variable}'
    for name, text in {**site, **shadow}.items():
        for variable in WHOLE_VARIABLES:
            assert variable not in text + ' ', f'{name} reads {variable.strip()}'


def uncopied_cases(route):
    """Requests on and beside a shadowed path that the shadow is never sent a
    copy of. With the shadow selected each must reach Node exactly as with
    nothing selected: never through the location that reads the whole body
    first. label: (method, path, body, keywords of `raw`, extra headers)."""
    path = route['path']
    cases = {
        'GET': ('GET', path, b'', {}, []),
        'HEAD': ('HEAD', path, b'', {}, []),
        'PUT': ('PUT', path, b'{}', {}, []),
        'DELETE': ('DELETE', path, b'', {}, []),
        'OPTIONS': ('OPTIONS', path, b'', {}, []),
        'a POST with an empty body': ('POST', path, b'', {}, []),
        'a POST with no Content-Length': ('POST', path, b'', {'length': ''}, []),
        'a POST whose Content-Length has a leading zero': ('POST', path, b'{"vote":0}', {'length': '010'}, []),
        'a POST of 10000 bytes': ('POST', path, b'x' * 10000, {}, []),
        'a POST of 20000 bytes': ('POST', path, b'x' * 20000, {}, []),
        'a POST of 20000 bytes with a client-sent request id': ('POST', path, b'y' * 20000, {},
                                                              ['X-Request-Id: client-chosen-id']),
        'a POST of 20000 bytes sent in two halves 0.6 s apart': ('POST', path, b'z' * 20000,
                                                               {'parts': 2, 'pause': 0.6}, []),
        'a chunked POST': ('POST', path, b'{"vote":0}', {'chunked': True}, []),
        'a chunked POST of 20000 bytes': ('POST', path, b'c' * 20000, {'chunked': True}, []),
        'a POST with a trailing slash': ('POST', path + '/', b'{}', {}, []),
        'a POST with a mixed-case path': ('POST', route['other_case'], b'{}', {}, []),
    }
    if route['name'] == 'commentsShadow':
        # The other routes under the comment path keep their own locations.
        cases['the seed upload'] = ('POST', '/api/v3/comments-bulk', b'{}', {}, [])
        cases['a translation read'] = ('GET', '/api/v3/comments/translations', b'', {}, [])
    return cases


# The uncopied POST whose body arrives in two halves: how long Node must have
# held the request's headers before it had the whole body, when nginx streams
# the body to it (the halves are 0.6 s apart).
STREAMED = 'a POST of 20000 bytes sent in two halves 0.6 s apart'
STREAMED_SECONDS = 0.4


def send_uncopied(prefix, port, route):
    """Sends every uncopied case once. Returns, by label, what the client
    got, what Node received and the access line nginx wrote, and the test
    case ids sent."""
    seen_by, ids = {}, {}
    for label, (method, target, body, options, extra) in uncopied_cases(route).items():
        case = uuid.uuid4().hex
        status, headers, reply = raw(port, method, target, case_headers(case, route) + extra, body, **options)
        ids[label] = case
        (seen,) = wait_for(lambda: find(records(prefix + '-node'), case), f'{label} at Node')
        fields = access_fields(prefix, case)
        seen_by[label] = {'status': status, 'reply_headers': reply_headers(headers), 'reply': reply.decode(),
                          'node_headers': normalized(seen['headers']),
                          'node_request_id': header(seen, 'x-request-id'),
                          'node_body': [seen['length'], seen['sha256']],
                          'node_waited_for_body': seen['at'] - seen['head'],
                          'access': comparable(fields, case), 'access_addresses': [fields[0], fields[8]]}
    return seen_by, ids


def baseline(prefix, out, shadow='votesShadow'):
    route = ROUTES[shadow]
    what, path = route['what'], route['path']
    port = proxy_port(prefix)
    case = uuid.uuid4().hex
    status, headers, body = raw(port, 'POST', path, case_headers(case, route), route['body'](case))
    assert status == 200, status
    (seen,) = wait_for(lambda: find(records(prefix + '-node'), case), f'baseline {what} at Node')
    assert not header(seen, 'x-request-id'), 'nothing selected: Node got a request id'
    assert header(seen, 'x-forwarded-for') == [FORWARDED_FOR], seen['headers']
    # With nothing selected the access line is the ordinary one, addresses
    # included:
    # what the shadowed location's line is compared with. Its first field is
    # the address this test's requests reach nginx from, with no load
    # balancer between: the known client address of every later request.
    fields = access_fields(prefix, case)
    assert fields[8] == FORWARDED_FOR, fields
    assert fields[0] != '-' and re.search(r'\d', fields[0]), fields
    base = {'headers': normalized(seen['headers']), 'response_headers': sorted(
        k for k, _ in headers if k not in ('date',)), 'reply_headers': reply_headers(headers),
        'body': body.decode(), 'access': comparable(fields, case), 'peer': fields[0]}
    # The requests no shadow is sent a copy of, with nothing selected: what
    # each must still be, to the byte, with a shadow selected.
    base['uncopied'], _ = send_uncopied(prefix, port, route)
    assert base['uncopied'][STREAMED]['node_waited_for_body'] >= STREAMED_SECONDS, base['uncopied'][STREAMED]
    if shadow == 'commentsShadow':
        # The read route on the same path, with nothing selected: what every
        # client polls. Its reply, what Node received and its access line.
        base['reads'] = {}
        for method in ('GET', 'HEAD'):
            case = uuid.uuid4().hex
            status, headers, body = raw(port, method, path + '?conversation_id=2fixture', case_headers(case, route))
            (seen,) = wait_for(lambda: find(records(prefix + '-node'), case), f'baseline {method} at Node')
            base['reads'][method] = {'status': status, 'reply_headers': reply_headers(headers),
                                     'body': body.decode(), 'headers': normalized(seen['headers']),
                                     'had_request_id': bool(header(seen, 'x-request-id')),
                                     'access': comparable(access_fields(prefix, case), case)}
    with open(out, 'w') as file:
        json.dump(base, file)
    print(f'ok baseline: Node\'s view of a {what} with nothing selected', flush=True)


def check_post(prefix, port, mode, base, route, extra_headers=(), client_id=None):
    what, path, name = route['what'], route['path'], route['name']
    case = uuid.uuid4().hex
    body = route['body'](case)
    headers = case_headers(case, route) + list(extra_headers)
    status, response_headers, reply = raw(port, 'POST', path, headers, body)
    # The participant gets Node's answer, byte for byte.
    expected = f'node POST {path} {hashlib.sha256(body).hexdigest()}\n'
    assert status == 200 and reply.decode() == expected, (mode, status, reply)
    assert sorted(k for k, _ in response_headers if k != 'date') == base['response_headers'], response_headers
    # Every reply header has the value it has with nothing selected.
    assert reply_headers(response_headers) == base['reply_headers'], (mode, response_headers, base['reply_headers'])
    # Node receives it exactly once, with the same headers as without the
    # shadow except one nginx request id.
    seen = wait_for(lambda: find(records(prefix + '-node'), case), f'{mode}: {what} at Node')
    time.sleep(0.2)
    seen = find(records(prefix + '-node'), case)
    assert len(seen) == 1, f'{mode}: Node received the {what} {len(seen)} times'
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
        assert copy['method'] == 'POST' and copy['path'] == path, copy
        assert copy['sha256'] == seen['sha256'] and copy['length'] == seen['length'], copy
        assert header(copy, 'x-request-id') == [request_id], copy['headers']
        assert header(copy, 'x-polis-shadow') == [name], copy['headers']
        for field in ('authorization', 'content-type', 'host', 'x-forwarded-proto'):
            assert header(copy, field) == header(seen, field), (field, copy['headers'], seen['headers'])
        assert header(copy, 'content-type') == [route['content_type']], copy['headers']
    # One edge line and one copy line, joined by the request id.
    lines = wait_for(lambda: [l for l in shadow_lines(prefix) if l['request_id'] == request_id
                              and l['message'] == 'shadow_mirror'], f'{mode}: copy line')
    lines = [l for l in shadow_lines(prefix) if l['request_id'] == request_id]
    edges = [l for l in lines if l['message'] == 'shadow_edge']
    mirrors = [l for l in lines if l['message'] == 'shadow_mirror']
    assert len(edges) == 1 and len(mirrors) == 1, (mode, lines)
    assert set(edges[0]) == EDGE_KEYS and set(mirrors[0]) == MIRROR_KEYS, lines
    assert edges[0]['listener'] == mirrors[0]['listener'] == 'shadow'
    assert edges[0]['edge_status'] == 200 and edges[0]['route'] == f'POST {path}', edges
    assert mirrors[0]['shadow'] == name, mirrors
    assert mirrors[0]['mirror_status'] == MIRROR_STATUS[mode], (mode, mirrors)
    # A name that does not resolve contacts no upstream, so none is logged.
    if mode == 'absent':
        assert mirrors[0]['mirror_upstream_status'] == '', mirrors
    else:
        assert mirrors[0]['mirror_upstream_status'] not in ('', '-'), mirrors
    # The access line of a shadowed request is the ordinary one with the peer
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
                assert address not in line, f'{mode}: a line of a shadowed {what} holds {address}: {line}'
    return request_id, mirrors[0]


# Query strings a copied request may carry, each sent to Node and to the
# shadow byte for byte: parameters of the routes, and one with escapes, a
# plus, a repeated key, an empty value and a bare key.
QUERIES = ('?conversation_id=2fixture&is_seed=true',
           '?conversation_id=2fixture&xid=a%20b%2Fc+d&x=%C3%A9&x=&y')
# The page such a request is sent from, as an embed's frame is addressed: its
# query string carries what the embedding site supplies about a person.
EMBED_PAGE = 'https://pol.is/2fixture'
EMBED_REFERER = EMBED_PAGE + '?xid=a%20b%2Fc+d&x_name=A%20Name&x_profile_image_url=https%3A%2F%2Fembedder.example%2Fa.png#top'


def check_query(prefix, port, mode, route):
    """A copied request with a query string: Node receives it as sent, and so
    does the shadow, on the same path: the copy is the request a write route
    would be handed, query string included. A bare `?` is an empty query
    string: Node receives it as sent and the copy's path has none. The request
    is sent from an embed's frame, whose address (the Referer) carries an
    external id and a name: Node and the shadow receive the Referer as sent,
    and no access line or shadow line of the request holds the query string,
    the Referer's query string or its fragment."""
    what, path, name = route['what'], route['path'], route['name']
    for query in QUERIES + ('?',):
        if name == 'commentsShadow':
            time.sleep(1 / COMMENT_RATE)  # inside the copies' rate
        case = uuid.uuid4().hex
        body = route['body'](case)
        status, _, reply = raw(port, 'POST', path + query,
                               case_headers(case, route) + [f'Referer: {EMBED_REFERER}'], body)
        digest = hashlib.sha256(body).hexdigest()
        assert status == 200 and reply.decode() == f'node POST {path + query} {digest}\n', (mode, query, status, reply)
        seen = wait_for(lambda: find(records(prefix + '-node'), case), f'{mode}: {what} with a query string at Node')
        time.sleep(0.2)
        (seen,) = find(records(prefix + '-node'), case)
        assert seen['path'] == path + query, (mode, seen['path'])
        assert header(seen, 'referer') == [EMBED_REFERER], (mode, seen['headers'])
        (request_id,) = header(seen, 'x-request-id')
        assert HEX32.fullmatch(request_id), request_id
        if mode in RECORDING:
            copies = wait_for(lambda: find(records(prefix + '-shadow'), case), f'{mode}: copy with a query string')
            time.sleep(0.2)
            (copy,) = find(records(prefix + '-shadow'), case)
            assert copy['path'] == path + ('' if query == '?' else query), (mode, query, copy['path'])
            assert copy['method'] == 'POST' and copy['sha256'] == digest, copy
            assert header(copy, 'x-request-id') == [request_id] and header(copy, 'x-polis-shadow') == [name], copy
            assert header(copy, 'referer') == [EMBED_REFERER], (mode, copy['headers'])
        # The two JSON lines never carry the query string: the edge line
        # names the path alone.
        lines = wait_for(lambda: [l for l in shadow_lines(prefix) if l['request_id'] == request_id
                                  and l['message'] == 'shadow_mirror'], f'{mode}: copy line of a query string')
        (edge,) = [l for l in shadow_lines(prefix) if l['request_id'] == request_id and l['message'] == 'shadow_edge']
        assert edge['route'] == f'POST {path}' and lines[0]['mirror_status'] == MIRROR_STATUS[mode], (edge, lines)
        # Nor does the access line: the path alone, and the Referer up to its
        # path. (nginx's error log, written when a copy fails, prints a
        # request line whole; it names neither the request id nor the case.)
        fields = access_fields(prefix, case)
        assert fields[3] == f'POST {path} HTTP/1.1', (mode, query, fields)
        assert fields[6] == EMBED_PAGE, (mode, fields)
        assert (fields[0], fields[8]) == ('-', '-'), (mode, fields)
        named = [line for line in proxy_lines(prefix) if request_id in line or case in line]
        assert len(named) == 3, (mode, named)
        for line in named:
            for part in ('?', 'conversation_id', 'xid', 'x_name', 'x_profile_image_url', 'A%20Name', '#top'):
                assert part not in line, f'{mode}: a line of a shadowed {what} holds {part}: {line}'


def behaviour(prefix, mode, base_file, shadow='votesShadow'):
    route = ROUTES[shadow]
    what, path, name = route['what'], route['path'], route['name']
    with open(base_file) as file:
        base = json.load(file)
    port = proxy_port(prefix)
    check_formats(prefix)
    request_id, mirror = check_post(prefix, port, mode, base, route)
    print(f'ok {mode}: the participant gets Node\'s exact answer; Node gets the {what} once, with the same '
          f'headers plus X-Request-Id; one edge line and one copy line ({mirror["mirror_status"]} '
          f'in {mirror["mirror_s"]} s)' + ('; the shadow got the same body and id' if mode in RECORDING else ''),
          flush=True)
    # A client-sent request id is replaced, on both sides.
    check_post(prefix, port, mode, base, route, ['X-Request-Id: client-chosen-id'], client_id='client-chosen-id')
    print(f'ok {mode}: a client-sent X-Request-Id is replaced by nginx\'s own', flush=True)
    check_query(prefix, port, mode, route)
    print(f'ok {mode}: a {what} posted with a query string reaches Node with it' +
          (', and its copy reaches the shadow on the same path with the same query string, byte for byte'
           if mode in RECORDING else '') + '; Node' + (' and the shadow receive' if mode in RECORDING else ' receives') +
          ' its Referer as sent; neither JSON line carries the query string, and the access line has the path '
          'alone and the Referer without its query string and fragment', flush=True)
    print(f'ok {mode}: the access line of a shadowed {what} is the ordinary one with the peer address and '
          f'X-Forwarded-For written "-"; no line naming the {what} holds the address it came from or one it '
          f'carried; Node receives the header as sent', flush=True)
    # What is never copied: other methods, a POST whose body is empty, of
    # undeclared length, chunked or over 9999 bytes, and paths other than the
    # exact one. None of them enters the shadow's locations: each reaches
    # Node once, exactly as with nothing selected (the same request headers
    # in the same order, a request id only if the client sent one, the body
    # streamed and not read whole first), gets the same reply to the byte,
    # and is logged in the ordinary format with its addresses; no shadow line
    # is written
    # and nothing is copied.
    lines_before = len(shadow_lines(prefix))
    copies_before = len(records(prefix + '-shadow'))
    seen_by, sent = send_uncopied(prefix, port, route)
    time.sleep(0.5)
    node = records(prefix + '-node')
    copied = records(prefix + '-shadow')
    assert sorted(seen_by) == sorted(base['uncopied']), (sorted(seen_by), sorted(base['uncopied']))
    for label, case in sent.items():
        got, want = seen_by[label], base['uncopied'][label]
        assert len(find(node, case)) == 1, f'{mode}: Node received {label} {len(find(node, case))} times'
        assert not find(copied, case), f'{mode}: {label} was copied'
        for key in ('status', 'reply_headers', 'reply', 'node_headers', 'node_request_id', 'node_body', 'access'):
            assert got[key] == want[key], (mode, label, key, got[key], want[key])
        assert got['node_request_id'] in ([], ['client-chosen-id']), (
            f'{mode}: {label} went through the shadow path: {got["node_request_id"]}')
        # The access line is the ordinary one, as with nothing selected: the
        # known client address first, the forwarded addresses last.
        assert got['access_addresses'] == [base['peer'], FORWARDED_FOR], (mode, label, got['access_addresses'])
    # The body that arrives in two halves is streamed: Node has the request's
    # headers while the second half is still on its way.
    assert seen_by[STREAMED]['node_waited_for_body'] >= STREAMED_SECONDS, (
        f'{mode}: nginx read the whole body of an uncopied POST before contacting Node: Node waited '
        f'{seen_by[STREAMED]["node_waited_for_body"]:.3f} s for the body')
    assert len(shadow_lines(prefix)) == lines_before, f'{mode}: an uncopied request wrote a shadow line'
    assert len(records(prefix + '-shadow')) == copies_before, f'{mode}: an uncopied request was copied'
    print(f'ok {mode}: {len(sent)} requests that are never copied (GET, HEAD, PUT, DELETE, OPTIONS; a POST with '
          f'an empty body, with no Content-Length, with a leading zero in it, of 10000 and 20000 bytes, chunked, '
          f'with a trailing slash, with a mixed-case path) reach Node once, exactly as with nothing selected: '
          f'the same headers at Node, the same reply bytes, the ordinary access line, no request id but a '
          f'client\'s own, no shadow line and no copy; a 20000-byte body sent in two halves is streamed (Node '
          f'had its headers {seen_by[STREAMED]["node_waited_for_body"]:.2f} s before its last byte, '
          f'{base["uncopied"][STREAMED]["node_waited_for_body"]:.2f} s with nothing selected)', flush=True)
    # The copy's location is internal.
    before = len(records(prefix + '-node'))
    for method in ('GET', 'POST'):
        status, _, _ = raw(port, method, '/_polis_shadow/' + name, [], b'{}' if method == 'POST' else b'')
        assert status == 404, (mode, method, status)
    assert len(records(prefix + '-node')) == before, 'a direct request to the copy location reached Node'
    print(f'ok {mode}: a direct request to the copy location is answered 404', flush=True)
    # Everything nginx wrote in this mode, access log and error log alike:
    # a line that holds a forwarded address is the ordinary line of a request
    # that was not copied: not a POST to the shadowed path, or one of the
    # uncopied POSTs sent above.
    shadowed = f'POST {path} HTTP/1.1'
    uncopied_agents = {f'shadow-test/{case}' for case in sent.values()}
    held = [line for line in proxy_lines(prefix) if any(address in line for address in ADDRESSES)]
    assert held, f'{mode}: no other request logged its forwarded address'
    for line in held:
        fields = ACCESS_LINE.fullmatch(line)
        assert fields and (fields.group(4) != shadowed or fields.group(8) in uncopied_agents), (
            f'{mode}: a forwarded address beside a shadowed {what}: {line}')
    # The address the requests came from: on the ordinary line of a request
    # that was not copied, or on a line of nginx's error log (`client:`),
    # which names no request id. Never on any other line.
    ids = {m['request_id'] for m in shadow_lines(prefix)}
    assert ids, f'{mode}: no shadow line'
    peer = [line for line in proxy_lines(prefix) if base['peer'] in line]
    errors = 0
    for line in peer:
        fields = ACCESS_LINE.fullmatch(line)
        if fields:
            assert fields.group(4) != shadowed or fields.group(8) in uncopied_agents, (
                f'{mode}: the peer address beside a shadowed {what}: {line}')
            continue
        assert ERROR_LINE.match(line), f'{mode}: the peer address on a line of another kind: {line}'
        assert not ids & set(REQUEST_ID.findall(line)), f'{mode}: an error line names a request id: {line}'
        errors += 1
    assert len(peer) - errors >= len(held), (mode, len(peer), errors, len(held))
    print(f'ok {mode}: of {len(proxy_lines(prefix))} lines nginx wrote, the {len(held)} that hold a forwarded '
          f'address are all ordinary lines of requests that were not copied; the address the '
          f'requests came from is on {len(peer) - errors} such lines and on {errors} error-log lines, '
          f'which name no request id', flush=True)
    # Informational: how long the next request on the same connection waits.
    waits = hold(port, 30, route)
    print(f'info {mode}: next request on the same connection p50 {pct(waits, 50):.2f} ms, '
          f'p99 {pct(waits, 99):.2f} ms, max {max(waits):.2f} ms (n={len(waits)})', flush=True)


def pct(values, q):
    values = sorted(values)
    return values[min(len(values) - 1, max(0, int(round(q / 100 * len(values) + 0.5)) - 1))]


def hold(port, n, route=ROUTES['votesShadow']):
    """Posts on one keepalive connection, each followed by a GET on the same
    connection; returns the GETs' latencies in milliseconds. Spaced so that
    a route with a rate has every one of its posts copied."""
    connection = http.client.HTTPConnection('127.0.0.1', port, timeout=15)
    waits = []
    for _ in range(n):
        body = route['body'](uuid.uuid4().hex)
        connection.request('POST', route['path'], body=body,
                           headers={'Content-Type': route['content_type']})
        connection.getresponse().read()
        started = time.perf_counter()
        connection.request('GET', '/api/v3/testConnection')
        connection.getresponse().read()
        waits.append((time.perf_counter() - started) * 1000)
        if route['name'] == 'commentsShadow':
            time.sleep(1 / COMMENT_RATE)
    connection.close()
    return waits


def load(prefix, out, connections=16, votes=100, read=None):
    """`read`, when given, is a read path: each connection GETs it instead of
    posting a vote."""
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
                if read:
                    connection.request('GET', read + '?conversation_id=2fixture')
                else:
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


def read_load(prefix, out):
    """The participation-path test for a read: 16 keepalive connections of
    GET /api/v3/nextComment, each followed by a request on the same
    connection, as `load` does for votes."""
    load(prefix, out, read=READS['nextCommentShadow'])


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


def read(prefix, base_file):
    """GET and HEAD on the comment path with the comment shadow selected:
    the read every client polls shares the path's location with the POST. The
    reply, what Node receives and the access line are what they are with
    nothing selected, and nothing is copied or logged for the shadow."""
    route = ROUTES['commentsShadow']
    with open(base_file) as file:
        base = json.load(file)
    port = proxy_port(prefix)
    lines_before = len(shadow_lines(prefix))
    copies_before = len(records(prefix + '-shadow'))
    for method in ('GET', 'HEAD'):
        want = base['reads'][method]
        for _ in range(5):
            case = uuid.uuid4().hex
            status, headers, body = raw(port, method, route['path'] + '?conversation_id=2fixture',
                                        case_headers(case, route))
            assert status == want['status'] == 200, (method, status)
            assert body.decode() == want['body'], (method, body, want['body'])
            assert reply_headers(headers) == want['reply_headers'], (method, headers, want['reply_headers'])
            (seen,) = wait_for(lambda: find(records(prefix + '-node'), case), f'{method} at Node')
            assert not want['had_request_id'] and not header(seen, 'x-request-id'), (method, seen['headers'])
            assert normalized(seen['headers']) == want['headers'], (method, seen['headers'], want['headers'])
            assert [k for k, _ in seen['headers']] == [k for k, _ in want['headers']], (method, seen['headers'])
            fields = access_fields(prefix, case)
            assert (fields[0], fields[8]) == (base['peer'], FORWARDED_FOR), (method, fields)
            assert comparable(fields, case) == want['access'], (method, fields, want['access'])
    time.sleep(0.3)
    assert len(shadow_lines(prefix)) == lines_before, 'a read on the comment path wrote a shadow line'
    assert len(records(prefix + '-shadow')) == copies_before, 'a read on the comment path was copied'
    print('ok comment reads: GET and HEAD on the comment path answer the same status, headers and bytes as '
          'with nothing selected; Node receives the same headers in the same order and no request id; the '
          'access line is the ordinary one, with the path alone; nothing is copied and no shadow line is '
          'written (5 of each)', flush=True)


def rate(prefix):
    """The comment copies' rate, with both shadows selected and a shadow that
    answers: a run of comments faster than the rate is answered by Node, every
    one, while only as many copies as the rate allows reach the shadow; the
    others end in the copy's location with 429. Votes sent in the same run
    are all copied: the rate is the comment copies' alone."""
    comments, votes = ROUTES['commentsShadow'], ROUTES['votesShadow']
    port = proxy_port(prefix)
    time.sleep(COMMENT_BURST / COMMENT_RATE + 1)  # an empty bucket to start from
    total = 60
    sent = []
    lock = threading.Lock()

    def post(route):
        case = uuid.uuid4().hex
        body = route['body'](case)
        status, _, reply = raw(port, 'POST', route['path'], case_headers(case, route), body)
        with lock:
            sent.append((route['name'], case, status, reply.decode(),
                         f'node POST {route["path"]} {hashlib.sha256(body).hexdigest()}\n'))

    def run(first):
        # Every third request is a vote.
        for i in range(first, total, 4):
            post(comments if i % 3 else votes)

    started = time.perf_counter()
    threads = [threading.Thread(target=run, args=(first,)) for first in range(4)]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join()
    elapsed = time.perf_counter() - started
    # Every request, comment or vote, got Node's answer.
    assert len(sent) == total, len(sent)
    for name, case, status, reply, expected in sent:
        assert status == 200 and reply == expected, (name, status, reply)
    time.sleep(1.0)
    node, copied, lines = records(prefix + '-node'), records(prefix + '-shadow'), shadow_lines(prefix)
    counts = {'votesShadow': [0, 0], 'commentsShadow': [0, 0]}
    for name, case, _, _, _ in sent:
        seen = find(node, case)
        assert len(seen) == 1, f'Node received a {name} request {len(seen)} times'
        (request_id,) = header(seen[0], 'x-request-id')
        mirrors = [l for l in lines if l['request_id'] == request_id and l['message'] == 'shadow_mirror']
        edges = [l for l in lines if l['request_id'] == request_id and l['message'] == 'shadow_edge']
        assert len(mirrors) == 1 and len(edges) == 1 and edges[0]['edge_status'] == 200, (name, mirrors, edges)
        copies = find(copied, case)
        if mirrors[0]['mirror_status'] != 429:
            # Sent to the shadow, which answers 204 unless this box is too
            # busy for the copy's 30 ms; either way it was not held back.
            assert mirrors[0]['mirror_upstream_status'] != '', (name, mirrors)
            assert len(copies) == 1 or mirrors[0]['mirror_status'] != 204, (name, mirrors, copies)
            counts[name][0] += 1
        else:
            # Dropped by the rate: 429, no upstream contacted, no time spent.
            assert name == 'commentsShadow', f'a vote copy was dropped: {mirrors}'
            assert mirrors[0]['mirror_upstream_status'] == '', mirrors
            assert not copies and mirrors[0]['mirror_s'] < 0.02, (mirrors, copies)
            assert mirrors[0]['shadow'] == 'commentsShadow', mirrors
            # A dropped copy's request keeps the shadowed access line.
            fields = access_fields(prefix, case)
            assert (fields[0], fields[8]) == ('-', '-'), fields
            counts[name][1] += 1
    votes_sent = sum(1 for name, *_ in sent if name == 'votesShadow')
    comments_sent = total - votes_sent
    assert counts['votesShadow'] == [votes_sent, 0], counts
    passed, dropped = counts['commentsShadow']
    # The bucket lets COMMENT_BURST + 1 through at once and COMMENT_RATE a
    # second after that.
    most = COMMENT_BURST + 1 + int(COMMENT_RATE * elapsed) + 1
    assert COMMENT_BURST + 1 <= passed <= most, (passed, most, elapsed)
    assert dropped == comments_sent - passed and dropped >= 1, counts
    # The refusals are on the copy's own line only: nothing in the error log.
    limited = [line for line in proxy_lines(prefix) if 'limiting requests' in line or 'limit_req' in line]
    assert not limited, limited
    # Once the bucket has drained, comments are copied again.
    time.sleep(COMMENT_BURST / COMMENT_RATE + 1.5)
    case = uuid.uuid4().hex
    status, _, _ = raw(port, 'POST', comments['path'], case_headers(case, comments), comments['body'](case))
    assert status == 200
    wait_for(lambda: find(records(prefix + '-shadow'), case), 'a comment copy after the run')
    print(f'ok comment rate: {comments_sent} comments and {votes_sent} votes in {elapsed:.2f} s, every one '
          f'answered by Node with its exact bytes and received by Node once; {passed} comment copies reached '
          f'the shadow (at least {COMMENT_BURST + 1}, at most {most}) and {dropped} ended with 429 in the '
          f'copy\'s location, with no upstream and no error-log line; all {votes_sent} vote copies arrived; '
          f'after the bucket drained a comment was copied again', flush=True)


# One keepalive connection: how many comments it posts back to back, and the
# bounds on what a request waits for the copy of the request before it, in
# milliseconds. nginx's mirror keeps a request open until its copies have
# ended, so the next request on the same client connection waits for a copy
# that was sent: at most the copy's timeouts (20 ms to connect, 20 ms to send,
# 30 ms to read) when the shadow is silent. A copy over the rate ends at once,
# before any connection, and holds nothing. KEEPALIVE_QUICK is the most the
# median request may take where no copy can hold it (measured on a work box,
# three runs: 0.8 to 1.2 ms after a refused copy, 2.5 ms the slowest of 102);
# KEEPALIVE_HELD is the least the median request after a copy sent to a
# silent shadow may take (measured: 30 to 32 ms, 43 ms the slowest of 15). How
# long such a request may take at most is not a number of milliseconds: on a
# busy machine a copy lives longer than its timeouts add up to (measured with
# 14 cores at a load of 9 to 15: requests of 44 to 124 ms after six sent
# copies, and a median of 25 ms after copies an answering shadow was slow
# to answer). It is the time nginx itself logged for that copy (mirror_s)
# and KEEPALIVE_QUICK more: the next request waits for the copy and for
# nothing else.
KEEPALIVE_COMMENTS = 40
KEEPALIVE_QUICK = 10.0
KEEPALIVE_HELD = 15.0


def keepalive(prefix, state):
    """The comment copies' rate on ONE keepalive client connection, as a load
    balancer reuses a connection: KEEPALIVE_COMMENTS comments back to back.
    `state` is `unselected` (nothing selected: the control), `answering` or
    `silent` (both shadows selected, the shadow in that mode). Every comment
    is answered by Node with its exact bytes, on the same connection, and
    received by Node once. With the shadows selected, as many copies as the
    rate allows are sent and every other ends with 429 in the copy's own
    location, with no upstream. A request that follows a refused copy is not
    held by it; with a silent shadow, a request that follows a sent copy
    waits for that copy's timeout, and no other request waits."""
    route = ROUTES['commentsShadow']
    port = proxy_port(prefix)
    selected = state != 'unselected'
    time.sleep(COMMENT_BURST / COMMENT_RATE + 1)  # an empty bucket to start from
    connection = http.client.HTTPConnection('127.0.0.1', port, timeout=15)
    connection.connect()
    socket_used = connection.sock
    sent = []
    started = time.perf_counter()
    for _ in range(KEEPALIVE_COMMENTS):
        case = uuid.uuid4().hex
        body = route['body'](case)
        began = time.perf_counter()
        connection.request('POST', route['path'], body=body,
                           headers={'Content-Type': route['content_type'], 'X-Test-Case': case})
        response = connection.getresponse()
        reply = response.read()
        took = (time.perf_counter() - began) * 1000
        # The same connection throughout: nginx neither closed it nor asked to.
        assert connection.sock is socket_used and not response.will_close, 'the connection was not reused'
        assert response.status == 200 and reply.decode() == (
            f'node POST {route["path"]} {hashlib.sha256(body).hexdigest()}\n'), (state, response.status, reply)
        sent.append((case, took))
    elapsed = time.perf_counter() - started
    connection.close()
    time.sleep(1.0)
    node, copied, lines = records(prefix + '-node'), records(prefix + '-shadow'), shadow_lines(prefix)
    times = [took for _, took in sent]
    outcomes, lived = [], []
    for case, _ in sent:
        seen = find(node, case)
        assert len(seen) == 1, f'{state}: Node received a comment {len(seen)} times'
        if not selected:
            assert not header(seen[0], 'x-request-id'), seen[0]['headers']
            continue
        (request_id,) = header(seen[0], 'x-request-id')
        mirrors = [l for l in lines if l['request_id'] == request_id and l['message'] == 'shadow_mirror']
        edges = [l for l in lines if l['request_id'] == request_id and l['message'] == 'shadow_edge']
        assert len(mirrors) == 1 and len(edges) == 1 and edges[0]['edge_status'] == 200, (state, mirrors, edges)
        lived.append(mirrors[0]['mirror_s'] * 1000)
        if mirrors[0]['mirror_status'] == 429:
            # Refused by the rate in the copy's own location: no upstream
            # contacted, no time spent, nothing at the shadow.
            assert mirrors[0]['mirror_upstream_status'] == '' and mirrors[0]['mirror_s'] < 0.02, mirrors
            assert mirrors[0]['shadow'] == 'commentsShadow' and not find(copied, case), mirrors
            outcomes.append('refused')
        else:
            # Sent: the silent shadow never answers (504 at the copy's read
            # timeout); the answering one answers 204 unless this box is too
            # busy for the copy's 30 ms.
            assert mirrors[0]['mirror_upstream_status'] != '', mirrors
            assert state != 'silent' or mirrors[0]['mirror_status'] == MIRROR_STATUS['silent'], mirrors
            outcomes.append('sent')
    said = (f'{KEEPALIVE_COMMENTS} comments back to back on one keepalive connection in {elapsed * 1000:.0f} ms, '
            f'every one answered by Node with its exact bytes on that connection and received by Node once; '
            f'a request took a median of {statistics.median(times):.2f} ms, at most {max(times):.2f} ms')
    if not selected:
        assert statistics.median(times) <= KEEPALIVE_QUICK, times
        print(f'ok keepalive (nothing selected): {said}', flush=True)
        return
    passed, refused = outcomes.count('sent'), outcomes.count('refused')
    most = COMMENT_BURST + 1 + int(COMMENT_RATE * elapsed) + 1
    assert COMMENT_BURST + 1 <= passed <= most and refused == KEEPALIVE_COMMENTS - passed >= 1, (passed, most, refused)
    limited = [line for line in proxy_lines(prefix) if 'limiting requests' in line or 'limit_req' in line]
    assert not limited, limited
    # What each request waited, by the outcome of the copy of the request
    # before it on the connection.
    after = {'sent': [], 'refused': []}
    beyond = []
    for outcome, copy_lived, took in zip(outcomes, lived, times[1:]):
        after[outcome].append(took)
        if outcome == 'sent':
            # How much longer the request took than the copy before it lived.
            beyond.append(took - copy_lived)
    assert after['sent'] and after['refused'], outcomes
    quick = statistics.median(after['refused'])
    assert quick <= KEEPALIVE_QUICK, (
        f'{state}: a request after a refused copy took a median of {quick:.2f} ms: {after["refused"]}')
    held = statistics.median(after['sent'])
    waited = sum(1 for took in times if took >= KEEPALIVE_HELD)
    # A request after a sent copy waits for that copy, as long as nginx says
    # the copy lived, and for nothing else.
    over = statistics.median(beyond)
    assert over <= KEEPALIVE_QUICK, (
        f'{state}: a request after a sent copy took a median of {over:.2f} ms longer than the copy lived: '
        f'{after["sent"]} against {[copy_lived for outcome, copy_lived in zip(outcomes, lived) if outcome == "sent"]}')
    if state == 'silent':
        # The copy sent to a silent shadow ends at its read timeout, and the
        # next request on the connection waits for it; of the requests that
        # follow a refused copy, few take that long (none on a quiet machine).
        assert KEEPALIVE_HELD <= held, (
            f'silent: a request after a sent copy took a median of {held:.2f} ms: {after["sent"]}')
        slow = sum(1 for took in after['refused'] if took >= KEEPALIVE_HELD)
        assert slow <= len(after['refused']) // 4, (slow, after['refused'])
    print(f'ok keepalive (both shadows, the shadow {state}): {said}; {passed} copies were sent (at least '
          f'{COMMENT_BURST + 1}, at most {most}) and {refused} ended with 429 in the copy\'s location, with no '
          f'upstream and no error-log line; the request after a refused copy took a median of {quick:.2f} ms '
          f'(at most {max(after["refused"]):.2f} ms, n={len(after["refused"])}; bound {KEEPALIVE_QUICK:.0f} ms) '
          f'and the request after a sent copy a median of {held:.2f} ms (at most {max(after["sent"]):.2f} ms, '
          f'n={len(after["sent"])}), {over:.2f} ms longer than the copy before it lived by nginx\'s own line; '
          f'{waited} of the {KEEPALIVE_COMMENTS} requests took {KEEPALIVE_HELD:.0f} ms or more', flush=True)


# Comment bodies of every size class: a short comment, the longest text Node
# accepts as JSON writes it, each side of nginx's in-memory buffer, each side
# of the copy's bound, and the largest body nginx and Node's parser accept.
BODY_SIZES = (180, 3100, 6100, BODY_BUFFER, BODY_BUFFER + 1, 9000, 9999, 10000, BODY_IN_MEMORY,
              BODY_TO_FILE, 16385, 100000, 1024 * 1024, LARGEST_BODY)


def bodies(prefix, out, state):
    """Posts a comment body of each size and records what the client got and
    what Node received. `state` is `unselected` (nothing selected),
    `answering` (the shadow selected and answering: which bodies were copied
    is checked too) or the name of a mode in which the shadow service fails.
    The same bytes are sent in every run, so `same-bodies` can compare the
    replies byte for byte. With the shadow selected, a body of 1 to 9999
    declared bytes goes through the mirroring location (Node receives a
    request id) and any other is proxied as with nothing selected: no
    request id, no shadow line, streamed, and nothing written to a temporary
    file because of the mirror."""
    route = ROUTES['commentsShadow']
    selected, answering = state != 'unselected', state == 'answering'
    port = proxy_port(prefix)
    results = {}
    # label, size, parts, pause between parts, chunked
    plan = [(f'{size} bytes', size, 1, 0.0, False) for size in BODY_SIZES]
    plan += [('6100 bytes in two parts 0.5 s apart', 6100, 2, 0.5, False),
             ('9000 bytes in three parts 0.3 s apart', 9000, 3, 0.3, False),
             ('100000 bytes in four parts 0.2 s apart', 100000, 4, 0.2, False),
             ('6100 bytes chunked', 6100, 1, 0.0, True),
             ('100000 bytes chunked', 100000, 1, 0.0, True)]
    lines_before = len(shadow_lines(prefix))
    handed_over = 0
    for label, size, parts, pause, chunked in plan:
        if selected:
            time.sleep(1 / COMMENT_RATE)  # inside the copies' rate
        copyable = size <= COPIED_BODY and not chunked
        case = uuid.uuid4().hex
        body = sized_comment(size)
        started = time.perf_counter()
        status, headers, reply = raw(port, 'POST', route['path'], case_headers(case, route), body,
                                     parts=parts, pause=pause, chunked=chunked)
        seconds = time.perf_counter() - started
        digest = hashlib.sha256(body).hexdigest()
        assert status == 200 and reply.decode() == f'node POST {route["path"]} {digest}\n', (label, status, reply[:200])
        seen = wait_for(lambda: find(records(prefix + '-node'), case), f'{label} at Node', seconds=30)
        assert len(seen) == 1 and seen[0]['length'] == size and seen[0]['sha256'] == digest, (label, seen)
        results[label] = {'status': status, 'reply_headers': reply_headers(headers),
                          'reply': reply.decode(), 'seconds': seconds,
                          'node_headers': normalized(seen[0]['headers']),
                          'node_waited_for_body': seen[0]['at'] - seen[0]['head']}
        if selected and copyable:
            handed_over += 1
            (request_id,) = header(seen[0], 'x-request-id')
            assert HEX32.fullmatch(request_id), request_id
        else:
            # Not handed to the shadow's location: Node receives no request id.
            assert not header(seen[0], 'x-request-id'), (label, seen[0]['headers'])
        if not chunked and parts > 1 and not (selected and copyable):
            # A body of declared length that arrives in parts is streamed to
            # Node unless it is being copied: Node has the headers first.
            assert seen[0]['at'] - seen[0]['head'] >= pause * 0.6, (label, seen[0]['at'] - seen[0]['head'])
        if answering:
            time.sleep(0.3)
            copies = find(records(prefix + '-shadow'), case)
            if copyable:
                mirrors = [l for l in shadow_lines(prefix)
                           if l['request_id'] == request_id and l['message'] == 'shadow_mirror']
                assert len(mirrors) == 1, (label, mirrors)
                assert len(copies) == 1 and copies[0]['sha256'] == digest and copies[0]['length'] == size, (label, copies)
                assert mirrors[0]['mirror_status'] == 204 and mirrors[0]['mirror_upstream_status'] == '204', (label, mirrors)
            else:
                assert not copies, f'{label} was copied'
    # One byte over the largest body: nginx's own 413 either way, on the
    # request's headers alone, and Node is not called.
    before = len(records(prefix + '-node'))
    with socket.create_connection(('127.0.0.1', port), timeout=15) as client:
        client.sendall(('\r\n'.join([f'POST {route["path"]} HTTP/1.1', 'Host: localhost', 'Connection: close',
                                     f'Content-Type: {route["content_type"]}',
                                     f'Content-Length: {LARGEST_BODY + 1}']) + '\r\n\r\n').encode())
        response = http.client.HTTPResponse(client, method='POST')
        response.begin()
        status, headers, reply = response.status, [(k.lower(), v) for k, v in response.getheaders()], response.read()
    assert status == 413, status
    time.sleep(0.3)
    assert len(records(prefix + '-node')) == before, 'a body over the limit reached Node'
    results['one byte over the largest body'] = {'status': status, 'reply_headers': reply_headers(headers),
                                                 'reply': reply.decode()}
    # Two shadow lines (edge and copy) for each body handed to the shadow's
    # location, and none for any other.
    time.sleep(0.5)
    written = len(shadow_lines(prefix)) - lines_before
    assert written == 2 * handed_over, (state, written, handed_over)
    with open(out, 'w') as file:
        json.dump(results, file)
    temporary = [line for line in proxy_lines(prefix) if 'buffered to a temporary file' in line]
    # nginx streams a body of declared length to Node, with the shadow or
    # without; the bodies the mirror reads whole first are at most
    # COPIED_BODY bytes, which it holds in memory. So the mirror writes no
    # temporary file. A chunked body is read whole by nginx before it is
    # proxied whatever is selected (Node is reached over HTTP/1.0, which has
    # no chunked bodies), through a temporary file from BODY_TO_FILE: the
    # same number of files with nothing selected as with the shadow.
    assert all(size <= BODY_IN_MEMORY or size >= BODY_TO_FILE for _, size, _, _, _ in plan)
    expected = sum(1 for _, size, _, _, chunked in plan if chunked and size >= BODY_TO_FILE)
    assert len(temporary) == expected, (state, len(temporary), expected)
    said = {'unselected': 'nothing selected', 'answering': 'both shadows selected, the shadow answering'}.get(
        state, f'both shadows selected, the shadow in mode {state}')
    print(f'ok comment bodies ({said}): {len(plan)} bodies from '
          f'{BODY_SIZES[0]} bytes to {LARGEST_BODY} bytes, three of them sent in parts and two chunked, each '
          f'answered 200 with Node\'s exact bytes and received by Node once with the same length and digest'
          + (f'; the {handed_over} bodies of 1 to {COPIED_BODY} declared bytes went through the shadow\'s '
             f'location and every other reached Node with no request id and no shadow line' if selected else '')
          + ('; each of those was copied once with the same bytes, and no other was copied' if answering else '') +
          f'; one byte over the largest is nginx\'s 413 and never reaches Node; nginx wrote '
          f'{len(temporary)} body to a temporary file, the chunked one of 100000 bytes, as it does with '
          f'nothing selected', flush=True)


def same_bodies(control_file, shadow_file):
    with open(control_file) as file:
        control = json.load(file)
    with open(shadow_file) as file:
        shadow = json.load(file)
    assert set(control) == set(shadow), (sorted(control), sorted(shadow))
    for label in control:
        for key in ('status', 'reply_headers', 'reply', 'node_headers'):
            assert control[label].get(key) == shadow[label].get(key), (label, key, control[label].get(key),
                                                                       shadow[label].get(key))
    # The large body that arrives in parts is streamed to Node in both runs.
    slow = '100000 bytes in four parts 0.2 s apart'
    for run in (control, shadow):
        assert run[slow]['node_waited_for_body'] >= 0.3, (slow, run[slow]['node_waited_for_body'])
    print(f'ok comment bodies, with and without the shadow: for each of {len(control)} bodies the client got '
          f'the same status, the same reply headers and the same reply bytes, and Node received the same '
          f'headers but for the request id', flush=True)
    for label in control:
        if 'seconds' in control[label]:
            print(f'info {label}: {control[label]["seconds"] * 1000:.1f} ms with nothing selected, '
                  f'{shadow[label]["seconds"] * 1000:.1f} ms with the shadow; Node had the headers '
                  f'{control[label]["node_waited_for_body"] * 1000:.1f} ms and '
                  f'{shadow[label]["node_waited_for_body"] * 1000:.1f} ms before the last byte', flush=True)


# The client half of `measure`, run inside a container on the test network so
# that its clock is the stand-ins' clock: for each size, `count` comments on
# fresh connections to the proxy, each stamped with the time it was sent.
MEASURE_CLIENT = r'''
import http.client, json, socket, sys, time, uuid
plan = json.loads(sys.argv[1])
out = []
for size, count, parts, pause, gap in plan:
    body = b'{"txt":"' + b'x' * (size - 60) + b'","conversation_id":"2fixture","vote":0}'
    body += b' ' * (size - len(body))
    for _ in range(count):
        case = uuid.uuid4().hex
        head = ('POST /api/v3/comments HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n'
                'Content-Type: application/json; charset=UTF-8\r\nX-Test-Case: ' + case +
                '\r\nContent-Length: ' + str(len(body)) + '\r\n\r\n').encode()
        with socket.create_connection(('PROXY', 80), timeout=120) as client:
            sent = time.time()
            if parts > 1:
                piece = len(body) // parts
                client.sendall(head + body[:piece])
                for start in range(piece, len(body), piece):
                    time.sleep(pause)
                    client.sendall(body[start:start + piece])
            else:
                client.sendall(head + body)
            response = http.client.HTTPResponse(client, method='POST')
            response.begin()
            first = time.time()
            response.read()
            done = time.time()
        out.append({'size': size, 'parts': parts, 'case': case, 'sent': sent, 'first': first, 'done': done,
                    'status': response.status})
        time.sleep(gap)
print(json.dumps(out))
'''


def measure(prefix, network, image, out):
    """What the mirror costs a comment: for each body size, the time from the
    client's send to Node having the request's headers (Node's first byte),
    to Node having the whole body, and to the client having the whole reply.
    The client runs in a container on the test network, so all three clocks
    are one."""
    # size, count, parts, pause between parts, gap between requests
    plan = [(180, 100, 1, 0.0, 0.51), (3100, 100, 1, 0.0, 0.51), (6100, 100, 1, 0.0, 0.51),
            (9000, 100, 1, 0.0, 0.51), (9999, 100, 1, 0.0, 0.51), (10000, 100, 1, 0.0, 0.1),
            (100000, 50, 1, 0.0, 0.1), (LARGEST_BODY, 12, 1, 0.0, 0.5), (6100, 30, 2, 0.5, 0.51),
            (100000, 30, 4, 0.2, 0.1), (LARGEST_BODY, 6, 4, 0.5, 0.5)]
    script = MEASURE_CLIENT.replace('PROXY', prefix + '-proxy')
    results = json.loads(subprocess.check_output(
        ['docker', 'run', '--rm', '--network', network, image, 'python3', '-c', script, json.dumps(plan)],
        text=True))
    node = {header(entry, 'x-test-case')[0]: entry for entry in records(prefix + '-node')
            if header(entry, 'x-test-case')}
    summary = {}
    for size, count, parts, pause, _ in plan:
        rows = [r for r in results if r['size'] == size and r['parts'] == parts]
        assert len(rows) == count and all(r['status'] == 200 for r in rows), (size, len(rows))
        first, whole, total = [], [], []
        for row in rows:
            seen = node[row['case']]
            first.append((seen['head'] - row['sent']) * 1000)
            whole.append((seen['at'] - row['sent']) * 1000)
            total.append((row['done'] - row['sent']) * 1000)
        label = f'{size} bytes' + (f' in {parts} parts {pause} s apart' if parts > 1 else '')
        summary[label] = {'n': count, **{name: {'p50': statistics.median(values), 'p90': pct(values, 90),
                                                 'max': max(values)}
                                          for name, values in (('node_first_byte_ms', first),
                                                               ('node_whole_body_ms', whole),
                                                               ('client_total_ms', total))}}
    with open(out, 'w') as file:
        json.dump(summary, file)
    print(f'info measure {out}: ' + json.dumps(summary), flush=True)


def measured(control_file, shadow_file):
    with open(control_file) as file:
        control = json.load(file)
    with open(shadow_file) as file:
        shadow = json.load(file)
    for label in control:
        for name, said in (('node_first_byte_ms', 'first byte at Node'), ('node_whole_body_ms', 'whole body at Node'),
                           ('client_total_ms', 'the client\'s total')):
            c, s = control[label][name], shadow[label][name]
            print(f'info {label} (n={control[label]["n"]}), {said}: p50 {c["p50"]:.2f} ms without, {s["p50"]:.2f} ms '
                  f'with; p90 {c["p90"]:.2f} against {s["p90"]:.2f}; max {c["max"]:.2f} against {s["max"]:.2f}',
                  flush=True)


# The read shadows: a GET with no body on one of three paths is answered by
# Node and copied to the read shadow service (PREFIX-reads), at most
# READ_RATE copies a second for each path and READ_BURST more at once.
READS = {'votesReadShadow': '/api/v3/votes', 'commentsReadShadow': '/api/v3/comments',
         'nextCommentShadow': '/api/v3/nextComment'}
READ_RATE = 4
READ_BURST = 0
# Copied reads on one path are sent this far apart, inside the rate.
READ_SPACING = 1 / READ_RATE + 0.05
# What a participant's poll carries: its conversation and participant, and a
# key the read does not model, with escapes, a repeated key and a bare key.
READ_QUERIES = ('?conversation_id=2fixture&pid=3', '?conversation_id=2fixture&lang=en&xid=a%20b%2Fc+d&x=&x=%C3%A9&y',
                '', '?')


def read_headers(case, cookie=True):
    """A participation client's poll: a participant token, the session
    cookie a browser sends when it has one, the embed's frame as its
    Referer, and the load balancer's X-Forwarded-For chain."""
    return (['Accept: application/json', 'Authorization: Bearer stand-in-token', f'X-Test-Case: {case}',
             f'User-Agent: shadow-test/{case}', f'X-Forwarded-For: {FORWARDED_FOR}', f'Referer: {EMBED_REFERER}']
            + (['Cookie: token2=stand-in-cookie'] if cookie else []))


def uncopied_reads():
    """Requests on and beside the three read paths that no read shadow is
    sent a copy of. With the read shadows selected each must reach Node
    exactly as with nothing selected. label: (method, path, body, keywords of
    `raw`, extra headers)."""
    cases = {}
    for name, path in READS.items():
        cases.update({
            f'{name}: HEAD': ('HEAD', path + '?conversation_id=2fixture', b'', {}, []),
            f'{name}: a GET with Content-Length 0': ('GET', path + '?conversation_id=2fixture', b'', {'length': '0'}, []),
            f'{name}: a GET with a body': ('GET', path + '?conversation_id=2fixture', b'{}', {}, []),
            f'{name}: a chunked GET': ('GET', path + '?conversation_id=2fixture', b'{}', {'chunked': True}, []),
            f'{name}: POST': ('POST', path, b'{}', {}, []),
            f'{name}: PUT': ('PUT', path, b'{}', {}, []),
            f'{name}: OPTIONS': ('OPTIONS', path, b'', {}, []),
            f'{name}: a trailing slash': ('GET', path + '/?conversation_id=2fixture', b'', {}, []),
            f'{name}: a mixed-case path': ('GET', path.replace('/v3/', '/V3/') + '?conversation_id=2fixture', b'', {}, []),
        })
    for label, path in (('the personal vote list', '/api/v3/votes/me'), ('the featured participants', '/api/v3/votes/famous'),
                        ('a translation read', '/api/v3/comments/translations'), ('participationInit', '/api/v3/participationInit')):
        cases[label] = ('GET', path + '?conversation_id=2fixture', b'', {}, [])
    return cases


def send_uncopied_reads(prefix, port):
    seen_by, ids = {}, {}
    for label, (method, target, body, options, extra) in uncopied_reads().items():
        case = uuid.uuid4().hex
        status, headers, reply = raw(port, method, target, read_headers(case) + extra, body, **options)
        ids[label] = case
        (seen,) = wait_for(lambda: find(records(prefix + '-node'), case), f'{label} at Node')
        fields = access_fields(prefix, case)
        seen_by[label] = {'status': status, 'reply_headers': reply_headers(headers), 'reply': reply.decode(),
                          'node_headers': normalized(seen['headers']), 'node_path': seen['path'],
                          'node_request_id': header(seen, 'x-request-id'),
                          'node_body': [seen['length'], seen['sha256']],
                          'access': comparable(fields, case), 'access_addresses': [fields[0], fields[8]]}
    return seen_by, ids


def read_baseline(prefix, out):
    port = proxy_port(prefix)
    base = {'reads': {}}
    for name, path in READS.items():
        for query in READ_QUERIES:
            case = uuid.uuid4().hex
            status, headers, body = raw(port, 'GET', path + query, read_headers(case))
            assert status == 200, status
            (seen,) = wait_for(lambda: find(records(prefix + '-node'), case), f'baseline {name} at Node')
            assert not header(seen, 'x-request-id'), 'nothing selected: Node got a request id'
            fields = access_fields(prefix, case)
            assert fields[8] == FORWARDED_FOR and fields[0] != '-', fields
            base['peer'] = fields[0]
            base['reads'][f'{name} {query}'] = {
                'status': status, 'reply_headers': reply_headers(headers), 'body': body.decode(),
                'headers': normalized(seen['headers']), 'path': seen['path'], 'access': comparable(fields, case)}
    base['uncopied'], _ = send_uncopied_reads(prefix, port)
    with open(out, 'w') as file:
        json.dump(base, file)
    print(f'ok read baseline: Node\'s view of {len(base["reads"])} reads and {len(base["uncopied"])} uncopied '
          f'requests with nothing selected', flush=True)


def check_read(prefix, port, mode, base, name, query, client_id=None):
    """One copied read: the participant gets Node's answer to the byte; Node
    receives it once with the same headers in the same order and one nginx
    request id; the read shadow receives a copy of it, a GET on the same path
    with the same query string and headers and no body, under the same id;
    one edge line and one copy line; the shadowed access line."""
    path = READS[name]
    want = base['reads'][f'{name} {query}']
    time.sleep(READ_SPACING)
    case = uuid.uuid4().hex
    extra = [] if client_id is None else [f'X-Request-Id: {client_id}']
    started = time.perf_counter()
    status, headers, body = raw(port, 'GET', path + query, read_headers(case) + extra)
    took = (time.perf_counter() - started) * 1000
    assert status == want['status'] == 200, (mode, name, status)
    assert body.decode() == want['body'], (mode, name, query, body, want['body'])
    assert reply_headers(headers) == want['reply_headers'], (mode, name, headers, want['reply_headers'])
    seen = wait_for(lambda: find(records(prefix + '-node'), case), f'{mode}: {name} at Node')
    time.sleep(0.2)
    seen = find(records(prefix + '-node'), case)
    assert len(seen) == 1, f'{mode}: Node received the read {len(seen)} times'
    (seen,) = seen
    assert seen['path'] == want['path'] == path + query, (mode, seen['path'], want['path'])
    ids = header(seen, 'x-request-id')
    assert len(ids) == 1 and HEX32.fullmatch(ids[0]) and ids[0] != client_id, (mode, ids)
    assert normalized(seen['headers']) == want['headers'], (mode, seen['headers'], want['headers'])
    assert header(seen, 'x-forwarded-for') == [FORWARDED_FOR] and header(seen, 'referer') == [EMBED_REFERER]
    request_id = ids[0]
    if mode in RECORDING:
        copies = wait_for(lambda: find(records(prefix + '-reads'), case), f'{mode}: copy at the read shadow')
        time.sleep(0.2)
        copies = find(records(prefix + '-reads'), case)
        assert len(copies) == 1, f'{mode}: the read shadow received {len(copies)} copies'
        (copy,) = copies
        assert copy['method'] == 'GET', copy
        assert copy['path'] == path + ('' if query == '?' else query), (mode, query, copy['path'])
        assert copy['length'] == 0 and not header(copy, 'content-length') and not header(copy, 'transfer-encoding'), copy
        assert header(copy, 'x-request-id') == [request_id] and header(copy, 'x-polis-shadow') == [name], copy['headers']
        for field in ('authorization', 'cookie', 'host', 'x-forwarded-proto', 'referer', 'accept', 'user-agent',
                      'x-forwarded-for'):
            assert header(copy, field) == header(seen, field), (field, copy['headers'], seen['headers'])
    lines = wait_for(lambda: [l for l in shadow_lines(prefix) if l['request_id'] == request_id
                              and l['message'] == 'shadow_mirror'], f'{mode}: copy line')
    lines = [l for l in shadow_lines(prefix) if l['request_id'] == request_id]
    edges = [l for l in lines if l['message'] == 'shadow_edge']
    mirrors = [l for l in lines if l['message'] == 'shadow_mirror']
    assert len(edges) == 1 and len(mirrors) == 1, (mode, lines)
    assert set(edges[0]) == EDGE_KEYS and set(mirrors[0]) == MIRROR_KEYS, lines
    assert edges[0]['edge_status'] == 200 and edges[0]['route'] == f'GET {path}', edges
    assert mirrors[0]['shadow'] == name and mirrors[0]['mirror_status'] == MIRROR_STATUS[mode], (mode, mirrors)
    if mode == 'absent':
        assert mirrors[0]['mirror_upstream_status'] == '', mirrors
    else:
        assert mirrors[0]['mirror_upstream_status'] not in ('', '-'), mirrors
    fields = access_fields(prefix, case)
    assert (fields[0], fields[8]) == ('-', '-'), (mode, fields)
    assert comparable(fields, case) == want['access'], (mode, fields, want['access'])
    assert fields[3] == f'GET {path} HTTP/1.1' and fields[6] == EMBED_PAGE, (mode, fields)
    # No line nginx wrote that names this request holds an address, or
    # anything of the query string or of what the Referer carried after its
    # path. Three lines name it: the access line, the edge line, the copy line.
    named = [line for line in proxy_lines(prefix) if request_id in line or case in line]
    assert len(named) == 3, (mode, named)
    for line in named:
        for part in ADDRESSES + (base['peer'], '?', 'conversation_id', 'pid=', 'xid', 'x_name', 'A%20Name',
                                 '#top', 'stand-in-token', 'stand-in-cookie'):
            assert part not in line, f'{mode}: a line of a shadowed read holds {part}: {line}'
    return request_id, mirrors[0], took


def read_behaviour(prefix, mode, base_file):
    with open(base_file) as file:
        base = json.load(file)
    port = proxy_port(prefix)
    check_formats(prefix)
    for name in READS:
        for query in READ_QUERIES:
            check_read(prefix, port, mode, base, name, query)
        check_read(prefix, port, mode, base, name, READ_QUERIES[0], client_id='client-chosen-id')
    print(f'ok read {mode}: {len(READS) * (len(READ_QUERIES) + 1)} reads on the three paths, with a query string, '
          f'with an empty one, with none and with a client-sent request id: each participant got Node\'s exact '
          f'status, headers and bytes; Node got each once, with the same headers in the same order plus nginx\'s '
          f'own request id (a client\'s is replaced); one edge line and one copy line each '
          f'({MIRROR_STATUS[mode]})' + ('; the read shadow got each as a GET on the same path with the same query '
          'string and headers, no body and no Content-Length, under the same id' if mode in RECORDING else '') +
          '; the access line has no address and the path alone; no line naming the read holds an address, the '
          'query string, the Referer\'s query string, the token or the cookie', flush=True)
    read_unchanged(prefix, base_file, mode)
    before = len(records(prefix + '-node'))
    for name in READS:
        for method in ('GET', 'POST'):
            status, _, _ = raw(port, method, '/_polis_shadow/' + name, [], b'{}' if method == 'POST' else b'')
            assert status == 404, (mode, name, method, status)
    assert len(records(prefix + '-node')) == before, 'a direct request to a read copy location reached Node'
    print(f'ok read {mode}: a direct request to each read copy location is answered 404 and reaches nothing',
          flush=True)


def read_unchanged(prefix, base_file, mode='answer'):
    """Every request on and beside the three read paths that is not copied
    reaches Node once, exactly as with nothing selected: the same headers at
    Node, no request id, the same reply bytes, the ordinary access line with
    its addresses, no shadow line and no copy."""
    with open(base_file) as file:
        base = json.load(file)
    port = proxy_port(prefix)
    lines_before = len(shadow_lines(prefix))
    copies_before = len(records(prefix + '-reads'))
    seen_by, sent = send_uncopied_reads(prefix, port)
    time.sleep(0.5)
    node, copied = records(prefix + '-node'), records(prefix + '-reads')
    assert sorted(seen_by) == sorted(base['uncopied'])
    for label, case in sent.items():
        got, want = seen_by[label], base['uncopied'][label]
        assert len(find(node, case)) == 1, f'{mode}: Node received {label} {len(find(node, case))} times'
        assert not find(copied, case), f'{mode}: {label} was copied'
        for key in ('status', 'reply_headers', 'reply', 'node_headers', 'node_path', 'node_request_id', 'node_body',
                    'access'):
            assert got[key] == want[key], (mode, label, key, got[key], want[key])
        assert got['node_request_id'] == [], (mode, label, got['node_request_id'])
        assert got['access_addresses'] == [base['peer'], FORWARDED_FOR], (mode, label, got['access_addresses'])
    assert len(shadow_lines(prefix)) == lines_before, f'{mode}: an uncopied request wrote a shadow line'
    assert len(records(prefix + '-reads')) == copies_before, f'{mode}: an uncopied request was copied'
    print(f'ok read {mode}: {len(sent)} requests that are never copied (HEAD, a GET with Content-Length 0, with a '
          f'body, chunked, POST, PUT, OPTIONS, a trailing slash and a mixed-case path on each read path; the '
          f'personal vote list, the featured participants, a translation read, participationInit) reach Node once, '
          f'exactly as with nothing selected: the same headers at Node, no request id, the same reply bytes, the '
          f'ordinary access line with its addresses, no shadow line and no copy', flush=True)


def read_hold(prefix, mode):
    """A read's reply never waits for its copy. Each read on its own
    connection: the client has Node's whole reply while the copy is still
    alive (a silent or slow read shadow holds a copy until its 30 ms read
    timeout), and before nginx ends the request. Measured on the client's
    clock against the copy's lifetime on nginx's."""
    port = proxy_port(prefix)
    rows = []
    for _ in range(4):
        for name, path in READS.items():
            time.sleep(READ_SPACING)
            case = uuid.uuid4().hex
            started = time.perf_counter()
            with socket.create_connection(('127.0.0.1', port), timeout=15) as client:
                client.sendall((f'GET {path}?conversation_id=2fixture HTTP/1.1\r\nHost: localhost\r\n'
                                f'X-Test-Case: {case}\r\nUser-Agent: shadow-test/{case}\r\n\r\n').encode())
                response = http.client.HTTPResponse(client, method='GET')
                response.begin()
                reply = response.read()
                replied = (time.perf_counter() - started) * 1000
            assert response.status == 200 and reply.startswith(b'node GET '), (response.status, reply)
            (seen,) = wait_for(lambda: find(records(prefix + '-node'), case), 'the read at Node')
            (request_id,) = header(seen, 'x-request-id')
            (mirror,) = wait_for(lambda: [l for l in shadow_lines(prefix) if l['request_id'] == request_id
                                          and l['message'] == 'shadow_mirror'], 'the copy line')
            assert mirror['mirror_status'] == MIRROR_STATUS[mode], mirror
            rows.append((name, replied, mirror['mirror_s'] * 1000))
    replies = [replied for _, replied, _ in rows]
    lived = [copy for _, _, copy in rows]
    quick = statistics.median(replies)
    assert quick <= KEEPALIVE_QUICK, f'{mode}: a read took a median of {quick:.2f} ms: {rows}'
    if mode in ('silent', 'delay40', 'delay5s'):
        # The copy lived its read timeout; the reply was had long before.
        assert statistics.median(lived) >= KEEPALIVE_HELD, f'{mode}: the copies did not live: {rows}'
        early = sum(1 for _, replied, copy in rows if replied < copy)
        assert early >= len(rows) * 3 // 4, f'{mode}: the reply came after the copy ended too often: {rows}'
    print(f'ok read hold ({mode}): {len(rows)} reads, each on its own connection: the client had Node\'s whole '
          f'reply in a median of {quick:.2f} ms (at most {max(replies):.2f} ms; bound {KEEPALIVE_QUICK:.0f} ms) while '
          f'the copies lived a median of {statistics.median(lived):.2f} ms by nginx\'s own line', flush=True)


def read_rate(prefix):
    """The read copies' rate, with every shadow selected and the shadows
    answering: a run of reads faster than the rate is answered by Node, every
    one, while each path's copies reach the read shadow at most READ_RATE a
    second; the rest end in the copy's location with 429, no upstream and no
    error-log line. Votes and comments posted in the same run are copied as
    before: the read rate is the reads' alone."""
    port = proxy_port(prefix)
    time.sleep(1.5)
    total = 90
    sent = []
    lock = threading.Lock()

    def go(i):
        case = uuid.uuid4().hex
        if i % 9 == 0:
            route = ROUTES['votesShadow']
            body = route['body'](case)
            status, _, reply = raw(port, 'POST', route['path'], case_headers(case, route), body)
            expected = f'node POST {route["path"]} {hashlib.sha256(body).hexdigest()}\n'
            name = 'votesShadow'
        else:
            name = list(READS)[i % 3]
            path = READS[name] + '?conversation_id=2fixture'
            status, _, reply = raw(port, 'GET', path, read_headers(case, cookie=False))
            expected = f'node GET {path} {hashlib.sha256(b"").hexdigest()}\n'
        with lock:
            sent.append((name, case, status, reply.decode(), expected))

    def run(first):
        for i in range(first, total, 6):
            go(i)

    started = time.perf_counter()
    threads = [threading.Thread(target=run, args=(first,)) for first in range(6)]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join()
    elapsed = time.perf_counter() - started
    assert len(sent) == total
    for name, case, status, reply, expected in sent:
        assert status == 200 and reply == expected, (name, status, reply, expected)
    time.sleep(1.0)
    node, copied, lines = records(prefix + '-node'), records(prefix + '-reads'), shadow_lines(prefix)
    votes_copied = records(prefix + '-shadow')
    counts = {name: [0, 0] for name in list(READS) + ['votesShadow']}
    for name, case, _, _, _ in sent:
        seen = find(node, case)
        assert len(seen) == 1, f'Node received a {name} request {len(seen)} times'
        (request_id,) = header(seen[0], 'x-request-id')
        (mirror,) = [l for l in lines if l['request_id'] == request_id and l['message'] == 'shadow_mirror']
        assert mirror['shadow'] == name, mirror
        if mirror['mirror_status'] == 429:
            assert name != 'votesShadow', f'a vote copy was dropped: {mirror}'
            assert mirror['mirror_upstream_status'] == '' and mirror['mirror_s'] < 0.02, mirror
            assert not find(copied, case), mirror
            counts[name][1] += 1
        else:
            assert mirror['mirror_upstream_status'] != '', mirror
            assert mirror['mirror_status'] != 204 or len(find(votes_copied if name == 'votesShadow' else copied, case)) == 1
            counts[name][0] += 1
    most = READ_BURST + 1 + int(READ_RATE * elapsed) + 1
    for name in READS:
        passed, dropped = counts[name]
        assert 1 <= passed <= most and dropped >= 1, (name, counts, most, elapsed)
    assert counts['votesShadow'][1] == 0 and counts['votesShadow'][0] >= 1, counts
    limited = [line for line in proxy_lines(prefix) if 'limiting requests' in line or 'limit_req' in line]
    assert not limited, limited
    print(f'ok read rate: {total} requests in {elapsed:.2f} s ({sum(sum(c) for n, c in counts.items() if n in READS)} '
          f'reads on the three paths, {sum(counts["votesShadow"])} votes), every one answered by Node with its exact '
          f'bytes and received by Node once; copies reached the read shadow '
          + ', '.join(f'{name} {counts[name][0]}' for name in READS)
          + f' (at most {most} each) and the rest ended with 429 in the copy\'s location, with no upstream and no '
          f'error-log line; every vote copy arrived', flush=True)


def read_beside(prefix, mode, read_base, vote_base, comment_base):
    """Every shadow selected, the write shadows' service answering and the
    read shadow service in MODE: each read is copied to the read shadow
    service alone and each vote and comment to the write shadows' service
    alone, each answered by Node exactly as with nothing selected."""
    with open(read_base) as file:
        reads = json.load(file)
    port = proxy_port(prefix)
    check_formats(prefix)
    for name in READS:
        check_read(prefix, port, mode, reads, name, READ_QUERIES[0])
    for shadow, base_file in (('votesShadow', vote_base), ('commentsShadow', comment_base)):
        with open(base_file) as file:
            base = json.load(file)
        time.sleep(1 / COMMENT_RATE)
        request_id, _ = check_post(prefix, port, 'answer', base, ROUTES[shadow])
        assert not [c for c in records(prefix + '-reads') if header(c, 'x-request-id') == [request_id]], (
            f'a {shadow} copy reached the read shadow service')
    for copy in records(prefix + '-shadow'):
        assert copy['method'] == 'POST', f'a read copy reached the write shadows\' service: {copy}'
    for copy in records(prefix + '-reads'):
        assert copy['method'] == 'GET' and copy['path'].split('?')[0] in READS.values(), copy
    print(f'ok every shadow selected, the read shadow {mode}: each of the three reads went to the read shadow '
          f'service and nowhere else, each vote and comment to the write shadows\' service and nowhere else, '
          f'and Node answered every one exactly as with nothing selected', flush=True)


READ_KEEPALIVE_READS = 30


def read_keepalive(prefix, state):
    """The read rate on ONE keepalive client connection, as a load balancer
    reuses one: READ_KEEPALIVE_READS reads of one path back to back. `state`
    is `unselected` (the control), `answering` or `silent` (the read shadows
    selected, the read shadow in that mode). Every read is answered by Node
    with its exact bytes on that connection. A request after a refused copy is
    not held by it; after a copy sent to a silent read shadow it waits for
    that copy, as long as nginx says the copy lived, and for nothing else."""
    port = proxy_port(prefix)
    selected = state != 'unselected'
    path = READS['nextCommentShadow'] + '?conversation_id=2fixture'
    time.sleep(1.0)
    connection = http.client.HTTPConnection('127.0.0.1', port, timeout=15)
    connection.connect()
    socket_used = connection.sock
    sent = []
    started = time.perf_counter()
    for _ in range(READ_KEEPALIVE_READS):
        case = uuid.uuid4().hex
        began = time.perf_counter()
        connection.request('GET', path, headers={'X-Test-Case': case})
        response = connection.getresponse()
        reply = response.read()
        took = (time.perf_counter() - began) * 1000
        assert connection.sock is socket_used and not response.will_close, 'the connection was not reused'
        assert response.status == 200 and reply.decode() == f'node GET {path} {hashlib.sha256(b"").hexdigest()}\n'
        sent.append((case, took))
    elapsed = time.perf_counter() - started
    connection.close()
    time.sleep(1.0)
    node, lines = records(prefix + '-node'), shadow_lines(prefix)
    times = [took for _, took in sent]
    said = (f'{READ_KEEPALIVE_READS} reads back to back on one keepalive connection in {elapsed * 1000:.0f} ms, each '
            f'answered by Node with its exact bytes; a read took a median of {statistics.median(times):.2f} ms, at '
            f'most {max(times):.2f} ms')
    if not selected:
        for case, _ in sent:
            (seen,) = find(node, case)
            assert not header(seen, 'x-request-id'), seen['headers']
        assert statistics.median(times) <= KEEPALIVE_QUICK, times
        print(f'ok read keepalive (nothing selected): {said}', flush=True)
        return
    outcomes, lived = [], []
    for case, _ in sent:
        (seen,) = find(node, case)
        (request_id,) = header(seen, 'x-request-id')
        (mirror,) = [l for l in lines if l['request_id'] == request_id and l['message'] == 'shadow_mirror']
        lived.append(mirror['mirror_s'] * 1000)
        if mirror['mirror_status'] == 429:
            assert mirror['mirror_upstream_status'] == '' and mirror['mirror_s'] < 0.02, mirror
            outcomes.append('refused')
        else:
            assert state != 'silent' or mirror['mirror_status'] == MIRROR_STATUS['silent'], mirror
            outcomes.append('sent')
    passed, refused = outcomes.count('sent'), outcomes.count('refused')
    most = READ_BURST + 1 + int(READ_RATE * elapsed) + 1
    assert 1 <= passed <= most and refused >= 1, (passed, refused, most)
    after = {'sent': [], 'refused': []}
    beyond = []
    for outcome, copy_lived, took in zip(outcomes, lived, times[1:]):
        after[outcome].append(took)
        if outcome == 'sent':
            beyond.append(took - copy_lived)
    assert after['refused'], outcomes
    quick = statistics.median(after['refused'])
    assert quick <= KEEPALIVE_QUICK, f'{state}: a read after a refused copy took a median of {quick:.2f} ms'
    if beyond:
        over = statistics.median(beyond)
        assert over <= KEEPALIVE_QUICK, f'{state}: a read after a sent copy took {over:.2f} ms longer than it lived'
    if state == 'silent' and after['sent']:
        assert statistics.median(after['sent']) >= KEEPALIVE_HELD, after['sent']
    print(f'ok read keepalive (the read shadows selected, the read shadow {state}): {said}; {passed} copies were '
          f'sent (at most {most}) and {refused} ended with 429 in the copy\'s location; the read after a refused copy '
          f'took a median of {quick:.2f} ms (bound {KEEPALIVE_QUICK:.0f} ms)'
          + (f', the read after a sent copy a median of {statistics.median(after["sent"]):.2f} ms' if after['sent'] else ''),
          flush=True)


if __name__ == '__main__':
    command, *args = sys.argv[1:]
    {'baseline': baseline, 'behaviour': behaviour, 'load': load, 'compare': compare, 'read': read,
     'rate': rate, 'keepalive': keepalive, 'bodies': bodies, 'same-bodies': same_bodies, 'measure': measure,
     'measured': measured, 'read-baseline': read_baseline, 'read-behaviour': read_behaviour,
     'read-hold': read_hold, 'read-rate': read_rate, 'read-keepalive': read_keepalive,
     'read-unchanged': read_unchanged, 'read-beside': read_beside, 'read-load': read_load}[command](*args)
