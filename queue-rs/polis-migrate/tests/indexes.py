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
if __name__=='__main__':unittest.main(verbosity=2)
