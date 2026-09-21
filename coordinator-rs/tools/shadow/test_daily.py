import copy
import gzip
import io
from pathlib import Path
import tempfile
import unittest
from unittest.mock import Mock
import daily as d


def response(raw=b'[{"id":1},{"id":2}]',**changes):
    return dict(status=200,complete=True,content_type='application/json',etag='bound-validator',cache_control='private',vary='Accept-Encoding',encoding='identity',body=raw,full_body=None,**changes)


def receipt(delivery='CONFIRMED'):
    return dict(schema='polis-shadow-receipt/1',run='1'*32,window=1,seconds=86400,build='2'*64,policy='3'*64,
        admission=dict(host=True,runtime=True,input=True,collector=True,clojure_serving=True),
        windows=dict(expected=1,bound=1,incomplete=0),residuals={'cut-unbound-late-row':0},
        routes={k:dict(expected=1,observed=1,EXACT=1,UNORDERED_QUERY_RESIDUAL=0,ENGINE_DIFFERENCE=0,INCOMPLETE=0) for k in d.ROUTES},
        observer=dict(expected=1440,observed=1440,alarms=0,unresolved=0),delivery=delivery,cleanup='RETAINED',verdict='PASS' if delivery=='CONFIRMED' else 'INCOMPLETE')

class Daily(unittest.TestCase):
    route={'class':'COMMENT_MATH','unordered':True}

    def test_exact(self):self.assertEqual(d.compare(response(),response(),self.route),'EXACT')
    def test_one_byte(self):self.assertEqual(d.compare(response(),response(b'[{"id":1},{"id":3}]'),self.route),'ENGINE_DIFFERENCE')
    def test_order_only(self):self.assertEqual(d.compare(response(),response(b'[{"id":2},{"id":1}]'),self.route),'UNORDERED_QUERY_RESIDUAL')
    def test_order_plus_value(self):self.assertEqual(d.compare(response(),response(b'[{"id":3},{"id":1}]'),self.route),'ENGINE_DIFFERENCE')
    def test_whitespace_not_normalized(self):self.assertEqual(d.compare(response(),response(b'[ {"id":2},{"id":1}]'),self.route),'ENGINE_DIFFERENCE')
    def test_no_general_array_sort(self):self.assertEqual(d.compare(response(),response(b'[{"id":2},{"id":1}]'),{'class':'PCA2_FULL','unordered':True}),'ENGINE_DIFFERENCE')
    def test_gzip_only(self):
        a,b=response(),response();a['body']=gzip.compress(a['body'],mtime=1);b['body']=gzip.compress(b['body'],mtime=2);a['encoding']=b['encoding']='gzip'
        self.assertNotEqual(a['body'],b['body']);self.assertEqual(d.compare(a,b,self.route),'EXACT')
    def test_truncated_gzip(self):
        a=response();a.update(body=gzip.compress(a['body'])[:-1],encoding='gzip');self.assertEqual(d.compare(a,response(),self.route),'INCOMPLETE')
    def test_304_no_equality(self):
        a=response(b'');a['status']=304;self.assertEqual(d.compare(a,a,self.route),'INCOMPLETE')
    def test_304_bound_full(self):
        full=response();a=response(b'');a.update(status=304,full_body=d.hashlib.sha256(full['body']).hexdigest())
        self.assertEqual(d.compare(a,a,self.route,(full,full)),'EXACT')
    def test_status_headers_completion(self):
        for k,v in [('status',500),('etag','different'),('complete',False)]:
            a=response();a[k]=v;self.assertNotEqual(d.compare(a,response(),self.route),'EXACT')
    def test_cut_first_binding_and_mutation(self):
        with tempfile.TemporaryDirectory() as root:
            p,h=d.bind_cut(root,1,b'public-fixture-cut');self.assertEqual(d.bind_cut(root,1,b'public-fixture-cut'),(p,h));d.verify_cut(p,h)
            with self.assertRaisesRegex(ValueError,'REBOUND'):d.bind_cut(root,1,b'other-cut')
            p.chmod(0o600);p.write_bytes(b'one-byte-changed')
            with self.assertRaisesRegex(ValueError,'CHANGED'):d.verify_cut(p,h)
    def test_route_inventory(self):
        route=dict(self.route,method='GET',path='/api/v3/comments',request_sha256='1'*64,query_sha256='2'*64)
        d.admit_route(route,[route])
        with self.assertRaisesRegex(ValueError,'ROUTE'):d.admit_route(route,[])
        bad=route|{'method':'POST'}
        with self.assertRaisesRegex(ValueError,'ROUTE'):d.admit_route(bad,[bad])
    def test_pair_host_child_cut_and_namespace(self):
        runtime=dict(observed=True,threads=1,kernel='native',libraries=['public-fixture-blas'])
        expected=dict(host='public-host',cut='1'*64,history='2'*64,node_build='3'*64,node_dependencies='4'*64,node_settings='5'*64,clojure_namespace='legacy',python_namespace='shadow',clojure_runtime=runtime,python_runtime=runtime)
        common={k:expected[k] for k in ('host','cut','history','node_build','node_dependencies','node_settings')}
        a=common|dict(lifecycle='warm-continuation/1',namespace='legacy',engine='clojure',computing_pid=2,parent_pid=1,runtime=runtime,bundle='6'*64,read_only=True)
        b=a|dict(namespace='shadow',engine='python',computing_pid=3)
        d.admit_pair(a,b,expected)
        for key,value in [('host','other'),('cut',''),('computing_pid',1),('runtime',runtime|{'observed':False}),('namespace','legacy')]:
            with self.subTest(key=key),self.assertRaises(ValueError):d.admit_pair(a,b|{key:value},expected)
    def test_closed_receipt(self):
        d.validate_receipt(receipt())
        for k,v in [('extra','not-exportable'),('build','not-a-public-build'),('seconds',True),('run','private-id')]:
            with self.subTest(key=k),self.assertRaises(ValueError):d.validate_receipt(receipt()|{k:v})
    def test_dead_collector_observer_missing_route_or_cut(self):
        for change in ('collector','input','observer','route','clojure_serving'):
            value=receipt()
            if change=='observer':value['observer']['observed']-=1
            elif change=='route':value['routes']['PCA2_FULL'].update(observed=0,EXACT=0)
            else:value['admission'][change]=False
            with self.subTest(change=change):
                with self.assertRaisesRegex(ValueError,'VERDICT'):d.validate_receipt(value)
                value['verdict']='INCOMPLETE';d.validate_receipt(value)
    def test_unresolved_publication(self):
        value=receipt();value['observer']['unresolved']=1
        with self.assertRaisesRegex(ValueError,'VERDICT'):d.validate_receipt(value)
    def test_delivery_confirmed_or_uncertain(self):
        value=receipt('PENDING');client=Mock();self.assertEqual(d.publish(client,'private-bucket','key','key-arn',value),'CONFIRMED')
        client.put_object.side_effect=TimeoutError();client.get_object.side_effect=OSError()
        self.assertEqual(d.publish(client,'private-bucket','key','key-arn',value),'UNCERTAIN')
        client.get_object.side_effect=None;client.get_object.return_value={'Body':io.BytesIO(d.canonical(value))}
        self.assertEqual(d.publish(client,'private-bucket','key','key-arn',value),'CONFIRMED')
        client.get_object.return_value={'Body':io.BytesIO(b'other')}
        self.assertEqual(d.publish(client,'private-bucket','key','key-arn',value),'FAILED')
        self.assertEqual(client.put_object.call_args.kwargs['IfNoneMatch'],'*')

class LegacyCursorEvidence(unittest.TestCase):
    def test_same_final_rows_and_cursor_do_not_bind_consumed_history(self):
        rows=[dict(pid=1,tid=1,vote=1,created=100),dict(pid=2,tid=1,vote=1,created=200)]
        def observe(visible,cursor):
            batch=[r for r in visible if r['created']>cursor]
            return batch,max([cursor]+[r['created'] for r in batch])
        a,cursor_a=observe(rows,0)
        b,cursor_b=observe(rows[1:],0)
        late,cursor_b=observe(rows,cursor_b)
        b+=late
        self.assertEqual(cursor_a,cursor_b)
        self.assertNotEqual(d.canonical(a),d.canonical(b))
        # Both database snapshots now contain exactly rows; cursor alone cannot
        # choose which consumed cut the unchanged writer actually saw.
        self.assertEqual(len(late),0)

class WindowAccounting(unittest.TestCase):
    def test_unbound_late_row_is_never_failure_or_pass(self):
        value=receipt();value['admission']['input']=False
        value['windows']=dict(expected=1,bound=0,incomplete=1)
        value['residuals']['cut-unbound-late-row']=1
        value['routes']['PCA2_FULL'].update(EXACT=0,ENGINE_DIFFERENCE=1)
        for verdict in ('PASS','ENGINE_DIFFERENCE'):
            value['verdict']=verdict
            with self.assertRaisesRegex(ValueError,'VERDICT'):d.validate_receipt(value)
        value['verdict']='INCOMPLETE';d.validate_receipt(value)
        counts=d.summarize_windows([value]);self.assertEqual(counts['INCOMPLETE'],1)
        self.assertEqual(counts['PASS'],0);self.assertEqual(counts['cut-unbound-late-row'],1)

    def test_residual_vocabulary_and_count_are_closed(self):
        for residuals in ({'other':1},{'cut-unbound-late-row':1},{'cut-unbound-late-row':True}):
            value=receipt();value['residuals']=residuals
            with self.assertRaises(ValueError):d.validate_receipt(value)

    def test_window_counts_and_deduplication(self):
        with self.assertRaisesRegex(ValueError,'DUPLICATE'):d.summarize_windows([receipt(),receipt()])
        value=receipt();value['windows']['bound']=0
        with self.assertRaisesRegex(ValueError,'ACCOUNTING'):d.validate_receipt(value)
