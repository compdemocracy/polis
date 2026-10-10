#!/usr/bin/env python3
"""Generated databases only. Own Compose project/port required. No vote rows."""
import json, os, pathlib, shutil, subprocess, tempfile, time, unittest
ROOT=pathlib.Path(__file__).resolve().parents[3]
MIG=ROOT/'server/postgres/migrations'
BIN=ROOT/'queue-rs/target/debug/polis-migrate'
COMPOSE=['docker','compose','-f',str(pathlib.Path(__file__).with_name('compose.yml'))]
assert os.environ.get('COMPOSE_PROJECT_NAME','').startswith('polis-migrate-test-')
PORT=os.environ['POLIS_RECOVERY_PG_PORT']
assert os.environ['RECOVERY_PG_PORT']==PORT

def sql(db,query):
    p=subprocess.run(COMPOSE+['exec','-T','postgres','psql','-X','-v','ON_ERROR_STOP=1','-U','postgres','-d',db,'-At'],input=query,text=True,capture_output=True)
    if p.returncode: raise AssertionError(p.stderr)
    return p.stdout.strip()
def env(db): return dict(os.environ,DATABASE_URL=f'postgresql://postgres@127.0.0.1:{PORT}/{db}?sslmode=disable')
def runner(db,*args,dir=MIG,ok=True):
    p=subprocess.run([str(BIN),*args,'--dir',str(dir)],env=env(db),text=True,capture_output=True,timeout=350)
    if (p.returncode==0)!=ok: raise AssertionError(f'{args} exit={p.returncode}\n{p.stdout}\n{p.stderr}')
    return p

def gate(db,ok,dir=MIG):
    # The actual module imported first by server/index.ts; pg uses generated loopback DB.
    p=subprocess.run(['node',str(ROOT/('server/src/db/migrations.cjs' if ok else 'server/dist/index.js'))],env=dict(env(db),POLIS_MIGRATIONS_DIR=str(dir)),text=True,capture_output=True,timeout=30)
    if (p.returncode==0)!=ok: raise AssertionError(f'Node gate {p.returncode}: {p.stdout} {p.stderr}')
    if not ok:
        assert 'Server startup refused:' in p.stderr and 'MODULE_NOT_FOUND' not in p.stderr, p.stderr
    return p

class Proof(unittest.TestCase):
    def new(self,name):
        db='migrate_'+name
        sql('postgres',f'CREATE DATABASE {db}')
        return db
    def legacy(self,name):
        db=self.new(name)
        for p in sorted(MIG.glob('*.sql')):
            if int(p.name[:6])<=18 or p.name.startswith('000022_'): sql(db,p.read_text())
        sql(db,"INSERT INTO users(hname) VALUES('generated migration sentinel');")
        return db
    def test_18_deploy_legacy_and_unchanged_rerun(self):
        db=self.legacy('deploy_legacy')
        first=runner(db,'deploy')
        self.assertIn('adopted 20 migration(s)',first.stdout)
        self.assertEqual([x.split()[1][:6] for x in first.stdout.splitlines() if x.startswith('APPLIED ')],['000019','000023','000024','000027'])
        before=sql(db,'SELECT row_to_json(m) FROM migrations m ORDER BY name')
        self.assertIn('applied 0 migration(s)',runner(db,'deploy').stdout)
        self.assertEqual(before,sql(db,'SELECT row_to_json(m) FROM migrations m ORDER BY name'))

    def test_19_deploy_does_not_adopt_corrupt_modern_history(self):
        db=self.new('deploy_corrupt');runner(db,'deploy')
        sql(db,"UPDATE migrations SET checksum=repeat('0',64) WHERE name LIKE '000023_%'")
        before=sql(db,'SELECT row_to_json(m) FROM migrations m ORDER BY name')
        self.assertIn('checksum mismatch',runner(db,'deploy',ok=False).stderr)
        self.assertEqual(before,sql(db,'SELECT row_to_json(m) FROM migrations m ORDER BY name'))

    def test_20_deploy_concurrent_first_adoption(self):
        db=self.legacy('deploy_concurrent')
        commands=[subprocess.Popen([str(BIN),'deploy','--dir',str(MIG)],env=env(db),stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True) for _ in range(2)]
        outputs=[]
        for p in commands:
            out,err=p.communicate(timeout=350)
            self.assertEqual(p.returncode,0,out+err);outputs.append(out)
        self.assertEqual(sum('adopted 20 migration(s)' in x for x in outputs),1)
        self.assertEqual(sum('applied 4 migration(s)' in x for x in outputs),1)
        runner(db,'check')

    def test_21_deploy_legacy_ledger_preserves_timestamps(self):
        db=self.legacy('deploy_old_ledger')
        sql(db,"CREATE TABLE migrations(name text,completed_at bigint); INSERT INTO migrations VALUES('000000_initial.sql',1000),('000000_initial.sql',2000)")
        runner(db,'deploy')
        self.assertEqual(sql(db,"SELECT legacy_completed_at FROM migrations WHERE name='000000_initial.sql'"),'{1000,2000}')

    def test_22_deploy_rejects_unverified_ledger(self):
        db=self.legacy('deploy_other_ledger')
        sql(db,'CREATE TABLE schema_migrations(name text)')
        self.assertIn('another schema_migrations ledger',runner(db,'deploy',ok=False).stderr)
        self.assertEqual(sql(db,"SELECT to_regclass('migrations') IS NULL"),'t')

    def test_23_modern_v3_upgrades_to_v5_preserving_receipts(self):
        db=self.new('modern_v3')
        with tempfile.TemporaryDirectory() as tmp:
            d=pathlib.Path(tmp)/'m';shutil.copytree(MIG,d)
            f=d/'release.txt';f.write_text('\n'.join(x for x in f.read_text().splitlines() if not x.startswith('000027_'))+'\n')
            next(d.glob('000027_*.sql')).unlink()
            runner(db,'deploy',dir=d)
        before=sql(db,'SELECT row_to_json(m) FROM migrations m ORDER BY name')
        gate(db,False)
        output=runner(db,'deploy').stdout
        self.assertIn('applied 1 migration(s)',output)
        self.assertEqual(before,sql(db,"SELECT row_to_json(m) FROM migrations m WHERE name NOT LIKE '000027_%' ORDER BY name"))
        self.assertEqual(sql(db,'SELECT contract_version FROM polis_queue_install'),'polis-queue/5')
        gate(db,True)

    def test_24_unledgered_graph_is_not_readopted(self):
        db=self.new('unledgered_v5');runner(db,'deploy')
        sql(db,'DROP TABLE migrations')
        self.assertIn('queue /3 catalog postconditions fail',runner(db,'deploy',ok=False).stderr)
        self.assertEqual(sql(db,"SELECT to_regclass('migrations') IS NULL"),'t')

    def test_15_treevite_checks_required_for_adoption(self):
        db=self.legacy('treevite_contract')
        constraints=sql(db,"SELECT conrelid::regclass::text || '|' || conname || '|' || pg_get_constraintdef(oid) FROM pg_constraint WHERE conrelid IN ('treevite_waves'::regclass,'treevite_invites'::regclass) AND contype='c' ORDER BY conname").splitlines()
        self.assertEqual(len(constraints),7)
        for row in constraints:
            table,name,definition=row.split('|',2)
            with self.subTest(constraint=name):
                sql(db,f'ALTER TABLE {table} DROP CONSTRAINT {name}')
                refused=runner(db,'reconcile','--through','000022',ok=False)
                self.assertIn('000013_create_treevite.sql',refused.stderr)
                self.assertEqual(sql(db,"SELECT to_regclass('public.migrations') IS NULL"),'t')
                sql(db,f'ALTER TABLE {table} ADD CONSTRAINT {name} {definition}')
        runner(db,'reconcile','--through','000022')
        self.assertEqual(sql(db,"SELECT status FROM migrations WHERE name='000013_create_treevite.sql'"),'ADOPTED')

    def test_16_json_equivalence_is_only_for_legacy_math(self):
        db=self.legacy('json_contract')
        helpers=(MIG/'adoption/helpers.sql').read_text()
        sql(db,'CREATE TABLE public.unrelated_json(data json)')
        result=sql(db,helpers+"SELECT pg_temp.col('unrelated_json','data','jsonb')")
        self.assertEqual(result.splitlines()[-1],'f')
        for table in ['math_main','math_profile','math_ptptstats','math_cache',
                      'math_bidtopid','math_exportstatus']:
            sql(db,f'ALTER TABLE {table} ALTER COLUMN data TYPE json USING data::json')
        sql(db,'ALTER TABLE math_report_correlationmatrix ALTER COLUMN data TYPE json USING data::json')
        self.assertIn('000000',runner(db,'reconcile','--through','000022',ok=False).stderr)
        self.assertEqual(sql(db,"SELECT to_regclass('public.migrations') IS NULL"),'t')
        sql(db,'ALTER TABLE math_report_correlationmatrix ALTER COLUMN data TYPE jsonb USING data::jsonb')
        runner(db,'reconcile','--through','000022')

    def test_01_fresh(self):
        db=self.new('fresh')
        self.assertIn('applied 21 migration(s)',runner(db,'apply').stdout)
        self.assertEqual(sql(db,"SELECT count(*) FROM migrations WHERE status='APPLIED'"),'21')
        runner(db,'check');gate(db,True)
        self.assertEqual(sql(db,"SELECT to_regclass('public.polis_coordinator_install') IS NULL"),'t')
    def test_02_reconcile_then_pending(self):
        db=self.legacy('legacy')
        runner(db,'apply',ok=False); runner(db,'check',ok=False); gate(db,False)
        p=runner(db,'reconcile','--through','000022')
        self.assertIn('adopted 20 migration(s)',p.stdout)
        self.assertEqual(sql(db,"SELECT count(*) FROM migrations WHERE status='ADOPTED'"),'20')
        gate(db,False)
        p=runner(db,'apply')
        self.assertEqual([s.split()[1][:6] for s in p.stdout.splitlines() if s.startswith('APPLIED ')],['000019','000023','000024','000027'])
        runner(db,'check');gate(db,True)
        self.assertEqual(sql(db,"SELECT hname FROM users"),'generated migration sentinel')
    def test_03_noop(self):
        db=self.new('noop');runner(db,'apply')
        before=sql(db,'SELECT row_to_json(m) FROM migrations m ORDER BY name')
        self.assertIn('applied 0 migration(s)',runner(db,'apply').stdout)
        self.assertEqual(before,sql(db,'SELECT row_to_json(m) FROM migrations m ORDER BY name'))
    def test_04_failure_atomic_and_startup_refusal(self):
        db=self.legacy('failure');runner(db,'reconcile','--through','000022')
        # Force the real 000023 file to fail after 000019 commits, then prove it
        # leaves no half-created foundation or APPLIED row. The preexisting
        # collision is generated; remove it explicitly before the recovery run.
        sql(db,'CREATE TABLE public.delphi_jobs (collision integer)')
        p=runner(db,'apply',ok=False)
        self.assertIn('000023',p.stderr)
        self.assertEqual(sql(db,"SELECT count(*) FROM migrations WHERE name LIKE '000023%'"),'0')
        self.assertEqual(sql(db,"SELECT to_regclass('public.delphi_job_inputs') IS NULL"),'t')
        self.assertEqual(sql(db,"SELECT NOT EXISTS(SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='polis_queue_install' AND column_name='contract_version')"),'t')
        runner(db,'check',ok=False);gate(db,False)
        sql(db,'DROP TABLE public.delphi_jobs')
        runner(db,'apply');gate(db,True)
    def test_05_two_runners(self):
        db=self.new('race')
        # A third, owned session holds the migration lock until both real runners
        # are observed waiting. Release it; one applies, the other observes history.
        holder=subprocess.Popen(COMPOSE+['exec','-T','postgres','psql','-X','-U','postgres','-d',db,'-At'],stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True)
        holder.stdin.write('SELECT pg_advisory_lock(5795970445610936679);\n');holder.stdin.flush()
        holder.stdout.readline()
        args=[str(BIN),'apply','--dir',str(MIG)]
        a=subprocess.Popen(args,env=env(db),stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True)
        b=subprocess.Popen(args,env=env(db),stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True)
        deadline=time.monotonic()+20
        try:
            while time.monotonic()<deadline:
                waiting=sql(db,"SELECT count(*) FROM pg_stat_activity WHERE application_name='polis-migrate' AND query LIKE 'SELECT pg_try_advisory_lock%'")
                if waiting=='2': break
                time.sleep(.05)
            self.assertEqual(waiting,'2')
            self.assertEqual(sql(db,"SELECT to_regclass('public.migrations') IS NULL"),'t')
        finally:
            holder.stdin.write('SELECT pg_advisory_unlock_all();\n\\q\n');holder.stdin.flush();holder.communicate(timeout=10)
        outputs=[]
        for p in [a,b]:
            out,err=p.communicate(timeout=350);self.assertEqual(p.returncode,0,err); outputs.append(out)
        self.assertEqual(sorted('applied 21 migration(s)' in o for o in outputs),[False,True])
        self.assertEqual(sorted('applied 0 migration(s)' in o for o in outputs),[False,True])
        self.assertEqual(sql(db,'SELECT count(*) FROM migrations'),'24')
    def test_06_bad_catalog_adopts_nothing(self):
        db=self.legacy('badcatalog')
        sql(db,'ALTER TABLE conversations DROP COLUMN topics_enabled')
        p=runner(db,'reconcile','--through','000022',ok=False)
        self.assertIn('000018',p.stderr)
        self.assertEqual(sql(db,"SELECT to_regclass('public.migrations') IS NULL"),'t')
    def test_07_legacy_table_and_duplicates(self):
        db=self.legacy('oldledger')
        sql(db,"CREATE TABLE migrations(name varchar(999) NOT NULL,completed_at bigint NOT NULL); INSERT INTO migrations VALUES('000000_initial.sql',100),('000000_initial.sql',101),('000001_update_pwreset_table.sql',102)")
        runner(db,'apply',ok=False)
        runner(db,'reconcile','--through','000022')
        self.assertEqual(sql(db,"SELECT legacy_completed_at FROM migrations WHERE name='000000_initial.sql'"),'{100,101}')
        runner(db,'apply');gate(db,True)
    def test_08_changed_source_refused(self):
        db=self.new('checksum');runner(db,'apply')
        with tempfile.TemporaryDirectory() as tmp:
            d=pathlib.Path(tmp)/'migrations';shutil.copytree(MIG,d)
            with (d/'000001_update_pwreset_table.sql').open('a') as f:f.write('\n-- edited historical source\n')
            self.assertIn('checksum mismatch',runner(db,'check',dir=d,ok=False).stderr)
            self.assertIn('checksum mismatch',runner(db,'apply',dir=d,ok=False).stderr)
    def test_09_readonly_role(self):
        db=self.new('readonly');runner(db,'apply')
        sql(db,'CREATE ROLE migrate_reader LOGIN; ALTER DATABASE migrate_readonly SET default_transaction_read_only=on')
        args=[str(BIN),'check','--dir',str(MIG)]
        e=env(db);e['DATABASE_URL']=e['DATABASE_URL'].replace('postgres@','migrate_reader@')
        p=subprocess.run(args,env=e,text=True,capture_output=True);self.assertEqual(p.returncode,0,p.stderr)
        p=subprocess.run(['node',str(ROOT/'server/src/db/migrations.cjs')],env=dict(e,POLIS_MIGRATIONS_DIR=str(MIG)),text=True,capture_output=True);self.assertEqual(p.returncode,0,p.stderr)
    def test_10_ddl_rollback_after_error(self):
        db=self.new('rollback');runner(db,'apply')
        with tempfile.TemporaryDirectory() as tmp:
            d=pathlib.Path(tmp)/'migrations';shutil.copytree(MIG,d)
            f=d/'000999_generated_failure.sql'
            with (d/'release.txt').open('a') as manifest: manifest.write(f.name+'\n')
            f.write_text('BEGIN; CREATE TABLE public.must_rollback (id integer); SELECT 1/0; COMMIT;')
            p=runner(db,'apply',dir=d,ok=False)
            self.assertIn('000999',p.stderr)
            self.assertEqual(sql(db,"SELECT to_regclass('public.must_rollback') IS NULL"),'t')
            self.assertEqual(sql(db,"SELECT count(*) FROM migrations WHERE name LIKE '000999%'"),'0')
            gate(db,False,dir=d)
            f.write_text('CREATE TABLE public.must_rollback (id integer);')
            runner(db,'apply',dir=d);runner(db,'check',dir=d)
    def test_11_nested_commit_rejected(self):
        db=self.new('escape')
        with tempfile.TemporaryDirectory() as tmp:
            d=pathlib.Path(tmp)/'migrations';shutil.copytree(MIG,d)
            with (d/'release.txt').open('a') as manifest: manifest.write('000999_escape.sql\n')
            (d/'000999_escape.sql').write_text('BEGIN; CREATE TABLE leaked(id integer); COMMIT; SELECT 1/0;')
            self.assertIn('BEGIN without final COMMIT',runner(db,'apply',dir=d,ok=False).stderr)
            self.assertEqual(sql(db,"SELECT to_regclass('public.migrations') IS NULL AND to_regclass('public.leaked') IS NULL"),'t')
    def test_12_catalog_index_definition(self):
        db=self.legacy('badindex')
        sql(db,'DROP INDEX votes_created_idx; CREATE INDEX votes_created_idx ON votes(zid)')
        self.assertIn('000022',runner(db,'reconcile','--through','000022',ok=False).stderr)
        self.assertEqual(sql(db,"SELECT to_regclass('public.migrations') IS NULL"),'t')

    def test_13_existing_queue_adoption(self):
        for number in [19,23,24]:
            db=self.legacy('queue'+str(number))
            for p in sorted(MIG.glob('*.sql')):
                if int(p.name[:6]) in [19,23,24] and int(p.name[:6])<=number: sql(db,p.read_text())
            # No old generic ledger; current queue catalogs must be checked.
            bound=max(number,22)
            runner(db,'reconcile','--through',f'{bound:06d}')
            expected=20+[19,23,24].index(number)+1
            self.assertEqual(sql(db,"SELECT count(*) FROM migrations WHERE status='ADOPTED'"),str(expected))
            runner(db,'apply');runner(db,'check');gate(db,True)
    def test_14_queue_catalog_drift(self):
        db=self.new('queuedrift');runner(db,'apply')
        sql(db,'DROP TABLE migrations; ALTER TABLE polis_queue_jobs ADD COLUMN unexpected integer')
        self.assertIn('queue /3 catalog postconditions fail',runner(db,'reconcile','--through','000024',ok=False).stderr)
        self.assertEqual(sql(db,"SELECT to_regclass('public.migrations') IS NULL"),'t')

    def test_17_retained_old_xid_unique_preserved(self):
        for ordinal,definition in enumerate([
            'ALTER TABLE xids ADD CONSTRAINT generated_old_unique UNIQUE(owner,uid)',
            'CREATE UNIQUE INDEX generated_old_unique ON xids(uid,owner)',
        ]):
            db=self.legacy('xid_extra_unique_'+str(ordinal))
            sql(db,definition)
            before=sql(db,"SELECT oid,pg_get_indexdef(oid) FROM pg_class WHERE oid='generated_old_unique'::regclass")
            runner(db,'reconcile','--through','000022')
            self.assertEqual(before,sql(db,"SELECT oid,pg_get_indexdef(oid) FROM pg_class WHERE oid='generated_old_unique'::regclass"))
            self.assertEqual(sql(db,"SELECT status FROM migrations WHERE name='000002_add_xid_constraint.sql'"),'ADOPTED')
        db=self.legacy('xid_bad_unique')
        for definition in [
            'CREATE UNIQUE INDEX generated_old_unique ON xids(owner,uid) WHERE uid IS NOT NULL',
            'ALTER TABLE xids ADD CONSTRAINT generated_old_unique UNIQUE(owner,uid) DEFERRABLE INITIALLY DEFERRED',
        ]:
            sql(db,definition)
            before=sql(db,"SELECT oid,pg_get_indexdef(oid) FROM pg_class WHERE oid='generated_old_unique'::regclass")
            p=runner(db,'reconcile','--through','000022',ok=False)
            self.assertIn('000002',p.stderr)
            self.assertEqual(sql(db,"SELECT to_regclass('public.migrations') IS NULL"),'t')
            self.assertEqual(before,sql(db,"SELECT oid,pg_get_indexdef(oid) FROM pg_class WHERE oid='generated_old_unique'::regclass"))
            if definition.startswith('ALTER'):
                sql(db,'ALTER TABLE xids DROP CONSTRAINT generated_old_unique')
            else:
                sql(db,'DROP INDEX generated_old_unique')
        sql(db,'CREATE INDEX generated_owner_uid_lookup ON xids(owner,uid)')
        runner(db,'reconcile','--through','000022')

if __name__=='__main__': unittest.main(verbosity=2)
