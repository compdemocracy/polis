#!/usr/bin/env python3
"""The ordinary access line behind the production nginx image, driven by
queue-rs/polis-api/conformance/nginx-routing.sh against its stub upstreams.

  test-access-log.py PREFIX

PREFIX-proxy is nginx, with port 80 published on loopback. Every request
answers from a stub, so nginx writes no error-log line for it.

The line is the image's `main` format, field for field, with the request line
written without its query string and the Referer without its query string and
fragment. A request carrying an external id, a name and a participant number
in its query string and in its Referer leaves a line with none of them, and
nothing else nginx writes for it holds them either. The address fields stay.
"""
import re
import socket
import subprocess
import sys
import time
import uuid

# The access line: peer, user, time, request line, status, bytes, Referer,
# User-Agent, X-Forwarded-For.
ACCESS_LINE = re.compile(r'(\S+) - (\S+) \[([^\]]+)\] "([^"]*)" (\d{3}) (\d+) "([^"]*)" "([^"]*)" "([^"]*)"')
LOG_FORMAT = re.compile(r"log_format\s+(\S+)\s+(?:escape=\S+\s+)?((?:'[^']*'\s*)+);")
# Values no line may hold: what an embedding site supplies about a person,
# and a participant number an older client puts in a query string. None is a
# real value.
XID = 'xid-marker-7f3a9c'
NAME = 'name-marker-b41e55'
IMAGE = 'image-marker-0d9e21'
PARENT = 'parent-marker-63c0aa'
PID = '918273645'
SECRETS = (XID, NAME, IMAGE, PARENT, PID)
IDENTITY = (f'xid={XID}&x_name={NAME}&x_profile_image_url=https%3A%2F%2Fembedder.example%2F{IMAGE}.png'
            f'&parent_url=https%3A%2F%2Fembedder.example%2F{PARENT}&pid={PID}')
# The X-Forwarded-For chain a load balancer in front of nginx sends: the
# participant's address, then the edge's. Both are documentation addresses.
FORWARDED_FOR = '203.0.113.77, 198.51.100.9'
# Variables that hold a query string, or a request line or Referer whole.
WHOLE = ('$request ', '$request"', '$request_uri', '$args', '$query_string', '$is_args', '$arg_',
         '$http_referer', '$uri')

prefix = sys.argv[1]
proxy = prefix + '-proxy'


def docker(*args):
    return subprocess.check_output(['docker', *args], text=True, stderr=subprocess.STDOUT)


def port():
    host, number = docker('port', proxy, '80/tcp').strip().splitlines()[0].rsplit(':', 1)
    assert host == '127.0.0.1', f'the test proxy must bind loopback only: {host}'
    return int(number)


PORT = port()


def send(head, body=b''):
    """One request, written as given, on its own connection. Returns the
    reply's status line."""
    with socket.create_connection(('127.0.0.1', PORT), timeout=10) as client:
        client.sendall(head.encode('latin-1') + body)
        reply = b''
        while True:
            chunk = client.recv(65536)
            if not chunk:
                break
            reply += chunk
    return reply.split(b'\r\n', 1)[0].decode('latin-1')


def lines():
    return docker('logs', proxy).splitlines()


def request(method, target, referer=None, body=b'', version='1.1', forwarded=True):
    """Sends one request and returns the fields of the one access line nginx
    wrote for it, found by its User-Agent. A tuple of Referers sends the
    header once for each, in order."""
    case = uuid.uuid4().hex
    head = f'{method} {target} HTTP/{version}\r\nHost: localhost\r\nUser-Agent: access-log-test/{case}\r\n'
    if forwarded:
        head += f'X-Forwarded-For: {FORWARDED_FOR}\r\n'
    if referer is not None:
        for one in referer if isinstance(referer, tuple) else (referer,):
            head += f'Referer: {one}\r\n'
    if body:
        head += f'Content-Type: application/json\r\nContent-Length: {len(body)}\r\n'
    status = send(head + 'Connection: close\r\n\r\n', body)
    for _ in range(100):
        found = [line for line in lines() if f'access-log-test/{case}' in line]
        if found:
            break
        time.sleep(0.05)
    assert len(found) == 1, f'{len(found)} lines for {method} {target}: {found}'
    fields = ACCESS_LINE.fullmatch(found[0])
    assert fields, f'not an access line: {found[0]}'
    return status, fields.groups()


def formats(path):
    text = docker('exec', proxy, 'cat', path)
    return {name: ''.join(re.findall(r"'([^']*)'", pieces)) for name, pieces in LOG_FORMAT.findall(text)}


def check_configuration():
    """The ordinary format is `main` with its request line and its Referer
    replaced, and nothing else; the server writes it; and no format nginx
    writes reads a query string, or a request line or a Referer whole."""
    main = formats('/etc/nginx/nginx.conf')['main']
    assert main.count('"$request"') == 1 and main.count('"$http_referer"') == 1, main
    site = formats('/etc/nginx/conf.d/default.conf')
    assert set(site) == {'polis_access'}, sorted(site)
    expected = (main.replace('"$request"', '"$request_method $polis_log_path $server_protocol"')
                .replace('"$http_referer"', '"$polis_log_referer"'))
    assert site['polis_access'] == expected, (site['polis_access'], main)
    whole = docker('exec', proxy, 'nginx', '-T')
    written = re.findall(r'^\s*access_log\s+(\S+)\s+(\S+);', whole, re.M)
    assert ('/var/log/nginx/access.log', 'polis_access') in written, written
    # `main` is named once, by the image's own http block, and the server's
    # directive replaces it for every request.
    assert [name for _, name in written].count('main') == 1, written
    server = whole[whole.index('server {'):]
    assert re.search(r'^\s*access_log\s+/var/log/nginx/access\.log\s+polis_access;', server, re.M), 'the server block'
    assert not re.search(r'^\s*access_log\s+\S+\s+main;', server, re.M), 'a location writes `main`'
    for name, text in {**site, **formats('/etc/nginx/rust-api/upstreams.conf')}.items():
        for variable in WHOLE:
            # shadow_edge names its route by the path alone ($uri).
            if variable == '$uri' and name == 'polis_shadow_edge':
                assert '"route":"$request_method $uri"' in text, text
                continue
            assert variable not in text + ' ', f'{name} reads {variable.strip()}'
    print('ok the ordinary access format is `main` with the request line and the Referer cut down; '
          'the server writes it and no location writes `main`; no format nginx writes reads a query '
          'string, a whole request line or a whole Referer', flush=True)


def check_identity():
    """Requests that carry what an embed carries: none of it reaches a line."""
    before = len(lines())
    cases = [
        # (method, target, Referer, body, the request line, the Referer written)
        ('GET', f'/api/v3/participationInit?conversation_id=2fixture&lang=en-US&{IDENTITY}',
         f'https://pol.is/2fixture?{IDENTITY}', b'',
         'GET /api/v3/participationInit HTTP/1.1', 'https://pol.is/2fixture'),
        ('GET', f'/api/v3/nextComment?conversation_id=2fixture&not_voted_by_pid={PID}&{IDENTITY}',
         f'https://pol.is/2fixture?{IDENTITY}', b'',
         'GET /api/v3/nextComment HTTP/1.1', 'https://pol.is/2fixture'),
        ('POST', f'/api/v3/votes?{IDENTITY}', f'https://pol.is/alpha/2fixture?{IDENTITY}', b'{"vote":0}',
         'POST /api/v3/votes HTTP/1.1', 'https://pol.is/alpha/2fixture'),
        ('POST', f'/api/v3/comments?{IDENTITY}', f'https://pol.is/2fixture?{IDENTITY}#{XID}', b'{"txt":"x"}',
         'POST /api/v3/comments HTTP/1.1', 'https://pol.is/2fixture'),
        # The conversation page itself, as an embed's frame loads it.
        ('GET', f'/2fixture?{IDENTITY}', f'https://embedder.example/a/page?user={NAME}#{XID}', b'',
         'GET /2fixture HTTP/1.1', 'https://embedder.example/a/page'),
        # A location that rewrites the path: the line keeps the path as sent.
        ('GET', f'/alpha/2fixture?{IDENTITY}', f'https://embedder.example/?{IDENTITY}', b'',
         'GET /alpha/2fixture HTTP/1.1', 'https://embedder.example/'),
        # A path nginx answers itself.
        ('GET', f'/no-such-path-anywhere?{IDENTITY}', f'https://pol.is/2fixture?{IDENTITY}', b'',
         'GET /no-such-path-anywhere HTTP/1.1', 'https://pol.is/2fixture'),
        ('HEAD', f'/api/v3/conversations?{IDENTITY}', f'https://pol.is/2fixture?{IDENTITY}', b'',
         'HEAD /api/v3/conversations HTTP/1.1', 'https://pol.is/2fixture'),
    ]
    for method, target, referer, body, request_line, written in cases:
        status, fields = request(method, target, referer, body)
        assert fields[3] == request_line, (target, fields)
        assert fields[6] == written, (referer, fields)
        # The address fields are `main`'s: the peer, and the chain as sent.
        assert fields[0] != '-' and re.search(r'\d', fields[0]), fields
        assert fields[8] == FORWARDED_FOR, fields
        assert fields[4] == status.split()[1], (status, fields)
    # Nothing nginx wrote while these ran, on either stream, holds any of it.
    after = lines()[before:]
    assert len(after) >= len(cases), after
    for line in after:
        for secret in SECRETS:
            assert secret not in line, f'a line holds {secret}: {line}'
        assert '?' not in line, f'a line holds a query string: {line}'
    print(f'ok {len(cases)} requests carrying an external id, a name, an image address, the embedding page and '
          f'a participant number in the query string and in the Referer: each access line has the path alone '
          f'and the Referer up to its path, both address fields as sent, and none of the {len(after)} lines '
          f'nginx wrote holds any of them or a "?"', flush=True)


def check_request_lines():
    """What the request-line field holds for each shape of request."""
    cases = [
        ('GET', '/api/v3/testConnection', '1.1', 'GET /api/v3/testConnection HTTP/1.1'),
        ('GET', '/api/v3/testConnection?', '1.1', 'GET /api/v3/testConnection HTTP/1.1'),
        ('GET', f'/api/v3/testConnection?a=1?xid={XID}?b', '1.1', 'GET /api/v3/testConnection HTTP/1.1'),
        ('GET', f'/api/v3/testConnection?xid={XID}', '1.0', 'GET /api/v3/testConnection HTTP/1.0'),
        # An encoded "?" is part of the path, and stays as it was sent.
        ('GET', '/api/v3/test%3FConnection', '1.1', 'GET /api/v3/test%3FConnection HTTP/1.1'),
        ('GET', f'/api/v3/a%20b/c?xid={XID}', '1.1', 'GET /api/v3/a%20b/c HTTP/1.1'),
        # The absolute form of a request line: the path is still the path.
        ('GET', f'http://localhost/api/v3/testConnection?xid={XID}', '1.1', 'GET /api/v3/testConnection HTTP/1.1'),
        ('OPTIONS', f'/api/v3/votes?xid={XID}', '1.1', 'OPTIONS /api/v3/votes HTTP/1.1'),
    ]
    for method, target, version, request_line in cases:
        _, fields = request(method, target, version=version)
        assert fields[3] == request_line, (target, fields)
        assert fields[6] == '-', fields
    # Request lines nginx refuses before it has read a header, so each line
    # is found by its place in the log: a space in the path (400), bytes that
    # are no request (400), a request line longer than nginx's buffer for one
    # (414, by its query string and by its path), and a protocol nginx does
    # not speak (505). None is written as it arrived.
    refused = [
        (f'GET /api/v3/a b?xid={XID} HTTP/1.1\r\nHost: localhost\r\n\r\n', '400', UNREADABLE),
        (f'\x16\x03\x01\x02\x00\x01 xid={XID}\r\n\r\n', '400', UNREADABLE),
        (f'GET /api/v3/a?xid={XID}&q=' + 'q' * 9000 + ' HTTP/1.1\r\nHost: localhost\r\n\r\n', '414', UNREADABLE),
        (f'GET /{XID}' + 'p' * 9000 + ' HTTP/1.1\r\nHost: localhost\r\n\r\n', '414', UNREADABLE),
        (f'GET /api/v3/a?xid={XID} HTTP/9.9\r\nHost: localhost\r\n\r\n', '505', None),
    ]
    for head, code, request_line in refused:
        before = len(lines())
        status = send(head)
        assert status.split()[1] == code, (status, head[:60])
        for _ in range(100):
            new = [line for line in lines()[before:] if ACCESS_LINE.fullmatch(line)]
            if new:
                break
            time.sleep(0.05)
        assert len(new) == 1, new
        fields = ACCESS_LINE.fullmatch(new[0]).groups()
        assert fields[4] == code, fields
        assert request_line is None or fields[3] == request_line, fields
        for line in lines()[before:]:
            assert XID not in line and '?' not in line and 'qqq' not in line and 'ppp' not in line, (
                f'a refused request line was written: {line[:300]}')
    print(f'ok the request-line field: the path as sent up to the first "?", an encoded "?" kept, the absolute '
          f'form reduced to its path, the protocol kept; {len(refused)} request lines nginx refuses before it '
          f'reads a header (400, 414, 505) are never written as they arrived: "{UNREADABLE}" for the ones it '
          f'cannot read or that are longer than its buffer', flush=True)


# What the request-line field holds when nginx could not read the request
# line, or refused it for its length: no method, no path, no protocol.
UNREADABLE = '- - -'

LONG_PATH = '/' + 'a' * 6000
REFERERS = [
    # (what is sent, what is written)
    (None, '-'),
    ('', '-'),
    ('https://pol.is/2fixture', 'https://pol.is/2fixture'),
    ('https://pol.is', 'https://pol.is'),
    ('https://pol.is/', 'https://pol.is/'),
    # A query string.
    (f'https://pol.is/2fixture?xid={XID}&x_name={NAME}', 'https://pol.is/2fixture'),
    (f'https://pol.is?xid={XID}', 'https://pol.is'),
    ('https://pol.is/2fixture?', 'https://pol.is/2fixture'),
    # A fragment, alone, after a query string, and before a "?".
    (f'https://pol.is/2fixture#{XID}', 'https://pol.is/2fixture'),
    (f'https://pol.is/2fixture?a=1#{XID}', 'https://pol.is/2fixture'),
    (f'https://pol.is/2fixture#a?xid={XID}', 'https://pol.is/2fixture'),
    # More than one "?": everything from the first is dropped.
    (f'https://pol.is/2fixture?a=1?xid={XID}?x_name={NAME}', 'https://pol.is/2fixture'),
    (f'https://pol.is/m/2fixture/comments??xid={XID}', 'https://pol.is/m/2fixture/comments'),
    # A port, a bracketed address, an encoded path, an app's address.
    (f'https://pol.is:8443/2fixture?xid={XID}', 'https://pol.is:8443/2fixture'),
    (f'http://[2001:db8::1]:8080/2fixture?xid={XID}', 'http://[2001:db8::1]:8080/2fixture'),
    (f'https://embedder.example/a%20page/%E2%9C%93;v=1/x,y|z?user={NAME}', 'https://embedder.example/a%20page/%E2%9C%93;v=1/x,y|z'),
    ('android-app://com.example.reader/', 'android-app://com.example.reader/'),
    (f'HTTPS://POL.IS/2fixture?xid={XID}', 'HTTPS://POL.IS/2fixture'),
    # A single quote, which browsers leave unencoded in a path, is kept; the
    # field is written between double quotes, which a path never holds.
    (f"https://embedder.example/town's-hall/2fixture?xid={XID}", "https://embedder.example/town's-hall/2fixture"),
    # A very long one: a long query string is dropped whole, and a long path
    # is kept whole, as a request's own long path is.
    ('https://pol.is/2fixture?' + f'xid={XID}&' * 100 + 'q=' + 'q' * 3000, 'https://pol.is/2fixture'),
    (f'https://pol.is{LONG_PATH}?xid={XID}', f'https://pol.is{LONG_PATH}'),
    # Not an address, or not one nginx keeps: never written as it arrived.
    (f'{XID}', 'unparsed'),
    (f'see {XID} for details', 'unparsed'),
    (f'?xid={XID}', 'unparsed'),
    (f'//pol.is/2fixture?xid={XID}', 'unparsed'),
    (f'https:/pol.is/{XID}', 'unparsed'),
    (f'javascript:alert("{XID}")', 'unparsed'),
    (f'data:text/plain,{XID}', 'unparsed'),
    (f'ftp://pol.is/{XID}', 'unparsed'),
    (f'https://{XID}:{NAME}@pol.is/2fixture', 'unparsed'),
    (f'https://{XID}@pol.is/2fixture', 'unparsed'),
    (f'https://pol.is/a {XID}', 'unparsed'),
    (f'https://pol.is/a"{XID}', 'unparsed'),
    (f'https://pol.is/a`{XID}', 'unparsed'),
    (f'https://pol.is/a\\{XID}', 'unparsed'),
    (f'https://pol.is/<{XID}>', 'unparsed'),
    (f'https://pol.is/{{{XID}}}', 'unparsed'),
    (f'https://pol.is/café/{XID}', 'unparsed'),
    # A control character in the path: a tab, a byte below the space, DEL.
    (f'https://pol.is/a\t{XID}', 'unparsed'),
    (f'https://pol.is/a\x01{XID}', 'unparsed'),
    (f'https://pol.is/a\x7f{XID}', 'unparsed'),
    # The header sent twice: nginx reads the first, and the second is never
    # written, whatever it holds.
    (('https://pol.is/2fixture', f'https://pol.is/{XID}?xid={XID}'), 'https://pol.is/2fixture'),
    ((f'https://pol.is/2fixture?xid={XID}', f'see {XID}'), 'https://pol.is/2fixture'),
    (f'https://pol.is:port/{XID}', 'unparsed'),
    (f'https://pol.is/2fixture https://pol.is/{XID}', 'unparsed'),
]


def check_referers():
    """What the Referer field holds for each shape of Referer."""
    before = len(lines())
    for sent, written in REFERERS:
        _, fields = request('GET', '/api/v3/testConnection', sent)
        shown = sent if sent is None or len(sent) < 100 else sent[:60] + '...'
        assert fields[6] == written, (shown, fields[6][:200])
        assert fields[3] == 'GET /api/v3/testConnection HTTP/1.1', fields
    # A header line longer than nginx's buffer for one (8 kB): nginx answers
    # 400 itself and has no Referer to write.
    status, fields = request('GET', '/api/v3/testConnection', f'https://pol.is/2fixture?xid={XID}&q=' + 'q' * 9000)
    assert status.split()[1] == '400' and fields[4] == '400', (status, fields[:6])
    assert fields[6] == '-', fields[6][:200]
    for line in lines()[before:]:
        for secret in SECRETS:
            assert secret not in line, f'a line holds {secret}: {line[:400]}'
    unparsed = sum(1 for _, written in REFERERS if written == 'unparsed')
    print(f'ok the Referer field, {len(REFERERS)} shapes: no Referer is written "-"; an address is written up to its path, '
          f'without its query string and fragment, however many "?" it has and however long it is (a query '
          f'string of 5,000 bytes dropped, a path of 6,000 kept); {unparsed} that are not an address nginx '
          f'keeps are written "unparsed", never as sent; one longer than nginx\'s 8 kB header buffer is '
          f'refused with 400 and written "-"', flush=True)


check_configuration()
check_identity()
check_request_lines()
check_referers()
