#!/usr/bin/env python3
"""Release selection and retirement: generated databases, no application rows."""
import pathlib, shutil, tempfile, unittest
import prove as p

class SelectionProof(unittest.TestCase):
    def new(self, suffix):
        db='selection_'+suffix
        p.sql('postgres',f'CREATE DATABASE {db}')
        return db

    def test_01_manifest_parity_and_fail_closed(self):
        db=self.new('manifest')
        for case in ['missing','duplicate','unknown','overlap','bad','absent','held_duplicate','whitespace']:
            with self.subTest(case=case), tempfile.TemporaryDirectory() as tmp:
                d=pathlib.Path(tmp)/'m';shutil.copytree(p.MIG,d)
                f=d/'release.txt'
                if case=='missing': f.unlink()
                elif case=='duplicate': f.write_text(f.read_text()+'000000_initial.sql\n')
                elif case=='unknown': (d/'000025_not_released.sql').write_text('SELECT 1;')
                elif case=='overlap': f.write_text(f.read_text()+'000021_create_polis_coordinator.sql\n')
                elif case=='bad': f.write_text(f.read_text()+'../bad.sql\n')
                elif case=='absent': f.write_text(f.read_text()+'000999_missing.sql\n')
                elif case=='held_duplicate': (d/'held.txt').write_text('000021_create_polis_coordinator.sql\n'*2)
                else: f.write_text(f.read_text()+'000025_bad.sql\r')
                p.runner(db,'apply',dir=d,ok=False)
                p.gate(db,False,dir=d)
                self.assertEqual(p.sql(db,"SELECT to_regclass('public.migrations') IS NULL"),'t')

    def test_02_retired_sql_never_runs(self):
        db=self.new('retired')
        with tempfile.TemporaryDirectory() as tmp:
            d=pathlib.Path(tmp)/'m';shutil.copytree(p.MIG,d)
            for n in ['000004','000005','000007']:
                next(d.glob(n+'*.sql')).write_text('SELECT 1/0;')
            output=p.runner(db,'apply',dir=d).stdout
            self.assertIn(f'applied {len(p.APPLIED)} migration(s)',output)
            self.assertEqual(p.sql(db,"SELECT count(*) FROM migrations WHERE status='ADOPTED'"),'3')
            p.runner(db,'check',dir=d);p.gate(db,True,dir=d)

    def test_03_retained_objects_refuse_before_any_change(self):
        db=self.new('retained');p.runner(db,'apply')
        tables={4:['waitinglist'],5:['slack_oauth_access_tokens','slack_users','slack_user_invites','slack_bot_events','stripe_accounts','stripe_subscriptions','coupons_for_free_upgrades','lti_users','lti_context_memberships','canvas_assignment_callback_info','canvas_assignment_conversation_info','lti_oauthv1_credentials'],7:['geolocation_cache']}
        columns={5:[('conversations','is_slack'),('conversations','lti_users_only'),('users','plan')],7:[('participants_extended',c) for c in ['country_code_iso','encrypted_maxmind_response_city','ip_address','latitude','location','longitude','x_forwarded_for']]}
        controls=[]
        for number,names in tables.items():
            controls.extend((number,f'CREATE TABLE public.{t}(sentinel integer)',f'DROP TABLE public.{t}') for t in names)
        for number,pairs in columns.items():
            controls.extend((number,f'ALTER TABLE public.{t} ADD COLUMN {c} integer',f'ALTER TABLE public.{t} DROP COLUMN {c}') for t,c in pairs)
        for number,create,remove in controls:
            with self.subTest(object=create):
                p.sql(db,f"DELETE FROM migrations WHERE name LIKE '{number:06d}_%';"+create)
                before=p.sql(db,'SELECT row_to_json(m) FROM migrations m ORDER BY name')
                refusal=p.runner(db,'apply',ok=False)
                self.assertIn('no changes made',refusal.stderr)
                self.assertEqual(before,p.sql(db,'SELECT row_to_json(m) FROM migrations m ORDER BY name'))
                p.sql(db,remove);p.runner(db,'apply')
                self.assertEqual(p.sql(db,f"SELECT status FROM migrations WHERE name LIKE '{number:06d}_%'"),'ADOPTED')

    def test_04_existing_applied_receipts_preserved(self):
        db=self.new('applied');p.runner(db,'apply')
        p.sql(db,"UPDATE migrations SET status='APPLIED' WHERE status='ADOPTED'")
        before=p.sql(db,'SELECT row_to_json(m) FROM migrations m ORDER BY name')
        self.assertIn('applied 0 migration(s)',p.runner(db,'apply').stdout)
        self.assertEqual(before,p.sql(db,'SELECT row_to_json(m) FROM migrations m ORDER BY name'))
        p.runner(db,'check');p.gate(db,True)

    def test_05_no_history_retirement_refusal_is_atomic(self):
        db=self.new('no_history');p.sql(db,'CREATE TABLE waitinglist(sentinel integer);INSERT INTO waitinglist VALUES(42)')
        self.assertIn('retired migration',p.runner(db,'apply',ok=False).stderr)
        self.assertEqual(p.sql(db,"SELECT to_regclass('public.migrations') IS NULL"),'t')
        self.assertEqual(p.sql(db,'SELECT sentinel FROM waitinglist'),'42')

if __name__=='__main__': unittest.main(verbosity=2)
