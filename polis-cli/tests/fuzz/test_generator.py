import json
from pathlib import Path
import sys
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parent))
import generator  # noqa: E402
import run  # noqa: E402


class GeneratorTests(unittest.TestCase):
    def test_same_seed_same_steps(self):
        self.assertEqual(generator.generate('2a', 60), generator.generate('000000000000002a', 60))

    def test_different_seeds_differ(self):
        self.assertNotEqual(generator.generate('1', 60)[1], generator.generate('2', 60)[1])

    def test_a_shorter_run_is_a_prefix_of_a_longer_one(self):
        for seed in ['1', '7', '5eed']:
            short, long = generator.generate(seed, 40), generator.generate(seed, 300)
            self.assertEqual(short[0], long[0])
            self.assertEqual(short[1], long[1][:40])

    def test_step_count_is_exact_and_indexed(self):
        for n in [1, 2, 3, 40, 151]:
            _, steps = generator.generate('7', n)
            self.assertEqual([s['index'] for s in steps], list(range(n)))

    def test_step_seeds_derive_from_the_run_seed(self):
        a = generator.step_seed('00000000000000aa', 3)
        self.assertRegex(a, r'^[a-f0-9]{12}$')
        self.assertNotEqual(a, generator.step_seed('00000000000000aa', 4))
        self.assertNotEqual(a, generator.step_seed('00000000000000ab', 3))
        self.assertNotEqual(generator.step_uuid('00000000000000aa', 3), generator.step_uuid('00000000000000aa', 4))

    def test_seed_is_64_bit_hex(self):
        with self.assertRaises(ValueError):
            generator.normalize_seed('1' + '0' * 16)
        with self.assertRaises(ValueError):
            generator.normalize_seed('not-hex')

    def test_votes_use_typed_choice_names_only(self):
        for seed in range(20):
            for s in generator.generate(format(seed, 'x'), 80)[1]:
                if s['kind'] == 'vote':
                    self.assertIn(s['choice'], generator.CHOICES)
                    self.assertEqual(s['args'][-1], '--' + s['choice'])
                    self.assertEqual(sum(a in ('--agree', '--disagree', '--pass') for a in s['args']), 1)

    def test_setups_stay_in_the_typed_space(self):
        for seed in range(30):
            setups, _ = generator.generate(format(seed, 'x'), 5)
            self.assertGreaterEqual(len(setups), 2)
            for setup in setups.values():
                self.assertEqual(set(setup), {'topic', 'description', 'context', 'activity', 'listing', 'join',
                                              'moderation', 'visibility', 'data_access', 'profanity_filter',
                                              'short_url', 'seeds'})
                self.assertIn(setup['activity'], ['open', 'closed'])
                self.assertIn(setup['listing'], ['listed', 'draft'])
                self.assertIn(setup['moderation'], ['after_submission', 'before_visibility'])
                self.assertIn(setup['visibility'], ['normal', 'hide_social_list'])
                self.assertIn(setup['data_access'], ['owner', 'public'])
                inv = setup['join']['invitations']
                waves = inv['waves'] if inv['mode'] == 'optional' else [inv['first_wave'], *inv['later_waves']]
                self.assertIn(inv['mode'], ['optional', 'required'])
                for w in waves:
                    self.assertTrue(0 < w['owner_invites'] + w['per_participant'])
                    self.assertTrue(w['owner_invites'] <= 1000 and w['per_participant'] <= 1000)
                ext = setup['join']['external_identity']
                self.assertIn(ext['mode'], ['optional', 'required', 'allowlist'])
                if ext['mode'] == 'allowlist':
                    self.assertTrue(1 <= len(ext['ids']) == len(set(ext['ids'])))
                self.assertEqual(len(setup['seeds']), len(set(setup['seeds'])))
                self.assertTrue(setup['topic'].strip())

    def test_placeholders_are_whole_arguments_and_resolvable(self):
        for seed in range(20):
            setups, steps = generator.generate(format(seed, 'x'), 120)
            created = {'c0'} | set(setups)
            for s in steps:
                for a in s['args']:
                    if a.startswith('@'):
                        self.assertRegex(a, r'^@(conv:c\d+|invite:c\d+|login:p\d+:c\d+)$')
                        self.assertIn(a.rsplit(':', 1)[1], created)
                    else:
                        self.assertNotIn('@conv:', a)

    def test_invite_joins_follow_a_harvest_and_logins_follow_an_invite(self):
        for seed in range(40):
            _, steps = generator.generate(format(seed, 'x'), 150)
            harvested, invited = set(), set()
            for s in steps:
                if s.get('harvests'):
                    harvested.add(s['harvests'])
                if s.get('entry') == 'invite':
                    self.assertIn(s['conversation'], harvested)
                    invited.add((s['actor'], s['conversation']))
                if s.get('entry') == 'returning-invite':
                    holder = s['actor'].removesuffix('-d2')
                    self.assertIn((holder, s['conversation']), invited)

    def test_steps_round_trip_as_json(self):
        setups, steps = generator.generate('5', 200)
        self.assertEqual(json.loads(generator.dump(setups, steps)), {'setups': setups, 'steps': steps})


class DriverTests(unittest.TestCase):
    def test_classify_separates_rust_answers_from_handoffs(self):
        routes = {'comments': {'path': '/api/v3/comments'}, 'pca2': {'path': '/api/v3/math/pca2'}}
        lines = ['GET /api/v3/comments 172.18.0.5:5100 200',
                 'GET /api/v3/comments 172.18.0.5:5100 304',
                 'GET /api/v3/comments 172.18.0.5:5100 : 172.18.0.4:5000 502 : 200',
                 'GET /api/v3/comments 172.18.0.4:5000 200',
                 'POST /api/v3/votes 172.18.0.4:5000 200']
        self.assertEqual(run.classify(lines, routes),
                         {'comments': {'requests': 4, 'rust_answered': 2, 'rust_200': 1, 'handoffs': 1}})

    def test_known_difference_needs_command_and_every_path(self):
        registry = json.loads((Path(__file__).resolve().parent / 'known-differences.json').read_text())
        step = {'command': 'math view'}
        self.assertEqual(run.known(step, ['$.json.data.n-cmts', '$.json.data.tids.length',
                                          '$.json.data.pca.comment-extremity.length'], registry),
                         'pca2-math-cache-not-shared')
        self.assertEqual(run.known(step, ['$.json.data.tids[1]'], registry), 'pca2-math-cache-not-shared')
        self.assertIsNone(run.known(step, ['$.json.data.n-cmts', '$.json.data.math_tick'], registry))
        self.assertIsNone(run.known(step, ['$.exit'], registry))
        self.assertIsNone(run.known({'command': 'statement list'}, ['$.json.data.n-cmts'], registry))

    def test_digest_differences_name_columns_not_values(self):
        a = {'t': {'rows': 1, 'digest': 'a', 'columns': {'x': '1', 'y': '2'}}}
        b = {'t': {'rows': 1, 'digest': 'b', 'columns': {'x': '1', 'y': '3'}}}
        self.assertEqual(run.digest_differences(a, b), ['t.y'])
        self.assertEqual(run.digest_differences(a, {'t': dict(a['t'], rows=2)}), ['t'])
        self.assertEqual(run.digest_differences(a, a), [])

    def test_resolve_never_invents_values(self):
        state = {'conv': {'c0': 'fixture'}, 'invites': {'c1': ['code1']}}

        class Cli:
            workspace = Path('/nonexistent')
        self.assertEqual(run.resolve(['vote', '@conv:c0', '@conv:c9', '@invite:c1', '@invite:c1', '@login:p1:c0'],
                                     state, Cli()),
                         ['vote', 'fixture', generator.MISSING_CONVERSATION, 'code1', generator.MISSING_INVITE,
                          generator.MISSING_LOGIN])

    def test_known_differences_registry_shape(self):
        registry = json.loads((Path(__file__).resolve().parent / 'known-differences.json').read_text())
        ids = [e['id'] for e in registry['entries']]
        self.assertEqual(len(ids), len(set(ids)))
        for e in registry['entries']:
            self.assertIsInstance(e['bound'], int)
            self.assertTrue(e['summary'])
        rids = [r['id'] for r in registry['harness_residuals']]
        self.assertEqual(len(rids), len(set(rids)))
        for r in registry['harness_residuals']:
            for column in r['database_columns']:
                self.assertRegex(column, r'^[a-z_]+\.[a-z_]+$')
            self.assertTrue(r['source'] and r['effect'])

    def test_residual_split_covers_only_listed_command_paths(self):
        registry = {'harness_residuals': [{'id': 'r', 'database_columns': [],
                                           'cli_match': {'command': 'conversation view',
                                                         'paths_regex': '^\\$\\.json\\.data\\.modified$'}}]}
        step = {'command': 'conversation view'}
        self.assertEqual(run.residual_split(step, ['$.json.data.modified'], registry), ([], {'r': 1}))
        self.assertEqual(run.residual_split(step, ['$.json.data.modified', '$.exit'], registry), (['$.exit'], {'r': 1}))
        self.assertEqual(run.residual_split(step, ['$.json.data.modified_by'], registry), (['$.json.data.modified_by'], {}))
        self.assertEqual(run.residual_split({'command': 'statement list'}, ['$.json.data.modified'], registry),
                         (['$.json.data.modified'], {}))


if __name__ == '__main__':
    unittest.main()
