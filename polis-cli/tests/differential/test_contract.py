import unittest
from run import differences, census, check_census, routing_counts

class ComparatorTests(unittest.TestCase):
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

if __name__=='__main__':unittest.main()
