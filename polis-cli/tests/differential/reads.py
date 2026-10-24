"""Supplemental reads through the generated stack, alongside real CLI cases.

Compare complete body bytes, status and content type. The independent wire
gate owns full HTTP headers. Structured output never includes response values.
"""
import http.client
import json
from urllib.parse import urlsplit

from cases import C, R

EMPTY_REPORT = 'r2generatedempty'
EXPORT_TYPES = ('format.json', 'summary.csv', 'comments.csv', 'votes.csv',
                'participant-votes.csv', 'participant-importance.csv', 'comment-groups.csv')


def add_read_cases(rows):
    def export(kind, report, label):
        return dict(command='report export', scenario='report export '+label+' '+kind,
                    args=['report', 'export', report, '--type', kind, '--output', label+'-'+kind],
                    expected_exit=0, scope='live', actor='public')
    index = next(i for i, row in enumerate(rows) if row['command'] == 'report export') + 1
    rows[index:index] = [export(kind, EMPTY_REPORT, 'no-math') for kind in EXPORT_TYPES]
    index = next(i for i, row in enumerate(rows) if row.get('scenario') == 'vote important') + 1
    rows[index:index] = [export(kind, R, 'populated') for kind in ['comments.csv', 'votes.csv']]


def read_cases():
    rows = []
    for method, suffix, kind in [('GET', '', 'get'), ('HEAD', '', 'head'),
                                 ('GET', '?generated=1', 'handoff')]:
        rows.append(dict(name='perfStats:'+kind, method=method,
                         path='/perfStats_9182738127'+suffix, content_type='application/json',
                         expected_body=b'' if method == 'HEAD' else b'{}'))
        for subtype in EXPORT_TYPES:
            rows.append(dict(name='reportExportPg:'+subtype+':'+kind, method=method,
                             path='/api/v3/reportExport/'+EMPTY_REPORT+'/'+subtype+suffix,
                             content_type='application/json' if subtype == 'format.json' else 'text/csv'))
    for suffix, kind in [('', 'empty'), ('?generated=1', 'handoff')]:
        rows.append(dict(name='metadataQuery:'+kind, method='POST',
                         path='/api/v3/query_participants_by_metadata'+suffix,
                         body=json.dumps({'conversation_id': C, 'pmaids': []}),
                         authenticated=True, content_type='application/json', expected_body=b'[]'))
    return rows


def capture_reads(origin, owner_token):
    url = urlsplit(origin)
    if url.scheme != 'http' or url.hostname != '127.0.0.1':
        raise RuntimeError('read scenarios require the local gateway')
    values = {}
    for row in read_cases():
        connection = http.client.HTTPConnection(url.hostname, url.port, timeout=5)
        headers = {'Accept-Encoding': 'identity'}
        if row.get('authenticated'):
            headers.update({'Authorization': 'Bearer '+owner_token, 'Content-Type': 'application/json'})
        try:
            connection.request(row['method'], row['path'], body=row.get('body'), headers=headers)
            response = connection.getresponse()
            body = response.read(1048577)
            content_type = response.getheader('Content-Type', '')
            if (response.status != 200 or content_type.split(';')[0] != row['content_type']
                    or len(body) > 1048576 or (row['method'] == 'HEAD' and body)
                    or (row['method'] != 'HEAD' and not body)
                    or ('expected_body' in row and body != row['expected_body'])):
                raise RuntimeError('read response contract failed: '+row['name'])
            values[row['name']] = dict(status=response.status, content_type=content_type, body=body)
        finally:
            connection.close()
    return values


def compare_reads(node, rust):
    expected = {row['name'] for row in read_cases()}
    if set(node) != expected or set(rust) != expected:
        raise RuntimeError('read scenario census changed')
    return [dict(scenario=name, equal=node[name] == rust[name],
                 different_fields=[key for key in ['status', 'content_type', 'body']
                                   if node[name][key] != rust[name][key]])
            for name in sorted(expected)]
