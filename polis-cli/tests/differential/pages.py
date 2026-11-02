"""Supplemental HTML reads through the same proxy and generated fixture.

The CLI only accepts API paths. These page requests compare full body bytes,
status and content type without redirects; the separate wire gate owns the
complete HTTP envelope. No response values enter the structured report.
"""
import http.client
from urllib.parse import urlsplit

CID = '2p027generated'
PAGES = {'conversationPage': '/'}


def capture_pages(origin):
    url = urlsplit(origin)
    if url.scheme != 'http' or url.hostname != '127.0.0.1':
        raise RuntimeError('page scenarios require the local gateway')
    values = {}
    for route, prefix in PAGES.items():
        for method, suffix, kind in [('GET', '', 'get'), ('HEAD', '', 'head'),
                                     ('GET', '?generated=1', 'handoff')]:
            name = route + ':' + kind
            connection = http.client.HTTPConnection(url.hostname, url.port, timeout=5)
            try:
                connection.request(method, prefix + CID + suffix,
                                   headers={'Accept-Encoding': 'identity'})
                response = connection.getresponse()
                body = response.read(65537)
                content_type = response.getheader('Content-Type', '')
                if (response.status != 200 or not content_type.startswith('text/html')
                        or len(body) > 65536 or (method == 'GET' and not body)
                        or (method == 'HEAD' and body)):
                    raise RuntimeError('page response contract failed: ' + name)
                values[name] = {'status': response.status, 'content_type': content_type,
                                'body': body}
            finally:
                connection.close()
    return values


def compare_pages(node, rust):
    expected = {route + ':' + kind for route in PAGES for kind in ['get', 'head', 'handoff']}
    if set(node) != expected or set(rust) != expected:
        raise RuntimeError('page scenario census changed')
    return [{'scenario': name, 'equal': node[name] == rust[name],
             'different_fields': [key for key in ['status', 'content_type', 'body']
                                  if node[name][key] != rust[name][key]]}
            for name in sorted(expected)]
