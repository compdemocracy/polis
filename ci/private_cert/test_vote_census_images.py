import copy
from pathlib import Path
import sys
import unittest
ROOT=Path(__file__).resolve().parents[2]
sys.path.insert(0,str(ROOT/'ci/private_cert'));sys.path.insert(0,str(ROOT/'ci/private_cert/images'));sys.path.insert(0,str(ROOT/'ci/probe_box'))
from image_admission import validate_recipe,file_digest,launcher_source
from vote_census import KIND,POLICY_SHA,SQL_SHA256
from vote_census_recipe import source_files
from vote_census_registry import admit

class Images(unittest.TestCase):
 def recipe(self,role):
  files=source_files(role)
  return dict(schema='polis-private-image-recipe/2',kind=KIND,role=role,sourceCommit='1'*40,candidateSha='1'*40,
  oracleSha='1'*40,policySha256=POLICY_SHA,runtimeImage='localhost/runtime@sha256:'+'5'*64,
  files={p:file_digest(ROOT/p) for p in files},entrypoint=files[-1],gates=[KIND])
 def test_three_recipes_and_separate_launcher(self):
  for r in ('reader','producer','verifier'):
   recipe=self.recipe(r);self.assertEqual(validate_recipe(recipe),recipe)
   self.assertEqual(launcher_source(recipe).name,'launcher_vote_census.py')
 def test_reader_only_sql(self):
  for role in ('reader','producer','verifier'):
   files=self.recipe(role)['files'];self.assertEqual({k:v for k,v in files.items() if k.endswith('.sql')},
    {'ci/probe_box/vote_census.sql':SQL_SHA256} if role=='reader' else {})
 def test_extra_or_missing_closure_member_refused(self):
  for role in ('reader','producer','verifier'):
   for extra in (True,False):
    r=self.recipe(role)
    if extra:r['files']['delphi/private.py']='a'*64
    else:r['files'].pop('ci/probe_box/contracts.py')
    with self.assertRaises(ValueError):validate_recipe(r)
 def test_wrong_sql_refused(self):
  r=self.recipe('reader');r['files']['ci/probe_box/vote_census.sql']='a'*64
  with self.assertRaises(ValueError):validate_recipe(r)
 def test_wrong_policy_refused(self):
  r=self.recipe('producer');r['policySha256']='a'*64
  with self.assertRaises(ValueError):validate_recipe(r)
 def test_wrong_entrypoint_refused(self):
  r=self.recipe('verifier');r['entrypoint']='ci/probe_box/contracts.py'
  with self.assertRaises(ValueError):validate_recipe(r)
 def test_image_review_required(self):
  with self.assertRaises(ValueError):admit({}, {}, {})
 def test_registry_review_must_bind_each_recipe(self):
  recipes={r:self.recipe(r) for r in ('reader','producer','verifier')}
  with self.assertRaises(ValueError):admit({},recipes,{'schema':'polis-vote-census-image-review/1',
  'recipeSha256':dict.fromkeys(recipes,'a'*64),'reviewSha256':'b'*64})

if __name__=='__main__':unittest.main()
