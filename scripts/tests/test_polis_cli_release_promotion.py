"""Release orchestration against generated repository/API state; no live writes."""
import copy
import importlib.util
import json
import os
import shlex
from pathlib import Path
import subprocess
import tempfile
import tomllib
import unittest
from unittest.mock import patch

SPEC = importlib.util.spec_from_file_location('promotion', Path(__file__).parents[1] / 'polis_release.py')
m = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(m)
A, B, C = ('a' * 40, 'b' * 40, 'c' * 40)
TREE = 'd' * 40
REPO = 'example/project'
PLAN = dict(schema='polis.release-plan/1', rule='effective-selection', kind='promotion',
            version='2.42.0', previous_version='2.41.0', bump='minor',
            reason='new selected migrations', release_lines=['000020_add_index.sql'],
            previous_stable_commit=A, candidate_commit=B, previous_tree='e' * 40,
            candidate_tree=TREE, previous_manifest_blob='f' * 40,
            candidate_manifest_blob='0' * 40, previous_tag='v2.41.0', new_number=True)
NOTES = {'promotion': 20, 'prs': [{'number': 10, 'title': 'Add feature', 'merged_at': '2026-01-01T00:00:00Z'}],
         'direct_commits': []}
# Kept before setUp replaces it, so the budget tests below exercise the real check.
REQUIRE_API_BUDGET = m.require_api_budget


def packet():
    return {'schema': 'polis.publication/1', 'repository': REPO, 'stable': C,
            'tag': 'v2.42.0', 'plan': copy.deepcopy(PLAN), 'notes_data': copy.deepcopy(NOTES),
            'notes': m.render_notes(REPO, PLAN, C, NOTES)}


class ReleaseTests(unittest.TestCase):
    def setUp(self):
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        self.root = Path(temp.name)
        # The rate-limit read is a live gh call; tests that need it use the real one.
        budget = patch.object(m, 'require_api_budget', return_value=m.PUBLICATION_CALLS)
        self.budget = budget.start()
        self.addCleanup(budget.stop)
        (self.root / 'polis-cli').mkdir()
        (self.root / 'VERSION').write_text('2.41.0\n')
        (self.root / 'polis-cli/Cargo.toml').write_text('[workspace.package]\nversion = "2.41.0"\n[dependencies]\nfoo = "1.0"\n')
        (self.root / 'polis-cli/Cargo.lock').write_text(
            '[[package]]\nname = "polis"\nversion = "2.41.0"\n\n'
            '[[package]]\nname = "polis-client"\nversion = "2.41.0"\n\n'
            '[[package]]\nname = "dependency"\nversion = "2.41.0"\n')

    def test_mirrors_change_only_local_versions(self):
        changes = m.mirror_changes(self.root, '2.42.0')
        self.assertEqual(set(changes), set(m.MIRRORS))
        self.assertEqual(changes['VERSION'], '2.42.0\n')
        self.assertIn('foo = "1.0"', changes['polis-cli/Cargo.toml'])
        self.assertIn('name = "dependency"\nversion = "2.41.0"', changes['polis-cli/Cargo.lock'])
        self.assertEqual(changes['polis-cli/Cargo.lock'].count('version = "2.42.0"'), 2)
        self.assertEqual((self.root / 'VERSION').read_text(), '2.41.0\n')

    def test_unrecognized_mirrors_fail(self):
        for path in m.MIRRORS[1:]:
            old = (self.root / path).read_text()
            (self.root / path).write_text('unexpected')
            with self.assertRaises(ValueError):
                m.mirror_changes(self.root, '2.42.0')
            (self.root / path).write_text(old)

    def test_canonical_identifiers(self):
        for value in ['short', 'A' * 40, C + '\n', '--help']:
            with self.assertRaises(ValueError):
                m.sha(value)
        for value in ['../repo', 'example/repo/extra', 'example/repo\n', '-x']:
            with self.assertRaises(ValueError):
                m.repository(value)

    def test_plan_section_preserves_other_prose_and_is_idempotent(self):
        body = 'Operator checklist\n'
        section = m.plan_section(PLAN)
        updated = m.replace_section(body, section)
        self.assertTrue(updated.startswith(body))
        self.assertIn('2.42.0', updated)
        self.assertIn('000020_add_index.sql', updated)
        self.assertEqual(m.replace_section(updated, section), updated)
        for broken in [m.BEGIN, m.END, m.END + m.BEGIN, m.BEGIN + m.BEGIN + m.END]:
            with self.assertRaises(ValueError):
                m.replace_section(broken, section)

    def test_notes_minor_patch_bootstrap_and_escape(self):
        text = m.render_notes(REPO, PLAN, C, NOTES)
        self.assertIn('schema: yes', text)
        self.assertIn('000020_add_index.sql', text)
        self.assertIn('PR #10', text)
        self.assertIn('/compare/v2.41.0...' + C, text)
        plan = dict(PLAN, release_lines=[], previous_tag=None)
        notes = copy.deepcopy(NOTES)
        notes['prs'][0]['title'] = '<script>\n[link](bad)'
        notes['direct_commits'] = [{'commit': B, 'title': 'Direct fix'}]
        text = m.render_notes(REPO, plan, C, notes)
        self.assertIn('schema: no\n\nMigrations:\nnone', text)
        self.assertNotIn('<script>', text)
        self.assertIn('review explicitly', text)
        self.assertIn('/compare/' + A + '...' + C, text)
        self.assertEqual(text, m.render_notes(REPO, plan, C, notes))

    def test_associations_deduplicate_exclude_administrative_and_show_unmatched(self):
        feature = {'number': 10, 'title': 'Feature', 'merged_at': '2026-01-01',
                   'merge_commit_sha': B, 'head': {'ref': 'feature'}, 'base': {'ref': 'edge'}}
        prep = dict(feature, number=11, merge_commit_sha='1' * 40,
                    head={'ref': 'polis-release/prepare-abc'})
        promotion = dict(feature, number=20, merge_commit_sha=C, base={'ref': 'stable'})
        def query(repo, path):
            if path == f'commits/{C}/pulls': return [promotion]
            if path in [f'commits/{B}/pulls', f'commits/{"2" * 40}/pulls']: return [feature, promotion]
            if path == f'commits/{"1" * 40}/pulls': return [prep]
            if path == 'pulls/10/files': return [{'filename': 'server/code.ts'}]
            if path == 'pulls/11/files': return [{'filename': 'VERSION'}]
            return []
        def read(*args):
            if args[0] == 'rev-list': return '\n'.join([B, '2' * 40, '1' * 40, '3' * 40])
            return 'Direct change'
        with patch.object(m, 'pages', side_effect=query) as calls, patch.object(m, 'git', side_effect=read):
            result = m.notes_data(REPO, A, C, B)
        self.assertEqual(calls.call_count, 6)
        self.assertNotIn('pulls/10/files', [call.args[1] for call in calls.call_args_list])
        self.assertEqual([p['number'] for p in result['prs']], [10])
        self.assertEqual([p['commit'] for p in result['direct_commits']], ['3' * 40])

    def test_pagination_and_ambiguous_promotion_fail_closed(self):
        with patch.object(m, 'api', side_effect=[[{}] * 100, [{'last': True}]]) as call:
            self.assertEqual(len(m.pages(REPO, 'pulls?state=open')), 101)
            self.assertIn('&per_page=100&page=2', call.call_args.args[1])
        with patch.object(m, 'git', return_value=B), patch.object(m, 'pages', return_value=[]):
            with self.assertRaisesRegex(ValueError, 'exactly one'):
                m.notes_data(REPO, A, C, B)

    def test_remote_tags_peeled_and_movement(self):
        output = f'{"9" * 40}\trefs/tags/v2.41.0\n{A}\trefs/tags/v2.41.0^{{}}\n{B}\trefs/tags/cli-v9.0.0'
        with patch.object(m, 'git', return_value=output):
            m.check_remote_tags({'v2.41.0': A})
            with self.assertRaises(ValueError):
                m.check_remote_tags({'v2.41.0': B})

    def test_api_missing_only_for_404_and_patch_method(self):
        for status, missing in [(404, True), (403, False), (500, False)]:
            error = subprocess.CalledProcessError(1, 'gh', stderr=f'HTTP {status}')
            with patch.object(m, 'run', side_effect=error):
                if missing:
                    self.assertIsNone(m.api(REPO, 'git/ref/heads/example', missing=True))
                else:
                    with self.assertRaises(subprocess.CalledProcessError):
                        m.api(REPO, 'git/ref/heads/example', missing=True)
        with patch.object(m, 'run', return_value='{}') as run:
            m.api(REPO, 'issues/10', data={'body': 'hello'}, method='PATCH')
            self.assertIn('PATCH', run.call_args.args[0])

    def test_compute_retry_omits_only_matching_current_tag(self):
        from contextlib import contextmanager
        inventories = []
        @contextmanager
        def view(inventory):
            inventories.append(inventory)
            yield self.root
        with patch.object(m, 'tags', return_value={'v2.41.0': A, 'v2.42.0': C}), \
             patch.object(m, 'check_remote_tags'), patch.object(m, 'compute_view', view), \
             patch.object(m, 'run', return_value=json.dumps(PLAN)):
            self.assertEqual(m.compute('tool', A, B, pending=('v2.42.0', C)), PLAN)
            self.assertEqual(inventories, [{'v2.41.0': A}])
            with self.assertRaisesRegex(ValueError, 'different commit'):
                m.compute('tool', A, B, pending=('v2.42.0', B))

    def test_prepare_dry_run_has_no_writes(self):
        with patch.object(m, 'remote_head', side_effect=lambda b: A if b == 'stable' else B), \
             patch.object(m, 'git', return_value=B), patch.object(m, 'compute', return_value=PLAN), \
             patch.object(m, 'api') as api, patch.object(m, 'run') as run:
            self.assertEqual(m.prepare(REPO, 'tool', B), PLAN)
            api.assert_not_called()
            run.assert_not_called()

    def test_prepare_stale_candidate_stops_before_compute(self):
        with patch.object(m, 'remote_head', return_value=A), patch.object(m, 'compute') as compute:
            with self.assertRaises(ValueError):
                m.prepare(REPO, 'tool', B, open_pr=True)
            compute.assert_not_called()

    def test_prepare_writes_version_then_prs_with_only_mirrors(self):
        calls = []
        original = {path: (self.root / path).read_text() for path in m.MIRRORS}
        def request(repo, path, **kwargs):
            calls.append((path, kwargs))
            if path == 'git/trees': return {'sha': TREE}
            if path.startswith('git/ref/'): return None
            return {'sha': C}
        def read(*args):
            if args[0] == 'rev-parse': return B
            return original[args[1].split(':', 1)[1]].rstrip('\n')
        with patch.object(m, 'ROOT', self.root), patch.object(m, 'remote_head', side_effect=lambda b: A if b == 'stable' else B), \
             patch.object(m, 'git', side_effect=read), patch.object(m, 'compute', return_value=PLAN), \
             patch.object(m, 'run', return_value=json.dumps(PLAN)) as run, \
             patch.object(m, 'api', side_effect=request), patch.object(m, 'upsert_pr', return_value={'html_url': 'url'}) as prs:
            result = m.prepare(REPO, 'tool', B, open_pr=True)
        self.assertTrue(result['preparation_needed'])
        self.assertIn('--write', run.call_args.args[0])
        self.assertEqual({e['path'] for e in calls[0][1]['data']['tree']}, set(m.MIRRORS))
        entries = {e['path']: e['content'] for e in calls[0][1]['data']['tree']}
        self.assertEqual(entries, {path: (self.root / path).read_text() for path in m.MIRRORS})
        self.assertEqual(entries['VERSION'], PLAN['version'] + '\n')
        cargo = tomllib.loads(entries['polis-cli/Cargo.toml'])
        lock = tomllib.loads(entries['polis-cli/Cargo.lock'])
        self.assertEqual(cargo['workspace']['package']['version'], PLAN['version'])
        self.assertEqual({p['name']: p['version'] for p in lock['package']},
                         {'polis': PLAN['version'], 'polis-client': PLAN['version'], 'dependency': '2.41.0'})
        self.assertEqual(calls[1][0].split('/')[:3], ['git', 'ref', 'heads'])
        self.assertEqual(prs.call_count, 2)
        self.assertEqual(prs.call_args.args[1:3], ('edge', 'stable'))

    def test_prepare_rejects_malformed_mirrors_before_any_write(self):
        (self.root / 'polis-cli/Cargo.lock').write_text('unexpected')
        with patch.object(m, 'ROOT', self.root), \
             patch.object(m, 'remote_head', side_effect=lambda b: A if b == 'stable' else B), \
             patch.object(m, 'git', return_value=B), patch.object(m, 'compute', return_value=PLAN), \
             patch.object(m, 'run') as run, patch.object(m, 'api') as api:
            with self.assertRaisesRegex(ValueError, 'lock mirror'):
                m.prepare(REPO, 'tool', B, open_pr=True)
            run.assert_not_called()
            api.assert_not_called()
        self.assertEqual((self.root / 'VERSION').read_text(), '2.41.0\n')

    def test_prepared_candidate_needs_no_second_version_pr(self):
        for path, content in m.mirror_changes(self.root, PLAN['version']).items():
            (self.root / path).write_text(content)
        def read(*args):
            if args[0] == 'rev-parse': return B
            return (self.root / args[1].split(':', 1)[1]).read_text().rstrip('\n')
        with patch.object(m, 'ROOT', self.root), \
             patch.object(m, 'remote_head', side_effect=lambda b: A if b == 'stable' else B), \
             patch.object(m, 'git', side_effect=read), patch.object(m, 'compute', return_value=PLAN), \
             patch.object(m, 'run', return_value=json.dumps(PLAN)), patch.object(m, 'api') as api, \
             patch.object(m, 'upsert_pr', return_value={'html_url': 'url'}) as prs:
            result = m.prepare(REPO, 'tool', B, open_pr=True)
            self.assertFalse(result['preparation_needed'])
            api.assert_not_called()
            prs.assert_called_once()
            self.assertEqual(prs.call_args.args[1:3], ('edge', 'stable'))

    def test_existing_preparation_branch_never_overwritten(self):
        def request(repo, path, **kwargs):
            if path == 'git/trees': return {'sha': TREE}
            if path.startswith('git/ref/'): return {'object': {'sha': C}}
            if path.startswith('git/commits/'): return {'tree': {'sha': A}, 'parents': [{'sha': B}]}
            self.fail('Unexpected mutation')
        with patch.object(m, 'ROOT', self.root), patch.object(m, 'remote_head', side_effect=lambda b: A if b == 'stable' else B), \
             patch.object(m, 'git', side_effect=lambda *a: B if a[0] == 'rev-parse' else 'old'), \
             patch.object(m, 'compute', return_value=PLAN), patch.object(m, 'run', return_value=json.dumps(PLAN)), \
             patch.object(m, 'api', side_effect=request), patch.object(m, 'upsert_pr') as prs:
            with self.assertRaisesRegex(ValueError, 'refusing to overwrite'):
                m.prepare(REPO, 'tool', B, open_pr=True)
            prs.assert_not_called()

    def test_environment_is_required_and_cannot_be_bypassed(self):
        good = {'id': 7, 'protection_rules': [
            {'type': 'required_reviewers', 'reviewers': [{'type': 'User', 'reviewer': {'login': 'release-owner'}}]}]}
        with patch.object(m, 'api', return_value=good):
            m.gate(REPO, 'release-owner')
        for bad in [{}, dict(good, protection_rules=[])]:
            with patch.object(m, 'api', return_value=bad), self.assertRaises(ValueError):
                m.gate(REPO, 'release-owner')
        with patch.object(m, 'api', return_value=good), self.assertRaises(ValueError):
            m.gate(REPO, 'someone-else')
        with self.assertRaises(ValueError):
            m.gate(REPO, '')

    def test_approval_history_rejects_bypass_other_reviewer_and_old_attempt(self):
        env = {'GITHUB_ACTIONS': 'true', 'GITHUB_RUN_ID': '123', 'GITHUB_RUN_ATTEMPT': '1'}
        good = [{'state': 'approved', 'user': {'login': 'release-owner'}, 'environments': [{'id': 7}]}]
        with patch.dict(m.os.environ, env), patch.object(m, 'api', return_value=good):
            m.approved_run(REPO, 'release-owner', 7)
        for history in [[], [dict(good[0], state='rejected')],
                        [dict(good[0], user={'login': 'other'})],
                        [dict(good[0], environments=[{'id': 8}])]]:
            with patch.dict(m.os.environ, env), patch.object(m, 'api', return_value=history), self.assertRaises(ValueError):
                m.approved_run(REPO, 'release-owner', 7)
        for change in [{'GITHUB_ACTIONS': 'false'}, {'GITHUB_RUN_ATTEMPT': '2'}, {'GITHUB_RUN_ID': 'bad'}]:
            with patch.dict(m.os.environ, dict(env, **change)), patch.object(m, 'api') as api, self.assertRaises(ValueError):
                m.approved_run(REPO, 'release-owner', 7)
            api.assert_not_called()

    def stable_git(self, *args):
        if args == ('rev-parse', 'HEAD'): return C
        if args == ('show', '-s', '--format=%P', C): return A + ' ' + B
        if args[0] == 'rev-parse': return TREE
        if args[0] == 'show':
            path = args[1].split(':', 1)[1]
            if path.endswith('update.rs'): return 'tag.strip_prefix("v")'
            return m.mirror_changes(self.root, '2.42.0')[path].strip()
        self.fail(str(args))

    def test_stable_packet_and_mismatch_guards(self):
        with patch.object(m, 'ROOT', self.root), patch.object(m, 'git', side_effect=self.stable_git), \
             patch.object(m, 'remote_head', return_value=C), patch.object(m, 'compute', return_value=PLAN), \
             patch.object(m, 'notes_data', return_value=NOTES):
            self.assertEqual(m.release_packet(REPO, 'tool', C), packet())
            with patch.object(m, 'compute', return_value=dict(PLAN, version='2.43.0')):
                with self.assertRaisesRegex(ValueError, 'computed'):
                    m.release_packet(REPO, 'tool', C)
            with patch.object(m, 'remote_head', return_value=A):
                with self.assertRaisesRegex(ValueError, 'current stable'):
                    m.release_packet(REPO, 'tool', C)
            with patch.object(m, 'git', return_value=C):
                with self.assertRaisesRegex(ValueError, 'two-parent'):
                    m.release_packet(REPO, 'tool', C)

    def test_workflow_reuses_notes_until_final_live_check_with_bounded_api_calls(self):
        # Model 300 ordinary promoted commits and drive the same CLI actions as
        # plan, four native builds, review/commands, and approved publication.
        commits = [f'{i:040x}' for i in range(1, 300)] + [B]
        prs = {commit: {'number': i + 1, 'title': f'Change {i}', 'merged_at': '2026-01-01',
                        'merge_commit_sha': commit, 'head': {'ref': 'feature'},
                        'base': {'ref': 'edge'}} for i, commit in enumerate(commits)}
        promotion = dict(prs[B], number=1000, merge_commit_sha=C, base={'ref': 'stable'})
        calls = []
        def request(repo, path, **kwargs):
            calls.append(path)
            if path == f'commits/{C}/pulls?per_page=100&page=1':
                return [promotion]
            if path.startswith('commits/'):
                return [prs[path.split('/')[1]]]
            if path == 'releases?per_page=100&page=1':
                return []
            if path == 'git/tags':
                return {'sha': TREE}
            if path == 'git/refs':
                return {}
            self.fail(path)
        def read(*args):
            if args[0] == 'rev-list':
                return '\n'.join(commits)
            return self.stable_git(*args)
        def invoke(action, *args):
            with patch('sys.argv', ['polis_release.py', action, '--tool', __file__, *args]), \
                 patch('builtins.print'):
                m.main()
        assets = self.bundle()
        publisher = m.load_publisher()
        review = self.root / 'review'
        manual = self.root / 'commands.sh'
        with patch.object(m, 'ROOT', self.root), patch.object(m, 'git', side_effect=read), \
             patch.object(m, 'remote_head', return_value=C), patch.object(m, 'compute', return_value=PLAN), \
             patch.object(m, 'api', side_effect=request), patch.object(m, 'gate'), \
             patch.object(m, 'approved_run'), patch.object(m, 'tags', return_value={}), \
             patch.object(m, 'check_remote_tags'), patch.object(m, 'load_publisher', return_value=publisher), \
             patch.object(publisher, 'publish') as publish, \
             patch.object(m, 'notes_data', wraps=m.notes_data) as collect:
            invoke('plan', '--stable', C, '--repository', REPO, '--output', str(review))
            self.assertEqual(len(calls), 301)
            for _ in range(4):
                invoke('source', '--stable', C, '--repository', REPO)
            invoke('verify', '--snapshot-notes', '--commands-output', str(manual),
                   '--packet', str(review / 'publication.json'), '--assets', str(assets))
            self.assertEqual(len(calls), 301)
            self.assertEqual(collect.call_count, 1)
            self.assertIn('gh release create', manual.read_text())
            invoke('publish', '--packet', str(review / 'publication.json'), '--assets', str(assets))
            self.assertEqual(collect.call_count, 2)  # Preserve the postapproval live check.
            self.assertEqual(len(calls), 605)  # 602 notes reads, release list, tag object/ref.
            publish.assert_called_once()
            # Rate-limit reads: before the live notes check, then before the tag.
            self.assertEqual([call.kwargs for call in self.budget.call_args_list],
                             [{'live_notes': True}, {'live_notes': False}])
            # A later PR title change still refuses before any publication write.
            prs[B]['title'] = 'Changed after review'
            publish.reset_mock()
            with self.assertRaisesRegex(ValueError, 'notes changed'):
                m.publication(json.loads((review / 'publication.json').read_text()), assets,
                              'tool', execute=True)
            publish.assert_not_called()

    def test_snapshot_verification_still_checks_source_and_rendered_notes(self):
        with patch.object(m, 'ROOT', self.root), patch.object(m, 'git', side_effect=self.stable_git), \
             patch.object(m, 'remote_head', return_value=C), patch.object(m, 'compute', return_value=PLAN), \
             patch.object(m, 'notes_data') as notes:
            m.verify_packet(packet(), REPO, 'tool', snapshot_notes=True)
            for changed in [dict(packet(), notes='edited'), dict(packet(), tag='v2.43.0')]:
                with self.assertRaises(ValueError):
                    m.verify_packet(changed, REPO, 'tool', snapshot_notes=True)
            with patch.object(m, 'remote_head', return_value=A), self.assertRaises(ValueError):
                m.verify_packet(packet(), REPO, 'tool', snapshot_notes=True)
            notes.assert_not_called()
        with patch.object(m, 'verify_packet') as verify:
            with self.assertRaisesRegex(ValueError, 'must recheck live'):
                m.publication(packet(), self.root, 'tool', execute=True, snapshot_notes=True)
            verify.assert_not_called()

    def test_publication_refuses_each_unprepared_mirror(self):
        for path in m.MIRRORS[1:]:
            def read(*args):
                if args == ('show', f'{C}:{path}'):
                    return (self.root / path).read_text().rstrip('\n')
                return self.stable_git(*args)
            with self.subTest(path=path), patch.object(m, 'ROOT', self.root), \
                 patch.object(m, 'git', side_effect=read), patch.object(m, 'remote_head', return_value=C), \
                 patch.object(m, 'compute', return_value=PLAN), patch.object(m, 'notes_data') as notes:
                with self.assertRaisesRegex(ValueError, 'mirrors were not prepared'):
                    m.release_packet(REPO, 'tool', C)
                notes.assert_not_called()

    def test_packet_revalidation_binds_titles_and_all_inputs(self):
        original = packet()
        for key, value in [('stable', A), ('tag', 'v2.43.0'), ('notes', 'edited')]:
            with patch.object(m, 'release_packet', return_value=dict(original, **{key: value})):
                with self.assertRaises(ValueError):
                    m.verify_packet(original, REPO, 'tool')

    def bundle(self):
        assets = self.root / 'assets'
        publisher = m.load_publisher()
        for target in publisher.build.TARGETS:
            publisher.build.package(assets, b'generated binary', '2.42.0', C, target,
                                    'clean-checkout', 'rustc fixture', b'lock', b'license')
        return assets

    def test_verify_and_prepared_commands_never_execute_writes(self):
        assets = self.bundle()
        with patch.object(m, 'verify_packet'), patch.object(m, 'api') as api, patch.object(m, 'run') as run, \
             patch.object(m, 'tags', return_value={}), patch.object(m, 'check_remote_tags'):
            result = m.publication(packet(), assets, 'tool')
            text = m.commands(packet(), assets, 'tool', self.root / 'publication.json')
            self.assertEqual(len(result['assets']), 8)
            self.assertIn(f'git tag -a v2.42.0 {C}', text)
            self.assertIn('gh release create v2.42.0', text)
            self.assertIn('--notes-file', text)
            self.assertNotIn('--generate-notes', text)
            api.assert_not_called()
            run.assert_not_called()

    def test_no_public_write_before_gate_and_complete_assets(self):
        assets = self.bundle()
        with patch.object(m, 'verify_packet'), patch.object(m, 'gate', side_effect=ValueError('gate')) as gate, \
             patch.object(m, 'api') as api:
            with self.assertRaisesRegex(ValueError, 'gate'):
                m.publication(packet(), assets, 'tool', execute=True, reviewer='release-owner')
            api.assert_not_called()
            next(assets.glob('*.tar.gz')).unlink()
            gate.reset_mock()
            with self.assertRaises(ValueError):
                m.publication(packet(), assets, 'tool', execute=True, reviewer='release-owner')
            gate.assert_not_called()
            api.assert_not_called()

    def test_publish_tag_then_draft_upload_publish_once(self):
        assets = self.bundle()
        publisher = m.load_publisher()
        with patch.object(m, 'verify_packet'), patch.object(m, 'gate'), patch.object(m, 'approved_run'), \
             patch.object(m, 'api', side_effect=[[], {'sha': TREE}, {}]) as api, patch.object(m, 'remote_head', return_value=C), \
             patch.object(m, 'tags', return_value={'v2.41.0': A}), patch.object(m, 'check_remote_tags'), \
             patch.object(m, 'load_publisher', return_value=publisher), patch.object(publisher, 'publish') as publish:
            self.assertEqual(m.publication(packet(), assets, 'tool', execute=True), {'published': 'v2.42.0'})
            self.assertEqual(api.call_args.kwargs['data'], {'ref': 'refs/tags/v2.42.0', 'sha': TREE})
            self.assertEqual(api.call_args_list[1].kwargs['data'],
                             {'tag': 'v2.42.0', 'message': m.tag_annotation(packet()),
                              'object': C, 'type': 'commit'})
            self.assertEqual(publish.call_count, 1)

    def expected_annotation(self, value):
        plan = value['plan']
        return (f"Polis {plan['version']}\n"
                f"Previous: {plan['previous_tag'] or plan['previous_stable_commit']}\n"
                f"Stable: {value['stable']}\nSource: {plan['candidate_commit']}\n"
                f"Promotion: https://github.com/{REPO}/pull/20\n"
                + ('schema: yes\nMigrations:\n- 000020_add_index.sql\n' if plan['release_lines']
                   else 'schema: no\nMigrations:\nnone\n'))

    def test_annotation_covers_migration_patch_and_bootstrap(self):
        value = packet()
        self.assertEqual(m.tag_annotation(value), self.expected_annotation(value))
        value['plan'].update(previous_tag=None, release_lines=[])
        self.assertEqual(m.tag_annotation(value), self.expected_annotation(value))
        self.assertIn('Previous: ' + A, m.tag_annotation(value))
        self.assertIn('schema: no\nMigrations:\nnone\n', m.tag_annotation(value))

    def test_existing_tag_requires_annotation_exact_message_and_commit_target(self):
        value = packet()
        ref = {'object': {'type': 'tag', 'sha': TREE}}
        obj = {'tag': value['tag'], 'object': {'type': 'commit', 'sha': C},
               'message': self.expected_annotation(value)}
        with patch.object(m, 'api', side_effect=[ref, obj]) as api:
            m.verify_tag_annotation(value)
            self.assertEqual([call.args[1] for call in api.call_args_list],
                             ['git/ref/tags/v2.42.0', 'git/tags/' + TREE])
        for change in [{'tag': 'v2.43.0'}, {'object': {'type': 'commit', 'sha': B}},
                       {'object': {'type': 'tag', 'sha': C}}, {'message': 'Polis 2.42.0\n'}]:
            with self.subTest(change=change), patch.object(m, 'api', side_effect=[ref, dict(obj, **change)]):
                with self.assertRaisesRegex(ValueError, 'annotation or target differs'):
                    m.verify_tag_annotation(value)
        with patch.object(m, 'api', return_value={'object': {'type': 'commit', 'sha': C}}):
            with self.assertRaisesRegex(ValueError, 'must be annotated'):
                m.verify_tag_annotation(value)

    def test_existing_matching_tag_is_reused_without_ref_write(self):
        assets = self.bundle()
        publisher = m.load_publisher()
        with patch.object(m, 'verify_packet'), patch.object(m, 'gate'), patch.object(m, 'approved_run'), \
             patch.object(m, 'api', return_value=[]) as api, patch.object(m, 'remote_head', return_value=C), \
             patch.object(m, 'tags', return_value={'v2.42.0': C}), patch.object(m, 'check_remote_tags'), \
             patch.object(m, 'verify_tag_annotation') as annotation, \
             patch.object(m, 'load_publisher', return_value=publisher), patch.object(publisher, 'publish') as publish:
            self.assertEqual(m.publication(packet(), assets, 'tool', execute=True), {'published': 'v2.42.0'})
            annotation.assert_called_once_with(packet())
            self.assertEqual(api.call_count, 1)
            publish.assert_called_once()
            annotation.side_effect = ValueError('annotation mismatch')
            publish.reset_mock()
            with self.assertRaisesRegex(ValueError, 'annotation mismatch'):
                m.publication(packet(), assets, 'tool', execute=True)
            publish.assert_not_called()

    def test_verify_checks_existing_annotation_without_writes(self):
        assets = self.bundle()
        with patch.object(m, 'verify_packet'), patch.object(m, 'tags', return_value={'v2.42.0': C}), \
             patch.object(m, 'check_remote_tags'), patch.object(m, 'verify_tag_annotation') as annotation, \
             patch.object(m, 'api') as api:
            self.assertEqual(len(m.publication(packet(), assets, 'tool')['assets']), 8)
            annotation.assert_called_once_with(packet())
            api.assert_not_called()
            annotation.side_effect = ValueError('annotation mismatch')
            with self.assertRaisesRegex(ValueError, 'annotation mismatch'):
                m.publication(packet(), assets, 'tool')

    def test_ref_collision_never_publishes_or_updates_ref(self):
        assets = self.bundle()
        publisher = m.load_publisher()
        with patch.object(m, 'verify_packet'), patch.object(m, 'gate'), patch.object(m, 'approved_run'), \
             patch.object(m, 'api', side_effect=[[], {'sha': TREE}, ValueError('ref exists')]) as api, \
             patch.object(m, 'remote_head', return_value=C), patch.object(m, 'tags', return_value={}), \
             patch.object(m, 'check_remote_tags'), patch.object(m, 'load_publisher', return_value=publisher), \
             patch.object(publisher, 'publish') as publish:
            with self.assertRaisesRegex(ValueError, 'ref exists'):
                m.publication(packet(), assets, 'tool', execute=True)
            self.assertEqual(api.call_count, 3)
            self.assertEqual(api.call_args.args[1], 'git/refs')
            self.assertNotIn('method', api.call_args.kwargs)
            publish.assert_not_called()

    def test_both_paths_store_identical_annotation_and_peel_to_stable_merge(self):
        # All objects/refs live in a disposable repository with no remote.
        root = self.root / 'tag-repository'
        root.mkdir()
        env = dict(os.environ, GIT_CONFIG_NOSYSTEM='1', GIT_CONFIG_GLOBAL=os.devnull,
                   GIT_COMMITTER_NAME='Release Test', GIT_COMMITTER_EMAIL='release@example.invalid')
        def git(*args, data=None):
            return subprocess.run(['git', '-C', str(root), *args], input=data, text=True,
                                  capture_output=True, check=True, env=env).stdout.rstrip('\n')
        git('init', '--quiet')
        tree = git('mktree', data='')
        def commit(label, parents=()):
            text = f'tree {tree}\n' + ''.join(f'parent {p}\n' for p in parents)
            text += ('author Release Test <release@example.invalid> 1700000000 +0000\n'
                     'committer Release Test <release@example.invalid> 1700000000 +0000\n\n' + label + '\n')
            return git('hash-object', '-w', '-t', 'commit', '--stdin', data=text)
        previous = commit('previous')
        source = commit('source', [previous])
        stable = commit('promotion', [previous, source])
        value = packet()
        value['stable'] = stable
        value['plan'].update(previous_stable_commit=previous, candidate_commit=source)
        for bootstrap in [False, True]:
            with self.subTest(bootstrap=bootstrap):
                if bootstrap:
                    value['plan'].update(previous_tag=None, release_lines=[], version='2.42.1')
                    value['tag'] = 'v2.42.1'
                tag = value['tag']
                expected = self.expected_annotation(value)
                assets = self.root / ('tag-assets-' + tag)
                publisher = m.load_publisher()
                for target in publisher.build.TARGETS:
                    publisher.build.package(assets, b'generated binary', value['plan']['version'], stable,
                                            target, 'clean-checkout', 'rustc fixture', b'lock', b'license')
                writes = []
                def api(repo, path, *, data=None, **kwargs):
                    if path == 'releases?per_page=100&page=1':
                        return []
                    writes.append((path, data))
                    if path == 'git/tags':
                        content = (f"object {data['object']}\ntype {data['type']}\ntag {data['tag']}\n"
                                   'tagger Release Test <release@example.invalid> 1700000000 +0000\n\n'
                                   + data['message'])
                        return {'sha': git('mktag', data=content)}
                    if path == 'git/refs':
                        git('update-ref', data['ref'], data['sha'], '0' * 40)
                        return {}
                    self.fail(path)
                with patch.object(m, 'verify_packet'), patch.object(m, 'gate'), patch.object(m, 'approved_run'), \
                     patch.object(m, 'api', side_effect=api), patch.object(m, 'remote_head', return_value=stable), \
                     patch.object(m, 'tags', return_value={}), patch.object(m, 'check_remote_tags'), \
                     patch.object(m, 'load_publisher', return_value=publisher), patch.object(publisher, 'publish'):
                    m.publication(value, assets, 'tool', execute=True)
                api_object = git('cat-file', '-p', tag)
                self.assertEqual(git('cat-file', '-t', tag), 'tag')
                self.assertEqual(git('rev-parse', tag + '^{}'), stable)
                self.assertEqual(api_object.split('\n\n', 1)[1] + '\n', expected)
                self.assertEqual([path for path, _ in writes], ['git/tags', 'git/refs'])
                git('update-ref', '-d', 'refs/tags/' + tag)
                # Only execute the printed tag command; no push/release command runs.
                with patch.object(m, 'api') as calls, patch.object(m, 'run') as runs:
                    script = m.commands(value, assets, 'tool', root / 'publication.json')
                    calls.assert_not_called()
                    runs.assert_not_called()
                argv = shlex.split(script, comments=True)
                start = argv.index('git')
                end = argv.index('git', start + 1)
                tag_command = argv[start:end]
                self.assertEqual(tag_command[:4], ['git', 'tag', '-a', tag])
                git(*tag_command[1:])
                manual_object = git('cat-file', '-p', tag)
                self.assertEqual(git('cat-file', '-t', tag), 'tag')
                self.assertEqual(git('rev-parse', tag + '^{}'), stable)
                self.assertEqual(manual_object.split('\n\n', 1)[1] + '\n', expected)
                self.assertEqual(manual_object.split('\n\n', 1)[1], api_object.split('\n\n', 1)[1])

    def test_partial_draft_on_later_page_refuses_retry_before_any_write(self):
        assets = self.bundle()
        calls = []
        def request(repo, path, **kwargs):
            calls.append(path)
            self.assertFalse(kwargs)
            if path == 'releases/tags/v2.42.0':
                return None  # GitHub's tag endpoint cannot find this draft.
            if path == 'releases?per_page=100&page=1':
                return [{'tag_name': f'v1.0.{i}'} for i in range(100)]
            if path == 'releases?per_page=100&page=2':
                return [{'tag_name': 'v2.42.0', 'draft': True}]
            self.fail(path)
        with patch.object(m, 'verify_packet'), patch.object(m, 'gate'), patch.object(m, 'approved_run'), \
             patch.object(m, 'api', side_effect=request), patch.object(m, 'run') as run:
            with self.assertRaisesRegex(ValueError, 'partial draft'):
                m.publication(packet(), assets, 'tool', execute=True)
            run.assert_not_called()
        self.assertEqual(calls, ['releases?per_page=100&page=1', 'releases?per_page=100&page=2'])

    def test_duplicate_drafts_or_published_plus_draft_refuse(self):
        assets = self.bundle()
        for drafts in [(True, True), (False, True)]:
            releases = [{'tag_name': 'v2.42.0', 'draft': draft} for draft in drafts]
            with self.subTest(drafts=drafts), patch.object(m, 'verify_packet'), \
                 patch.object(m, 'gate'), patch.object(m, 'approved_run'), \
                 patch.object(m, 'api', return_value=releases), patch.object(m, 'run') as run:
                with self.assertRaisesRegex(ValueError, 'Multiple releases'):
                    m.publication(packet(), assets, 'tool', execute=True)
                run.assert_not_called()

    def test_successful_retry_compares_every_remote_asset_and_is_noop(self):
        import shutil
        assets = self.bundle()
        existing = {'tag_name': 'v2.42.0', 'draft': False, 'prerelease': False, 'body': packet()['notes'], 'name': 'Polis 2.42.0'}
        def download(args, **kwargs):
            self.assertEqual(args[:3], ['gh', 'release', 'download'])
            for path in assets.iterdir(): shutil.copy2(path, Path(args[-1]) / path.name)
            return ''
        with patch.object(m, 'verify_packet'), patch.object(m, 'gate'), patch.object(m, 'approved_run'), \
             patch.object(m, 'api', return_value=[existing]) as api, patch.object(m, 'run', side_effect=download), \
             patch.object(m, 'tags', return_value={'v2.42.0': C}), patch.object(m, 'check_remote_tags'), \
             patch.object(m, 'verify_tag_annotation') as annotation:

            self.assertEqual(m.publication(packet(), assets, 'tool', execute=True), {'already_published': True})
            self.assertEqual(api.call_count, 1)
            annotation.assert_called_once_with(packet())

    def test_existing_release_without_matching_tag_is_not_a_successful_retry(self):
        assets = self.bundle()
        existing = {'tag_name': 'v2.42.0', 'draft': False, 'prerelease': False, 'body': packet()['notes'], 'name': 'Polis 2.42.0'}
        with patch.object(m, 'verify_packet'), patch.object(m, 'gate'), patch.object(m, 'approved_run'), \
             patch.object(m, 'api', return_value=[existing]), patch.object(m, 'tags', return_value={}), \
             patch.object(m, 'check_remote_tags'), patch.object(m, 'run') as run:
            with self.assertRaisesRegex(ValueError, 'matching immutable tag'):
                m.publication(packet(), assets, 'tool', execute=True)
            run.assert_not_called()

    @staticmethod
    def rate_limit(remaining):
        return json.dumps({'resources': {'core': {'limit': 1000, 'remaining': remaining, 'reset': 1700000000}}})

    def test_api_budget_counts_promoted_commits_only_for_the_live_notes_check(self):
        def read(*args):
            self.assertEqual(args, ('rev-list', '--count', f'{A}..{B}'))
            return '300'
        for live_notes, needed in [(True, 300 + 2 + m.PUBLICATION_CALLS), (False, m.PUBLICATION_CALLS)]:
            for remaining, allowed in [(needed, True), (needed - 1, False)]:
                with self.subTest(live_notes=live_notes, remaining=remaining), \
                     patch.object(m, 'git', side_effect=read) as git, \
                     patch.object(m, 'run', return_value=self.rate_limit(remaining)) as run:
                    if allowed:
                        self.assertEqual(REQUIRE_API_BUDGET(packet(), live_notes=live_notes), needed)
                    else:
                        with self.assertRaisesRegex(ValueError, f'{remaining} calls remain, {needed} needed'):
                            REQUIRE_API_BUDGET(packet(), live_notes=live_notes)
                    run.assert_called_once_with(['gh', 'api', 'rate_limit'])
                    self.assertEqual(git.call_count, 1 if live_notes else 0)

    def test_low_budget_refuses_before_live_notes_and_before_the_tag(self):
        assets = self.bundle()
        publisher = m.load_publisher()
        # First read: one call short of three promoted commits plus publication.
        with patch.object(m, 'require_api_budget', REQUIRE_API_BUDGET), patch.object(m, 'git', return_value='3'), \
             patch.object(m, 'run', return_value=self.rate_limit(3 + 2 + m.PUBLICATION_CALLS - 1)), \
             patch.object(m, 'verify_packet') as verify, patch.object(m, 'gate') as gate, \
             patch.object(m, 'api') as api, patch.object(m, 'load_publisher', return_value=publisher), \
             patch.object(publisher, 'publish') as publish:
            with self.assertRaisesRegex(ValueError, 'budget too low'):
                m.publication(packet(), assets, 'tool', execute=True)
            verify.assert_not_called()
            gate.assert_not_called()
            api.assert_not_called()
            publish.assert_not_called()
        # Second read, after approval and the release list: too low for the writes.
        calls = []
        def request(repo, path, **kwargs):
            calls.append(path)
            if path == 'releases?per_page=100&page=1':
                return []
            self.fail(path)
        with patch.object(m, 'require_api_budget', REQUIRE_API_BUDGET), patch.object(m, 'git', return_value='3'), \
             patch.object(m, 'run', side_effect=[self.rate_limit(1000), self.rate_limit(m.PUBLICATION_CALLS - 1)]), \
             patch.object(m, 'verify_packet') as verify, patch.object(m, 'gate'), patch.object(m, 'approved_run'), \
             patch.object(m, 'api', side_effect=request), patch.object(m, 'remote_head', return_value=C), \
             patch.object(m, 'tags') as tags, patch.object(m, 'check_remote_tags'), \
             patch.object(m, 'load_publisher', return_value=publisher), patch.object(publisher, 'publish') as publish:
            with self.assertRaisesRegex(ValueError, 'budget too low'):
                m.publication(packet(), assets, 'tool', execute=True)
            verify.assert_called_once()
            self.assertEqual(calls, ['releases?per_page=100&page=1'])
            tags.assert_not_called()
            publish.assert_not_called()

    def test_review_verification_reads_no_rate_limit(self):
        assets = self.bundle()
        with patch.object(m, 'require_api_budget', REQUIRE_API_BUDGET), patch.object(m, 'verify_packet'), \
             patch.object(m, 'run') as run, patch.object(m, 'tags', return_value={}), \
             patch.object(m, 'check_remote_tags'):
            self.assertEqual(len(m.publication(packet(), assets, 'tool')['assets']), 8)
            run.assert_not_called()

    def test_cli_entry_plan_writes_review_artifact_only(self):
        with patch.object(m, 'release_packet', return_value=packet()), patch.object(m, 'run') as run, \
             patch('sys.argv', ['polis_release.py', 'plan', '--stable', C, '--repository', REPO,
                                '--tool', __file__, '--output', str(self.root / 'review')]), \
             patch('builtins.print'):
            m.main()
            self.assertEqual(json.loads((self.root / 'review/publication.json').read_text()), packet())
            self.assertEqual((self.root / 'review/notes.md').read_text(), packet()['notes'])
            run.assert_not_called()

    def test_workflow_graph_has_manual_entry_and_single_gated_writer(self):
        root = Path(__file__).resolve().parents[2]
        publication = (root / '.github/workflows/polis-release.yml').read_text()
        prepare = (root / '.github/workflows/polis-promotion-prepare.yml').read_text()
        build = (root / '.github/workflows/polis-cli-release-build.yml').read_text()
        for workflow in (publication, prepare):
            self.assertIn('  workflow_dispatch:', workflow)
            self.assertNotIn('\n  push:', workflow)
            self.assertNotIn('\n  pull_request:', workflow)
        self.assertEqual(publication.count('contents: write'), 1)
        final = publication.split('\n  publish:\n')[1]
        self.assertIn('name: release', final)
        self.assertIn('needs: [plan, build, review]', final)
        self.assertIn('polis_release.py publish', final)
        self.assertNotIn('polis_release.py publish', publication.split('\n  publish:\n')[0])
        self.assertIn('workflow_call:', build)
        self.assertNotIn('contents: write', build)
        self.assertNotIn('push:', build)
        self.assertEqual(build.count('target: '), 4)
        self.assertIn('polis_release.py source --stable', build)
        self.assertNotIn('polis_release.py plan', build)
        self.assertIn('verify --snapshot-notes --commands-output', publication)
        self.assertNotIn('polis_release.py commands', publication)
        self.assertNotIn('--snapshot-notes', final)
        self.assertIn('persist-credentials: false', final)


if __name__ == '__main__':
    unittest.main()
