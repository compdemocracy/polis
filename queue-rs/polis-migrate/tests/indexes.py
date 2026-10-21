"""Real generated Postgres runner controls. No vote rows are inserted."""
import importlib.util,json,os,pathlib,shutil,subprocess,tempfile,time,unittest
ROOT=pathlib.Path(__file__).resolve().parents[3]
spec=importlib.util.spec_from_file_location('proof',ROOT/'queue-rs/polis-migrate/tests/prove.py');p=importlib.util.module_from_spec(spec);spec.loader.exec_module(p)
ORIGINAL=os.environ.get('ORIGINAL_RUNNER')
class IndexProof(unittest.TestCase):
 def setUp(self):
  self.tmp=tempfile.TemporaryDirectory();self.addCleanup(self.tmp.cleanup);self.d=pathlib.Path(self.tmp.name)
  (self.d/'held.txt').write_text('')
  self.m=p.MIG/'000022_add_poll_timestamp_indexes.sql';shutil.copy(self.m,self.d/self.m.name)
 def db(self,name,extra=''):
  db='idx_'+name;p.sql('postgres',f'CREATE DATABASE {db}')
  (self.d/'000000_initial.sql').write_text('CREATE TABLE public.votes(created bigint); CREATE TABLE public.comments(modified bigint, other integer);'+extra)
  return db
 def runnew(self,db,*args,**kw):
  (self.d/'release.txt').write_text(''.join(f.name+'\n' for f in sorted(self.d.glob('*.sql'))))
  return p.runner(db,*args,dir=self.d,**kw)
 def test_01_original_refuses_large_candidate_passes(self):
  db=self.db('large','INSERT INTO public.comments SELECT x,0 FROM generate_series(1,100001) x;')
  if ORIGINAL:
   before=subprocess.run([ORIGINAL,'apply','--dir',str(self.d)],env=p.env(db),text=True,capture_output=True,timeout=60)
   self.assertNotEqual(before.returncode,0);self.assertIn('000022',before.stderr)
   self.assertEqual(p.sql(db,"SELECT count(*) FROM migrations WHERE name LIKE '000022%'"),'0')
  self.assertIn('BUILDING CONCURRENTLY',self.runnew(db,'apply').stdout)
  self.runnew(db,'check');self.assertEqual(p.sql(db,'SELECT count(*) FROM comments'),'100001')
  self.assertEqual(p.sql(db,'SELECT count(*) FROM votes'),'0')
 def test_02_partial_success_resumes_without_rebuild(self):
  db=self.db('partial','CREATE INDEX votes_created_idx ON public.votes(created);')
  # Bootstrap only first to observe its OID before the pending index runs.
  m=self.d/self.m.name;m.rename(self.d/'index.pending')
  self.runnew(db,'apply');oid=p.sql(db,"SELECT 'public.votes_created_idx'::regclass::oid")
  (self.d/'index.pending').rename(m)
  self.runnew(db,'apply');self.assertEqual(oid,p.sql(db,"SELECT 'public.votes_created_idx'::regclass::oid"))
  self.assertIn('applied 0 migration(s)',self.runnew(db,'apply').stdout)
 def test_03_collision_preflight_preserves_objects(self):
  db=self.db('collision','CREATE INDEX comments_modified_idx ON public.comments(other);')
  r=self.runnew(db,'apply',ok=False);self.assertIn('conflicting object',r.stderr)
  self.assertEqual(p.sql(db,"SELECT to_regclass('public.votes_created_idx') IS NULL"),'t')
  self.assertEqual(p.sql(db,"SELECT count(*) FROM migrations WHERE name LIKE '000022%'"),'0')
 def test_04_history_failure_resumes_committed_indexes(self):
  db=self.db('history',"CREATE FUNCTION public.refuse_index_record() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.name LIKE '000022%' THEN RAISE EXCEPTION 'generated history fault'; END IF; RETURN NEW; END $$; CREATE TRIGGER refuse_index_record BEFORE INSERT ON migrations FOR EACH ROW EXECUTE FUNCTION public.refuse_index_record();")
  self.runnew(db,'apply',ok=False)
  before=p.sql(db,"SELECT indexrelid FROM pg_index WHERE indrelid IN ('votes'::regclass,'comments'::regclass) ORDER BY indexrelid")
  self.assertEqual(len(before.splitlines()),2)
  self.assertEqual(p.sql(db,"SELECT count(*) FROM migrations WHERE name LIKE '000022%'"),'0')
  p.sql(db,'DROP TRIGGER refuse_index_record ON migrations');self.runnew(db,'apply')
  self.assertEqual(before,p.sql(db,"SELECT indexrelid FROM pg_index WHERE indrelid IN ('votes'::regclass,'comments'::regclass) ORDER BY indexrelid"))
 def holder(self,db):
  q=subprocess.Popen(p.COMPOSE+['exec','-T','postgres','psql','-X','-U','postgres','-d',db,'-Atq'],stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True)
  q.stdin.write("BEGIN; INSERT INTO comments VALUES(1,1); SELECT 'held';\n");q.stdin.flush();self.assertEqual(q.stdout.readline().strip(),'held');return q
 def release(self,q):
  q.stdin.write('COMMIT;\n\\q\n');q.stdin.flush();q.communicate(timeout=15)
 def wait_index(self,db):
  deadline=time.monotonic()+15
  while time.monotonic()<deadline:
   if p.sql(db,"SELECT EXISTS(SELECT 1 FROM pg_index WHERE indexrelid=to_regclass('comments_modified_idx') AND NOT indisvalid)")=='t':return
   time.sleep(.05)
  self.fail('concurrent build never reached invalid/in-progress state')
 def bootstrap(self,name):
  db=self.db(name,'CREATE INDEX votes_created_idx ON public.votes(created);')
  m=self.d/self.m.name;m.rename(self.d/'index.pending');self.runnew(db,'apply');(self.d/'index.pending').rename(m)
  (self.d/'release.txt').write_text(''.join(f.name+'\n' for f in sorted(self.d.glob('*.sql'))))
  return db
 def test_05_writer_continues_during_concurrent_build(self):
  db=self.bootstrap('writer');holder=self.holder(db)
  r=subprocess.Popen([str(p.BIN),'apply','--dir',str(self.d)],env=p.env(db),stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True)
  try:
   self.wait_index(db)
   p.sql(db,"SET lock_timeout='1s'; INSERT INTO comments VALUES(2,2)")
  finally:self.release(holder)
  out,err=r.communicate(timeout=60);self.assertEqual(r.returncode,0,err);self.runnew(db,'check')
 def test_06_invalid_build_refusal_explicit_recovery(self):
  db=self.bootstrap('invalid');holder=self.holder(db)
  r=subprocess.Popen([str(p.BIN),'apply','--dir',str(self.d)],env=p.env(db),stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True)
  try:
   self.wait_index(db)
   self.assertIn('t',p.sql(db,"SELECT pg_cancel_backend(pid) FROM pg_stat_activity WHERE datname=current_database() AND application_name='polis-migrate' AND query LIKE 'CREATE INDEX CONCURRENTLY%';"))
   out,err=r.communicate(timeout=30);self.assertNotEqual(r.returncode,0)
  finally:self.release(holder)
  rr=self.runnew(db,'apply',ok=False);self.assertIn('invalid/not ready',rr.stderr)
  self.assertEqual(p.sql(db,"SELECT count(*) FROM migrations WHERE name LIKE '000022%'"),'0')
  p.sql(db,'DROP INDEX CONCURRENTLY public.comments_modified_idx')
  self.runnew(db,'apply');self.runnew(db,'check')

class ActivityIndexProof(unittest.TestCase):
 def setUp(self):
  self.tmp=tempfile.TemporaryDirectory();self.addCleanup(self.tmp.cleanup);self.d=pathlib.Path(self.tmp.name)
  self.name='000043_add_conversation_activity_indexes.sql'
  (self.d/'held.txt').write_text('')
  (self.d/'000000_initial.sql').write_text('CREATE TABLE votes(zid integer, created bigint); CREATE TABLE comments(zid integer, created bigint, modified bigint);')
  self.db='activity_'+self._testMethodName
  p.sql('postgres',f'CREATE DATABASE {self.db}')
  self.runnew('apply')
  shutil.copy(pathlib.Path(__file__).with_name('fixtures')/'concurrent-indexes.sql',self.d/self.name)
 def runnew(self,*args,**kw):
  (self.d/'release.txt').write_text(''.join(f.name+'\n' for f in sorted(self.d.glob('*.sql'))))
  return p.runner(self.db,*args,dir=self.d,**kw)
 def valid(self):
  return p.sql(self.db,"SELECT count(*) FROM pg_index WHERE indisvalid AND indisready AND indislive AND indexrelid IN (to_regclass('votes_zid_created_idx'),to_regclass('comments_zid_created_idx'),to_regclass('comments_zid_modified_idx'))")
 def test_fresh_and_repeat(self):
  self.runnew('apply');self.runnew('check');self.assertEqual(self.valid(),'3')
  self.assertIn('applied 0 migration(s)',self.runnew('apply').stdout)
 def test_prepare_indexes_without_history(self):
  p.sql(self.db,'DROP TABLE migrations')
  result=self.runnew('prepare-indexes','--file',str(self.d/self.name))
  self.assertIn('BUILDING CONCURRENTLY',result.stdout);self.assertEqual(self.valid(),'3')
  before=p.sql(self.db,"SELECT indexrelid FROM pg_index ORDER BY indexrelid")
  self.runnew('prepare-indexes','--file',str(self.d/self.name))
  self.assertEqual(before,p.sql(self.db,"SELECT indexrelid FROM pg_index ORDER BY indexrelid"))
  self.assertEqual(p.sql(self.db,"SELECT to_regclass('migrations') IS NULL"),'t')
 def test_prepare_indexes_refuses_conflict(self):
  p.sql(self.db,'CREATE INDEX comments_zid_modified_idx ON comments(created)')
  result=self.runnew('prepare-indexes','--file',str(self.d/self.name),ok=False)
  self.assertIn('conflicting object',result.stderr)
  self.assertEqual(p.sql(self.db,"SELECT to_regclass('votes_zid_created_idx') IS NULL"),'t')
 def test_prepare_indexes_requires_header(self):
  (self.d/self.name).write_text('CREATE TABLE forbidden(id int);')
  result=self.runnew('prepare-indexes','--file',str(self.d/self.name),ok=False)
  self.assertIn('requires the concurrent-indexes header',result.stderr)
  self.assertEqual(p.sql(self.db,"SELECT to_regclass('forbidden') IS NULL"),'t')
 def test_session_budgets_restored(self):
  (self.d/'000001_session_settings.sql').write_text("SET statement_timeout='1s'; SET lock_timeout='1ms'; SET transaction_timeout='2min';")
  p.sql(self.db,"CREATE FUNCTION check_build_budget() RETURNS event_trigger LANGUAGE plpgsql AS $$ BEGIN IF current_setting('statement_timeout') <> '5min' OR current_setting('lock_timeout') <> '5s' OR current_setting('transaction_timeout') <> '5min' THEN RAISE EXCEPTION 'concurrent build budgets were not restored'; END IF; END $$; CREATE EVENT TRIGGER check_build_budget ON ddl_command_start WHEN TAG IN ('CREATE INDEX') EXECUTE FUNCTION check_build_budget();")
  self.runnew('apply');self.assertEqual(self.valid(),'3')
 def test_all_identities_preflight(self):
  p.sql(self.db,'CREATE INDEX comments_zid_modified_idx ON comments(created)')
  self.assertIn('conflicting object',self.runnew('apply',ok=False).stderr)
  self.assertEqual(p.sql(self.db,"SELECT to_regclass('votes_zid_created_idx') IS NULL"),'t')
 def test_history_failure_keeps_valid_builds(self):
  p.sql(self.db,"CREATE FUNCTION refuse_record() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'generated history fault'; END $$; CREATE TRIGGER refuse_record BEFORE INSERT ON migrations FOR EACH ROW EXECUTE FUNCTION refuse_record();")
  self.runnew('apply',ok=False);self.assertEqual(self.valid(),'3')
  before=p.sql(self.db,"SELECT indexrelid FROM pg_index WHERE indrelid IN ('votes'::regclass,'comments'::regclass) ORDER BY indexrelid")
  p.sql(self.db,'DROP TRIGGER refuse_record ON migrations');self.runnew('apply')
  self.assertEqual(before,p.sql(self.db,"SELECT indexrelid FROM pg_index WHERE indrelid IN ('votes'::regclass,'comments'::regclass) ORDER BY indexrelid"))
 def test_cancel_refuse_recover_with_writer(self):
  # Plain generated rows have no vote value or semantic interpretation.
  holder=subprocess.Popen(p.COMPOSE+['exec','-T','postgres','psql','-X','-U','postgres','-d',self.db,'-Atq'],stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True)
  holder.stdin.write("BEGIN; INSERT INTO votes VALUES(1,1); SELECT 'held';\n");holder.stdin.flush()
  self.assertEqual(holder.stdout.readline().strip(),'held')
  (self.d/'release.txt').write_text('000000_initial.sql\n'+self.name+'\n')
  runner=subprocess.Popen([str(p.BIN),'apply','--dir',str(self.d)],env=p.env(self.db),stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True)
  try:
   deadline=time.monotonic()+15
   while p.sql(self.db,"SELECT EXISTS(SELECT 1 FROM pg_index WHERE indexrelid=to_regclass('votes_zid_created_idx') AND NOT indisvalid)")!='t':
    self.assertLess(time.monotonic(),deadline);time.sleep(.05)
   p.sql(self.db,"SET lock_timeout='1s'; INSERT INTO votes VALUES(2,2)")
   self.assertIn('t',p.sql(self.db,"SELECT pg_cancel_backend(pid) FROM pg_stat_activity WHERE datname=current_database() AND application_name='polis-migrate' AND query LIKE 'CREATE INDEX CONCURRENTLY%';"))
   runner.communicate(timeout=30);self.assertNotEqual(runner.returncode,0)
  finally:
   holder.stdin.write('COMMIT;\n\\q\n');holder.stdin.flush();holder.communicate(timeout=15)
   if runner.poll() is None:runner.terminate();runner.communicate(timeout=15)
  self.assertIn('invalid/not ready',self.runnew('apply',ok=False).stderr)
  self.assertEqual(p.sql(self.db,"SELECT count(*) FROM migrations WHERE name LIKE '000043%'"),'0')
  self.assertEqual(p.sql(self.db,"SELECT to_regclass('comments_zid_created_idx') IS NULL"),'t')
  p.sql(self.db,'DROP INDEX CONCURRENTLY public.votes_zid_created_idx')
  self.runnew('apply');self.runnew('check');self.assertEqual(self.valid(),'3')

class HeaderRefusalProof(unittest.TestCase):
 def assert_refused_without_execution(self,statement,wrapped=False):
  db='header_'+self._testMethodName
  p.sql('postgres',f'CREATE DATABASE {db}')
  p.sql(db,'CREATE TABLE example(zid integer, created bigint); CREATE SEQUENCE execution_probe;')
  with tempfile.TemporaryDirectory() as tmp:
   directory=pathlib.Path(tmp)
   (directory/'held.txt').write_text('')
   # Sequence advances survive rollback, so an unchanged probe proves the
   # earlier selected migration never executed, even if a transaction failed.
   (directory/'000000_initial.sql').write_text("SELECT nextval('execution_probe');")
   valid='CREATE INDEX CONCURRENTLY IF NOT EXISTS earlier_idx ON example (created);\n'
   source=statement if wrapped else valid+statement
   (directory/'000001_indexes.sql').write_text('-- polis-migrate: concurrent-indexes\n'+source)
   (directory/'release.txt').write_text('000000_initial.sql\n000001_indexes.sql\n')
   result=p.runner(db,'apply',dir=directory,ok=False)
  self.assertRegex(result.stderr,'concurrent-indexes|transaction control')
  self.assertNotIn('BUILDING CONCURRENTLY',result.stdout)
  self.assertNotIn('APPLIED ',result.stdout)
  self.assertEqual(p.sql(db,'SELECT is_called FROM execution_probe'),'f')
  self.assertEqual(p.sql(db,"SELECT to_regclass('public.migrations') IS NULL"),'t')
  self.assertEqual(p.sql(db,"SELECT count(*) FROM pg_index WHERE indrelid='public.example'::regclass"),'0')

 def test_predicate(self):
  self.assert_refused_without_execution('CREATE INDEX CONCURRENTLY IF NOT EXISTS example_idx ON example (zid) WHERE zid IS NOT NULL;')
 def test_storage_options(self):
  self.assert_refused_without_execution('CREATE INDEX CONCURRENTLY IF NOT EXISTS example_idx ON example (zid) WITH (fillfactor = 70);')
 def test_include(self):
  self.assert_refused_without_execution('CREATE INDEX CONCURRENTLY IF NOT EXISTS example_idx ON example (zid) INCLUDE (created);')
 def test_tablespace(self):
  self.assert_refused_without_execution('CREATE INDEX CONCURRENTLY IF NOT EXISTS example_idx ON example (zid) TABLESPACE pg_default;')
 def test_explicit_access_method(self):
  self.assert_refused_without_execution('CREATE INDEX CONCURRENTLY IF NOT EXISTS example_idx ON example USING btree (zid);')
 def test_standalone_commit(self):
  self.assert_refused_without_execution('COMMIT;')
 def test_outer_transaction_wrapper(self):
  self.assert_refused_without_execution('BEGIN; CREATE INDEX CONCURRENTLY IF NOT EXISTS example_idx ON example (zid); COMMIT;',wrapped=True)
 def test_missing_concurrently(self):
  self.assert_refused_without_execution('CREATE INDEX IF NOT EXISTS example_idx ON example (zid);')
 def test_missing_if_not_exists(self):
  self.assert_refused_without_execution('CREATE INDEX CONCURRENTLY example_idx ON example (zid);')
 def test_uppercase_identifier(self):
  self.assert_refused_without_execution('CREATE INDEX CONCURRENTLY IF NOT EXISTS Example_idx ON example (zid);')
 def test_quoted_identifier(self):
  self.assert_refused_without_execution('CREATE INDEX CONCURRENTLY IF NOT EXISTS "example_idx" ON example (zid);')

if __name__=='__main__':unittest.main(verbosity=2)
