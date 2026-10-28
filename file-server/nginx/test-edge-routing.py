#!/usr/bin/env python3
"""Called by the nginx conformance harness, using its isolated containers."""
import http.client
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import time

prefix, routes, root = sys.argv[1:]
root = Path(root)


def docker(*args):
    return subprocess.check_output(['docker', *args], text=True, stderr=subprocess.STDOUT)


def port(container, number):
    address = docker('port', container, f'{number}/tcp').strip()
    host, number = address.rsplit(':', 1)
    assert host == '127.0.0.1', address
    return int(number)


edge_port = port(prefix + '-proxy', 80)


def request(number, method, path, headers=None):
    conn = http.client.HTTPConnection('127.0.0.1', number, timeout=10)
    try:
        conn.request(method, path, headers=headers or {})
        response = conn.getresponse()
        return response.status, dict((k.lower(), v) for k, v in response.getheaders()), response.read()
    finally:
        conn.close()


unknown = '/unknown-edge-route-check'
if routes == 'offline':
    status, headers, body = request(edge_port, 'GET', unknown)
    assert status == 404 and b'Cannot GET /unknown-edge-route-check' in body
    assert unknown not in docker('logs', prefix + '-node')
    print('ok local 404 with Node and file-server stopped', flush=True)
    sys.exit(0)

files_port = port(prefix + '-files', 8080)
for attempt in range(50):
    try:
        if request(files_port, 'GET', unknown)[0] == 404:
            break
    except OSError:
        pass
    time.sleep(.1)
else:
    raise AssertionError('file-server did not start')

# Positive fixtures cover build families added after a supplied offline image.
# They supplement, rather than replace, the image's emitted production assets.
extra_assets = ['/static/fonts/space-mono-check/400.css', '/twemoji/check/72x72/heart.png',
                '/js/jwt-decode-check.js', '/assets/check.svg', '/images/check.png',
                '/admin/build-info.json', '/participation/build-info.json', '/report/build-info.json',
                '/report_vendor_d3-check.min.js']
docker('exec', prefix + '-files', 'node', '-e',
       "const fs=require('fs'),path=require('path'); for (const p of JSON.parse(process.argv[1])) {"
       "const dest='/app/build'+p; fs.mkdirSync(path.dirname(dest),{recursive:true});"
       "fs.writeFileSync(dest,'static fixture '+p); }", json.dumps(extra_assets))

before = docker('logs', prefix + '-node')
# Match actual finalhandler bytes, escaping, query omission, methods and HEAD.
for path in [unknown, unknown + '?private=value', unknown + '/',
             unknown + '/a&b\'c', unknown + '/%3Cscript%3E',
             unknown + '/<tag>', unknown + '/a[0]', unknown + '/%E2%98%83',
             unknown + '/a%2Fb', unknown + '/a%252Fb', unknown + '/a;b,c=1',
             '/cached/absent', '/font/absent', '/anythingembedjs/absent',
             '/unlisted.js', '/unlisted.html', '/.env', '/__tests__/absent']:
    for method in ['GET', 'HEAD', 'POST', 'OPTIONS']:
        expected = request(files_port, method, path)
        got = request(edge_port, method, path)
        assert got[0] == expected[0] == 404, (method, path, got[0], expected[0])
        assert got[2] == expected[2], (method, path, got[2], expected[2])
        for header in ['content-type', 'content-length', 'content-security-policy', 'x-content-type-options']:
            assert got[1].get(header) == expected[1].get(header), (path, header, got[1], expected[1])
assert docker('logs', prefix + '-node') == before, 'unknown path reached Node'
print('ok unknown paths: byte-identical file-server 404, HEAD and escaping; Node log unchanged', flush=True)

# Inspect every real emitted asset in the image, including gzip and header
# sidecars. Test source files accidentally copied by older builds are not a
# public asset family. New unclassified build outputs fail this check.
manifest = docker('exec', prefix + '-files', 'find', '/app/build', '-type', 'f').splitlines()
assets = ['/' + p.removeprefix('/app/build/') for p in manifest
          if '/__tests__/' not in p]
assert '/embed.js' in assets and '/index_report.html' in assets
assert any(p.startswith('/report_bundle') and p.endswith('.js') for p in assets)
assert any(p.startswith('/report_style') and p.endswith('.css') for p in assets)
for path in assets:
    expected = request(files_port, 'GET', path)
    got = request(edge_port, 'GET', path)
    assert got[0] == expected[0] == 200, (path, got[0], expected[0])
    assert got[2] == expected[2], path
    expected_head = request(files_port, 'HEAD', path + '?asset-check=1')
    got_head = request(edge_port, 'HEAD', path + '?asset-check=1')
    assert got_head[0] == expected_head[0] == 200 and got_head[2] == b'', path
    assert got_head[1]['content-length'] == expected_head[1]['content-length'], path
    for header in ['content-type', 'content-encoding', 'cache-control', 'etag', 'last-modified', 'content-length']:
        assert got[1].get(header) == expected[1].get(header), (path, header)
# Conditional and partial responses must keep the file-server's semantics.
for headers in [{'Range': 'bytes=0-19'}, {'If-None-Match': request(files_port, 'GET', '/embed.js')[1]['etag']}]:
    expected = request(files_port, 'GET', '/embed.js', headers)
    got = request(edge_port, 'GET', '/embed.js', headers)
    assert (got[0], got[2]) == (expected[0], expected[2])
assert docker('logs', prefix + '-node') == before, 'static asset reached Node'
print(f'ok {len(assets)} emitted static files: identical bytes and headers, range and conditional GET; Node log unchanged', flush=True)

# Exercise every registered string API route, including unused routes and
# mutation methods. Literal routes are read from source to include new ones.
source = (root / 'server/app.ts').read_text()
cases = set(re.findall(r'app\.(get|post|put|delete|all)\(\s*["\'](/api/[^"\']+)["\']', source))
assert len(cases) > 100, len(cases)
for method, path in sorted(cases):
    path = re.sub(r':[A-Za-z_][A-Za-z_0-9]*', 'fixture', path).replace('*', 'fixture')
    method = 'OPTIONS' if method == 'all' else method.upper()
    got = request(edge_port, method, path)
    want = 'polis-api' if routes and path == '/api/v3/math/pca2' and method == 'GET' else 'server'
    assert got[0] == 200 and got[1].get('x-upstream') == want, (method, path, want, got)
for method in ['GET', 'HEAD', 'OPTIONS', 'POST', 'PUT', 'DELETE']:
    for path in ['/API/v3/comments', '/api/v4/future', '/api/v3/votes/famous', '/api/v3/ops/activity']:
        assert request(edge_port, method, path)[1].get('x-upstream') == 'server', (method, path)
print(f'ok {len(cases)} registered API method/path pairs plus case and prefix variants', flush=True)

pages = ['/', '/4fixture', '/4fixture/suffix', '/m/4fixture/topics', '/polis_site_idfixture',
         '/feeds/fixture', '/feeds/fixture/consensus', '/feeds/fixture/topics', '/iip/4fixture', '/iim/4fixture',
         '/robots.txt', '/ROBOTS.TXT/', '/perfStats_9182738127',
         '/explore/4fixture', '/share/4fixture', '/summary/4fixture', '/ot/4fixture', '/demo/4fixture',
         '/conversation/create', '/user/create', '/user/login', '/user/logout', '/settings',
         '/integrate', '/other-conversations', '/account', '/ops', '/bot', '/conversations', '/signout', '/signin',
         '/gov', '/createuser', '/contrib', '/bot/install', '/bot/support', '/inbox', '/hk', '/s', '/s/CTE',
         '/hk/new', '/inboxApiTest', '/pwresetinit', '/pwreset', '/home',
         '/football', '/pdf', '/nabi', '/privacy', '/tos', '/donate', '/demo', '/company', '/embed',
         '/embedPreprod', '/embedReport', '/embedReportPreprod', '/styleguide', '/about',
         '/__webpack_hmr', '/dist/admin_bundle.js']
for family in ['report', 'narrativeReport', 'stats', 'commentsReport', 'topicReport', 'topicsVizReport',
               'topicHierarchy', 'collectiveStatements', 'exportReport', 'topicMapNarrativeReport', 'topicStats']:
    pages += [f'/{family}/r4fixture', f'/{family}/4fixture/suffix']
for path in pages:
    for method in ['GET', 'HEAD']:
        got = request(edge_port, method, path)
        want = 'server'
        if routes and (path.startswith('/4fixture') or path.startswith('/m/4fixture') or path == '/robots.txt'):
            want = 'polis-api'
        assert got[0] == 200 and got[1].get('x-upstream') == want, (method, path, want, got)
for path in ['/alpha/4fixture', '/alpha/embed.js?example=1', '/_astro/client.js']:
    assert request(edge_port, 'GET', path)[1].get('x-upstream') == 'client-participation-alpha', path
assert 'GET /embed.js?example=1 ' in docker('logs', prefix + '-alpha'), 'alpha prefix was not stripped'
assert 'GET /api/v3/version ' in docker('logs', prefix + '-node'), 'Node access log must record positive controls'
print(f'ok {len(pages)} page samples (GET/HEAD), both embed scripts and alpha assets', flush=True)

output = os.environ.get('NGINX_RENDERED_DIR')
if output:
    target = Path(output)
    target.mkdir(parents=True, exist_ok=True)
    (target / ('routes-on.conf' if routes else 'routes-off.conf')).write_text(docker('exec', prefix + '-proxy', 'nginx', '-T'))
