import unittest
from run import differences, census, check_census, route_lines, route_contracts, routing_counts, rust_only_checks, serving_matches, RUST_ONLY

class ComparatorTests(unittest.TestCase):
    def test_exact_route_log_matching_does_not_accept_neighbors(self):
        log = 'GET /api/v3/reports 127.0.0.1:5100 200\nGET /api/v3/reportsSuffix 127.0.0.1:5000 404'
        self.assertEqual(len(route_lines(log, {'path':'/api/v3/reports'})), 1)
    def test_regex_route_log_matching_counts_capability_paths(self):
        log = 'GET /api/v3/xid/generated-xid.csv 127.0.0.1:5100, 127.0.0.1:5000 502, 200\nGET /api/v3/xid/ 127.0.0.1:5000 404'
        self.assertEqual(len(route_lines(log, {'path':'^/api/v3/xid/[^/]+$'})), 1)
    def test_named_location_fallback_is_not_a_rust_success(self):
        counts = routing_counts(['GET /api/v3/reports 127.0.0.1:5100 : 127.0.0.1:5000 502 : 200'])
        self.assertEqual(counts, {'requests':1,'rust_200':0,'rust_fallbacks':1})
    def test_within_group_retry_is_not_a_rust_success(self):
        counts = routing_counts(['GET /api/v3/reports 127.0.0.1:5100, 127.0.0.1:5000 502, 200'])
        self.assertEqual(counts, {'requests':1,'rust_200':0,'rust_fallbacks':1})
    def test_single_rust_response_is_counted_separately_from_node(self):
        counts = routing_counts(['GET /api/v3/reports 127.0.0.1:5100 200', 'GET /api/v3/reports 127.0.0.1:5000 200', 'GET /api/v3/reports 127.0.0.1:5100 403'])
        self.assertEqual(counts, {'requests':3,'rust_200':1,'rust_fallbacks':0})
    def test_object_order_only_is_ignored(self):
        self.assertEqual(differences({'a':1,'b':2},{'b':2,'a':1}),[])
    def test_nested_mutation_is_not_masked(self):
        self.assertEqual(differences({'data':{'created':1}},{'data':{'created':2}}),['$.data.created'])
    def test_array_order_matters(self):
        self.assertTrue(differences([1,2],[2,1]))
    def test_boolean_is_not_integer(self):
        self.assertTrue(differences(True,1))
    def test_missing_fields_and_exit_matter(self):
        self.assertTrue(differences({'exit':0,'data':None},{'exit':1}))
    def test_new_command_without_scenario_fails(self):
        with self.assertRaises(RuntimeError):check_census({'vote':True,'new':True},[{'command':'vote'}])
    def test_duplicate_case_fails(self):
        with self.assertRaises(RuntimeError):check_census({'vote':True},[{'command':'vote'},{'command':'vote'}])
    def test_parent_command_and_unavailable_leaf_are_included(self):
        nodes=census({'command':'polis','implemented':False,'commands':[
            {'command':'polis vote','implemented':True,'commands':[
                {'command':'polis vote cast','implemented':False,'commands':[]}]}]})
        self.assertEqual(nodes,{'vote':True,'vote cast':False})


class RoutingContractTests(unittest.TestCase):
    def test_selector_total_cannot_hide_failure_of_one_path(self):
        path_contracts = [dict(path=path, minimum_rust_successes=1,
                               expected_requests=2, expected_node_handoffs=1)
                          for path in ['/api/v3/votes', '/api/v3/votes/me']]
        routes = {'votesRead': dict(path='^/api/v3/votes(/me)?$',
                  minimum_rust_successes=2, expected_requests=4,
                  expected_node_handoffs=2, paths=path_contracts)}
        # The selector total is correct, but both successes came from one path.
        log = '\n'.join([
            'GET /api/v3/votes 127.0.0.1:5100 200',
            'GET /api/v3/votes 127.0.0.1:5100 200',
            'GET /api/v3/votes/me 127.0.0.1:5100 : 127.0.0.1:5000 502 : 200',
            'GET /api/v3/votes/me 127.0.0.1:5100 : 127.0.0.1:5000 502 : 200',
            'GET /api/v3/votes/meSuffix 127.0.0.1:5100 200'])
        checks = {name: serving_matches(routing_counts(route_lines(log, contract)), contract)
                  for name, contract in route_contracts(routes)}
        self.assertEqual(checks, {'votesRead': True, 'votesRead:/api/v3/votes': False,
                                 'votesRead:/api/v3/votes/me': False})

    def test_scoped_handoff_cannot_hide_lost_success_or_an_extra_fallback(self):
        contract={'minimum_rust_successes':2,'expected_node_handoffs':1,'expected_requests':3}
        self.assertTrue(serving_matches({'rust_200':2,'rust_fallbacks':1,'requests':3},contract))
        for counts in [{'rust_200':1,'rust_fallbacks':2,'requests':3},
                       {'rust_200':2,'rust_fallbacks':2,'requests':4},
                       {'rust_200':2,'rust_fallbacks':1,'requests':4}]:
            self.assertFalse(serving_matches(counts,contract))
    def test_rust_only_requires_the_exact_clean_refusal(self):
        contract=RUST_ONLY['owner-list'];row={'contract':'owner-list'}
        node={'exit':8,'json':{'ok':False,'data':None,'error':{'code':contract['node_code'],'message':contract['node_message']}},'artifacts':{}}
        rust={'exit':0,'json':{'ok':True,'error':None,'data':{}},'artifacts':{}}
        self.assertTrue(all(rust_only_checks(row,node,rust).values()))
        import copy
        for key,value in [('exit',6),('code','operation_failed'),('message','opaque')]:
            bad=copy.deepcopy(node)
            if key=='exit':bad[key]=value
            else:bad['json']['error'][key]=value
            self.assertFalse(all(rust_only_checks(row,bad,rust).values()))
        self.assertFalse(all(rust_only_checks(row,node,node).values()))
    def test_unknown_rust_only_contract_cannot_bypass_comparison(self):
        with self.assertRaises(KeyError):rust_only_checks({'contract':'unknown'}, {}, {})

class PageComparisonTests(unittest.TestCase):
    def fixture(self):
        from pages import PAGES
        return {route + ':' + kind: {'status':200, 'content_type':'text/html',
                                    'body':b'' if kind == 'head' else b'<p>Generated</p>'}
                for route in PAGES for kind in ['get', 'head', 'handoff']}

    def test_page_body_status_and_type_changes_fail(self):
        import copy
        from pages import compare_pages
        node = self.fixture()
        self.assertTrue(all(row['equal'] for row in compare_pages(node, node)))
        for field, value in [('body', b'<p>Changed</p>'), ('status', 302),
                             ('content_type', 'application/json')]:
            rust = copy.deepcopy(node)
            rust['iip:get'][field] = value
            failed = [row for row in compare_pages(node, rust) if not row['equal']]
            self.assertEqual(failed, [{'scenario':'iip:get', 'equal':False,
                                      'different_fields':[field]}])

    def test_missing_page_case_cannot_pass(self):
        from pages import compare_pages
        node, rust = self.fixture(), self.fixture()
        del rust['summaryPage:handoff']
        with self.assertRaises(RuntimeError):
            compare_pages(node, rust)

if __name__=='__main__':unittest.main()


class ImportanceDisplayTests(unittest.TestCase):
    def test_named_counts_exception_rejects_count_identity_and_base_mutations(self):
        import copy
        from harness import importance_display_checks
        node={'exit':0,'json':{'ok':True,'error':None,'data':{'comments':[{'tid':n,'txt':str(n),'important':None,'voters':None} for n in [0,1]],'importance':{'state':'unavailable','error':'operation_failed','read_at_ms':None}}},'artifacts':{}}
        rust=copy.deepcopy(node)
        for r in rust['json']['data']['comments']:r.update(important=0,voters=0)
        rust['json']['data']['importance']={'schema':'statement-importance/1','conversation_id':'2p027generated','state':'observed','read_at_ms':1,'scope':'current active, unmuted, participant-visible comments; latest vote per participant; not verified people or historical job inputs'}
        self.assertTrue(all(importance_display_checks(node,rust).values()))
        for key, value in [('important',1),('voters',1),('important',False),('tid',9),('txt','changed')]:
            bad=copy.deepcopy(rust);bad['json']['data']['comments'][0][key]=value
            self.assertFalse(all(importance_display_checks(node,bad).values()))
        for key,value in [('read_at_ms',None),('schema','bad'),('conversation_id','other')]:
            bad=copy.deepcopy(rust);bad['json']['data']['importance'][key]=value
            self.assertFalse(all(importance_display_checks(node,bad).values()))

    def test_absent_route_error_is_exact_for_this_fixture(self):
        import copy
        from harness import importance_display_checks
        node={'exit':0,'json':{'ok':True,'error':None,'data':{'comments':[{'tid':n,'txt':str(n),'important':None,'voters':None} for n in [0,1]],'importance':{'state':'unavailable','error':'operation_failed','read_at_ms':None}}},'artifacts':{}}
        rust=copy.deepcopy(node)
        for row in rust['json']['data']['comments']:row.update(important=0,voters=0)
        rust['json']['data']['importance']={'schema':'statement-importance/1','conversation_id':'2p027generated','state':'observed','read_at_ms':1,'scope':'current active, unmuted, participant-visible comments; latest vote per participant; not verified people or historical job inputs'}
        self.assertTrue(all(importance_display_checks(node,rust).values()))
        for code in ['capability_unavailable','transport_unavailable','forbidden',None]:
            bad=copy.deepcopy(node);bad['json']['data']['importance']['error']=code
            self.assertFalse(all(importance_display_checks(bad,rust).values()))
