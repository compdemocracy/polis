#!/usr/bin/env python3
"""Forward compatibility: a release beside migrations it does not list.
Generated databases only, no application rows. Runner and Node gate both."""
import pathlib, shutil, tempfile, unittest
import prove as p

SELECTED = p.SELECTED
HELD = [s for s in (p.MIG/'held.txt').read_text().splitlines() if s and not s.startswith('#')]
COMPAT = dict(l.split(' ') for l in (p.MIG/'compat.txt').read_text().splitlines() if l and not l.startswith('#'))


def release(tmp, drop=(), add=()):
    """A copy of this release without `drop` and with `add` = [(name, sql, compat|None)]."""
    d = pathlib.Path(tmp)/'m'; shutil.copytree(p.MIG, d)
    keep = lambda text: '\n'.join(x for x in text.splitlines() if x.split(' ')[0] not in drop)+'\n'
    for f in ('release.txt', 'compat.txt'):
        (d/f).write_text(keep((d/f).read_text()))
    for name in drop: (d/name).unlink()
    for name, body, compat in add:
        (d/name).write_text(body)
        with (d/'release.txt').open('a') as f: f.write(name+'\n')
        if compat:
            with (d/'compat.txt').open('a') as f: f.write(f'{name} {compat}\n')
    return d


def history(db): return p.sql(db, 'SELECT row_to_json(m) FROM migrations m ORDER BY name')


class ForwardProof(unittest.TestCase):
    def new(self, suffix):
        db = 'forward_'+suffix
        p.sql('postgres', f'CREATE DATABASE {db}')
        return db

    def test_01_ledger_declares_every_migration(self):
        self.assertEqual(set(COMPAT), set(SELECTED) | set(HELD))
        self.assertEqual({k for k, v in COMPAT.items() if v == 'additive'}, {
            '000019_create_polis_queue.sql', '000021_create_polis_coordinator.sql',
            '000022_add_poll_timestamp_indexes.sql', '000023_create_delphi_foundation.sql',
            '000028_create_delphi_results.sql', '000029_extend_delphi_graph_stages.sql',
            '000030_create_delphi_writers.sql', '000031_scope_delphi_result_reads.sql',
            '000038_create_delphi_comment_embeddings.sql', '000039_clear_zinvites_uuid.sql',
            '000041_create_delphi_run_record.sql', '000042_tid_auto_transaction_lock.sql',
            '000043_add_conversation_activity_indexes.sql'})

    def test_02_deploy_records_declarations(self):
        db = self.new('records'); p.runner(db, 'deploy')
        rows = dict(x.split('|') for x in p.sql(db, "SELECT name, coalesce(compat,'-') FROM migrations").splitlines())
        self.assertEqual(rows, {k: v for k, v in COMPAT.items() if k in SELECTED})

    def test_03_rollback_past_additive_migrations_starts(self):
        db = self.new('rollback'); p.runner(db, 'deploy')
        newer = [s for s in SELECTED if s[:6] >= '000028']
        with tempfile.TemporaryDirectory() as tmp:
            old = release(tmp, drop=newer)
            before = history(db)
            out = p.runner(db, 'deploy', dir=old).stdout
            self.assertIn('applied 0 migration(s)', out)
            for name in newer:
                self.assertIn(f'tolerating {name}', out)
            self.assertIn(f'{len(newer)} newer additive migration(s) tolerated', p.runner(db, 'check', dir=old).stdout)
            gate = p.gate(db, True, dir=old)
            self.assertIn('tolerating 000030_create_delphi_writers.sql', gate.stdout)
            self.assertEqual(before, history(db))
        p.runner(db, 'check'); p.gate(db, True)

    def test_04_rollback_past_a_breaking_migration_refuses(self):
        db = self.new('breaking'); p.runner(db, 'deploy')
        with tempfile.TemporaryDirectory() as tmp:
            old = release(tmp, drop=[s for s in SELECTED if s[:6] >= '000027'])
            before = history(db)
            refused = p.runner(db, 'deploy', dir=old, ok=False).stderr
            self.assertIn('000027_create_sealed_job_graphs.sql (declared breaking', refused)
            self.assertIn('declared breaking', p.runner(db, 'check', dir=old, ok=False).stderr)
            p.gate(db, False, dir=old)
            self.assertEqual(before, history(db))

    def test_05_unknown_breaking_or_undeclared_refuses(self):
        for compat in ('breaking', None):
            with self.subTest(compat=compat), tempfile.TemporaryDirectory() as tmp:
                db = self.new('unknown_'+(compat or 'undeclared')); p.runner(db, 'deploy')
                newer = release(tmp, add=[('000900_generated_newer.sql', 'CREATE TABLE public.generated_newer(id integer);', compat)])
                p.runner(db, 'deploy', dir=newer)
                before = history(db)
                err = p.runner(db, 'deploy', ok=False).stderr
                self.assertIn('history names migration absent from this release: 000900_generated_newer.sql', err)
                self.assertIn('declared breaking' if compat else 'no forward-compatibility declaration', err)
                p.runner(db, 'check', ok=False)
                gate = subprocess_gate(db)
                self.assertIn('000900_generated_newer.sql', gate)
                self.assertEqual(before, history(db))

    def test_06_unknown_additive_is_tolerated(self):
        db = self.new('newer_additive'); p.runner(db, 'deploy')
        with tempfile.TemporaryDirectory() as tmp:
            newer = release(tmp, add=[('000900_generated_newer.sql', 'CREATE TABLE public.generated_newer(id integer);', 'additive')])
            p.runner(db, 'deploy', dir=newer)
        self.assertIn('tolerating 000900_generated_newer.sql', p.runner(db, 'deploy').stdout)
        p.gate(db, True)

    def test_07_pending_beside_newer_refuses_without_change(self):
        db = self.new('pending'); p.runner(db, 'deploy')
        with tempfile.TemporaryDirectory() as tmp:
            newer = release(tmp, add=[('000900_generated_newer.sql', 'CREATE TABLE public.generated_newer(id integer);', 'additive')])
            p.runner(db, 'deploy', dir=newer)
            p.sql(db, "DELETE FROM migrations WHERE name='000030_create_delphi_writers.sql'")
            before = history(db)
            self.assertIn('no changes made', p.runner(db, 'deploy', ok=False).stderr)
            self.assertEqual(before, history(db))

    def test_08_same_number_other_name_refuses(self):
        db = self.new('renamed'); p.runner(db, 'deploy')
        p.sql(db, "UPDATE migrations SET name='000030_generated_renamed.sql', compat='additive' WHERE name='000030_create_delphi_writers.sql'")
        self.assertIn('numbers 000030 as 000030_create_delphi_writers.sql', p.runner(db, 'check', ok=False).stderr)
        self.assertIn('numbers 000030', subprocess_gate(db))

    def test_09_earlier_runner_table_gains_column_and_backfill(self):
        db = self.new('backfill'); p.runner(db, 'deploy')
        p.sql(db, 'ALTER TABLE migrations DROP COLUMN compat')
        p.runner(db, 'check'); p.gate(db, True)
        with tempfile.TemporaryDirectory() as tmp:
            old = release(tmp, drop=[s for s in SELECTED if s[:6] >= '000028'])
            self.assertIn('no forward-compatibility declaration', p.runner(db, 'check', dir=old, ok=False).stderr)
            out = p.runner(db, 'deploy').stdout
            self.assertIn('added the forward-compatibility declaration column', out)
            self.assertIn('declared 000028_create_delphi_results.sql additive', out)
            p.runner(db, 'check', dir=old); p.gate(db, True, dir=old)

    def test_10_declarations_only_tighten(self):
        db = self.new('tighten'); p.runner(db, 'deploy')
        p.sql(db, "UPDATE migrations SET compat='additive' WHERE name='000027_create_sealed_job_graphs.sql'; UPDATE migrations SET compat='breaking' WHERE name='000028_create_delphi_results.sql'")
        out = p.runner(db, 'deploy').stdout
        self.assertIn('declared 000027_create_sealed_job_graphs.sql breaking', out)
        self.assertIn('declaration kept: 000028_create_delphi_results.sql stays breaking', out)
        self.assertEqual(p.sql(db, "SELECT compat FROM migrations WHERE name='000028_create_delphi_results.sql'"), 'breaking')

    def test_11_ledger_parity_refusals(self):
        db = self.new('ledger'); p.runner(db, 'deploy')
        for case, text in [('stray', '000999_not_here.sql additive\n'), ('bad', '000030_create_delphi_writers.sql Additive\n'),
                           ('duplicate', '000030_create_delphi_writers.sql additive\n'), ('spaces', '000030_create_delphi_writers.sql  additive\n')]:
            with self.subTest(case=case), tempfile.TemporaryDirectory() as tmp:
                d = release(tmp)
                body = (d/'compat.txt').read_text()
                if case != 'duplicate':
                    body = '\n'.join(l for l in body.splitlines() if not l.startswith('000030_'))+'\n'
                (d/'compat.txt').write_text(body+text)
                self.assertIn('compat.txt', p.runner(db, 'check', dir=d, ok=False).stderr)
                p.gate(db, False, dir=d)


def subprocess_gate(db, dir=p.MIG):
    import subprocess
    r = subprocess.run(['node', str(p.ROOT/'server/src/db/migrations.cjs')], env=dict(p.env(db), POLIS_MIGRATIONS_DIR=str(dir)), text=True, capture_output=True, timeout=30)
    assert r.returncode != 0, r.stdout
    return r.stderr


if __name__ == '__main__': unittest.main(verbosity=2)
