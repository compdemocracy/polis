"""Public metadata controls for the offline reversal fixture builder."""
import copy
import json
from pathlib import Path
import sys
import unittest
from unittest.mock import Mock, patch

HERE=Path(__file__).resolve().parent
sys.path.insert(0,str(HERE))
sys.path.insert(0,str(HERE.parent/'private_cert/images'))
from roles_rehearsal import test_job
from roles_producer import produce
from roles_verifier import receipt,controls
from roles_census import FAMILIES,normalize
from reversal_fixture import restore,residue


class ReversalControls(unittest.TestCase):
    def setUp(self):
        self.projection=json.loads((HERE/'fixtures/roles_projection.json').read_text())
        self.job=test_job()
        self.receipt=receipt(self.projection,produce(self.projection),self.job,self.projection['source_commit'])
        self.receipt['controls']=controls(self.job)
        self.census=self.receipt['census']
        self.conn=Mock()
        self.conn.get_dsn_parameters.return_value={'host':'127.0.0.1','dbname':'probe_test','port':'55548'}
        self.conn.get_transaction_status.return_value=0

    def test_remote_or_unowned_coordinates_refused_before_sql(self):
        for key,value in [('host','db.example.invalid'),('host','/tmp'),('dbname','other'),('port','5432'),('port','bad')]:
            with self.subTest(key=key,value=value):
                self.conn.get_dsn_parameters.return_value={'host':'127.0.0.1','dbname':'probe_test','port':'55548',key:value}
                with self.assertRaisesRegex(ValueError,'^REVERSAL_ISOLATED_PG17_REQUIRED$'):
                    restore(self.conn,self.receipt,self.job,settings_presence=True)
        self.conn.cursor.assert_not_called()

    def test_receipt_extra_field_refused_before_sql(self):
        self.receipt['extra']=True
        with self.assertRaisesRegex(ValueError,'^CENSUS_SCHEMA$'):
            restore(self.conn,self.receipt,self.job,settings_presence=True)
        self.conn.cursor.assert_not_called()

    def test_wrong_bound_image_refused_before_sql(self):
        self.receipt['bindings']['reader']='f'*64
        with self.assertRaisesRegex(ValueError,'^CENSUS_IMAGE$'):
            restore(self.conn,self.receipt,self.job,settings_presence=True)
        self.conn.cursor.assert_not_called()

    def test_withheld_settings_require_explicit_presence_profile(self):
        with self.assertRaisesRegex(ValueError,'^REVERSAL_SETTINGS_UNMODELED$'):
            restore(self.conn,self.receipt,self.job)
        self.conn.cursor.assert_not_called()

    def test_existing_transaction_refused(self):
        self.conn.get_transaction_status.return_value=2
        with self.assertRaisesRegex(ValueError,'^REVERSAL_IDLE_CONNECTION_REQUIRED$'):
            restore(self.conn,self.receipt,self.job,settings_presence=True)
        self.conn.cursor.assert_not_called()

    def test_shape_mismatch_refused_before_mutation(self):
        baseline=copy.deepcopy(self.census);baseline['relations']=[]
        with patch('reversal_fixture.snapshot',return_value=baseline):
            with self.assertRaisesRegex(ValueError,'^REVERSAL_BASELINE_MISMATCH$'):
                restore(self.conn,self.receipt,self.job,settings_presence=True)
        self.conn.cursor.assert_not_called()

    def test_exact_layout_has_closed_preserved_report(self):
        report=residue(self.census,self.census)
        self.assertEqual(set(report),{'schema','verdict','classification','families','changes'})
        self.assertEqual(report['verdict'],'PRESERVED')
        self.assertEqual(report['classification'],'NONE')
        self.assertEqual(set(report['families']),set(FAMILIES))
        self.assertTrue(all(v=={'added':0,'removed':0} for v in report['families'].values()))

    def test_acl_representation_is_not_hidden(self):
        after=copy.deepcopy(self.census)
        row=next(r for r in after['relations'] if r['acl_state']=='DEFAULT')
        row['acl_state']='EXPLICIT'
        report=residue(self.census,after)
        self.assertEqual(report['verdict'],'RESIDUE')
        self.assertEqual(report['classification'],'ACL_REPRESENTATION_ONLY')
        self.assertEqual(report['changes']['relations'][0]['fields'],['acl_state'])

    def test_grant_loss_is_material_residue(self):
        after=copy.deepcopy(self.census);after['acls'].pop()
        report=residue(self.census,after)
        self.assertEqual(report['classification'],'CATALOG_LAYOUT_CHANGED')
        self.assertEqual(report['families']['acls'],{'added':0,'removed':1})

    def test_extra_role_is_reported_by_typed_identity(self):
        after=copy.deepcopy(self.census);row=copy.deepcopy(after['roles'][0]);row['name']='extra_fixture_role';after['roles'].append(row)
        report=residue(self.census,normalize(after))
        self.assertEqual(report['classification'],'CATALOG_LAYOUT_CHANGED')
        self.assertEqual(report['changes']['roles'],[{'identity':['extra_fixture_role'],'change':'ADDED','fields':[]}])


if __name__=='__main__':unittest.main()
