import unittest,unicodedata
from pseudonymize import scrub,skeleton,text_shape
class ScrubTests(unittest.TestCase):
 def setUp(self):
  self.rows={'users':[{'email':'generated@example.invalid','name':'Álpha ЖΩ文','cap':'2generated','vote':-1,'tick':1700000000123,'lang':'en'}]}
  self.catalog=[{'table':'users','column':c} for c in self.rows['users'][0]]
  self.policy={'users':{c:{'action':a,'reviewed':True,'reason':'generated policy test','namespace':c} for c,a in [('email','email'),('name','text'),('cap','capability'),('vote','preserve'),('tick','preserve'),('lang','preserve')]}}
 def test_deterministic_and_destroy_key(self):
  k=bytearray(b'x'*32);a=scrub(self.catalog,self.rows,self.policy,k);b=scrub(self.catalog,self.rows,self.policy,bytearray(b'x'*32))
  self.assertEqual(a,b);self.assertEqual(k,bytearray(32));self.assertNotIn('generated@example.invalid',str(a))
 def test_rotate_corpus(self):self.assertNotEqual(scrub(self.catalog,self.rows,self.policy,bytearray(b'x'*32)),scrub(self.catalog,self.rows,self.policy,bytearray(b'y'*32)))
 def test_semantics_preserved(self):
  r=scrub(self.catalog,self.rows,self.policy,bytearray(b'x'*32))['data']['users'][0]
  self.assertEqual((r['vote'],r['tick'],r['lang']),(-1,1700000000123,'en'));self.assertNotEqual(r['cap'],'2generated')
 def test_unknown_column_empty_table(self):
  with self.assertRaises(ValueError):scrub(self.catalog+[{'table':'empty','column':'pii'}],self.rows,self.policy,bytearray(b'x'*32))
 def test_failure_destroys_key(self):
  key=bytearray(b'x'*32)
  with self.assertRaises(ValueError):scrub(self.catalog+[{'table':'users','column':'new'}],self.rows,self.policy,key)
  self.assertEqual(key,bytearray(32))
 def test_unknown_row_column(self):
  self.rows['users'][0]['secret']='generated'
  with self.assertRaises(ValueError):scrub(self.catalog,self.rows,self.policy,bytearray(b'x'*32))
 def test_unreviewed_skeleton_blocks(self):
  with self.assertRaises(ValueError):scrub(self.catalog,self.rows,skeleton(self.catalog),bytearray(b'x'*32))
 def test_shape(self):
  s='Álpha ЖΩ文 123.';v=text_shape(s);self.assertEqual(len(s),len(v));self.assertEqual(list(map(unicodedata.category,s)),list(map(unicodedata.category,v)))
 def test_unsupported_unicode_blocks(self):
  with self.assertRaises(ValueError):text_shape('😀')
 def test_namespace_links(self):
  self.rows={'users':[{'email':'generated@example.invalid','other':'generated@example.invalid'}]};self.catalog=[{'table':'users','column':c} for c in self.rows['users'][0]]
  self.policy={'users':{c:{'action':'email','namespace':'email','reviewed':True,'reason':'FK-equivalent alias'} for c in ['email','other']}}
  r=scrub(self.catalog,self.rows,self.policy,bytearray(b'x'*32))['data']['users'][0];self.assertEqual(r['email'],r['other'])
if __name__=='__main__':unittest.main()
