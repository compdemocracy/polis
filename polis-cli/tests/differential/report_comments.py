"""Report view projection and default-off routing through the real proxy.

Node has no typed report URL. Compare its legacy report fields, preserving row
and property order, with the enabled typed response. Never treat the off-switch
404 as a data-equality success. No response values enter the result artifact.
"""
import http.client
import json
from urllib.parse import urlencode, urlsplit

from cases import C, R

FIELDS = {'txt', 'tid', 'is_meta', 'pid', 'agree_count', 'disagree_count', 'pass_count', 'count'}


def cases():
    return [(actor, level) for actor in ['anonymous', 'owner'] for level in [-2, -1, 0]]


def project(body):
    # This fixture has integer IDs/counts, boolean flags and text. Match Node's
    # compact UTF-8 JSON; retain its existing field order and missing fields.
    rows = json.loads(body)
    if not isinstance(rows, list) or any(not isinstance(row, dict) for row in rows):
        raise RuntimeError('report projection requires statement rows')
    return json.dumps([{key: value for key, value in row.items() if key in FIELDS}
                       for row in rows], ensure_ascii=False, separators=(',', ':')).encode()


def capture_report_comments(origin, owner_token, phase):
    url = urlsplit(origin)
    if url.scheme != 'http' or url.hostname != '127.0.0.1' or phase not in ['node', 'rust']:
        raise RuntimeError('report scenarios require the local gateway and a known phase')

    def request(path, actor, method='GET'):
        connection = http.client.HTTPConnection(url.hostname, url.port, timeout=5)
        headers = {'Accept-Encoding': 'identity'}
        if actor == 'owner':
            headers['Authorization'] = 'Bearer ' + owner_token
        try:
            connection.request(method, path, headers=headers)
            response = connection.getresponse()
            body = response.read(1048577)
            if len(body) > 1048576:
                raise RuntimeError('report response exceeded fixture bound')
            return dict(status=response.status, content_type=response.getheader('Content-Type', ''),
                        body=body)
        finally:
            connection.close()

    values = {}
    for actor, level in cases():
        name = f'reportComments:{actor}:mod_gt={level}'
        query = urlencode(dict(conversation_id=C, report_id=R, mod_gt=level))
        legacy = request('/api/v3/comments?' + query + '&moderation=true&include_voting_patterns=true', actor)
        typed = request('/api/v3/comments/report?' + query, actor)
        head = request('/api/v3/comments/report?' + query, actor, 'HEAD')
        if legacy['status'] != 200 or not legacy['content_type'].startswith('application/json'):
            raise RuntimeError('legacy report response failed: ' + name)
        projected = dict(legacy, body=project(legacy['body']))
        if typed['status'] != (404 if phase == 'node' else 200) or not typed['body']:
            raise RuntimeError('typed report switch response failed: ' + name)
        if head != dict(typed, body=b''):
            raise RuntimeError('typed report HEAD response failed: ' + name)
        values[name] = dict(projected=projected, typed=typed)
    return values


def compare_report_comments(node, rust):
    expected = {f'reportComments:{actor}:mod_gt={level}' for actor, level in cases()}
    if set(node) != expected or set(rust) != expected:
        raise RuntimeError('report scenario census changed')
    results = []
    for name in sorted(expected):
        a, b = node[name], rust[name]
        checks = dict(node_off_404=a['typed']['status'] == 404,
                      legacy_unchanged=a['projected'] == b['projected'],
                      projection_bytes=a['projected'] == b['typed'])
        results.append(dict(scenario=name, equal=all(checks.values()), checks=checks))
    return results
