#!/usr/bin/env python3
"""Persistent adoption-contract regression tests; generated DBs and no vote rows.

Run after starting tests/compose.yml with unique COMPOSE_PROJECT_NAME and ports.
Uses the built polis-migrate in this checkout; no packet or original source needed.
"""
import json, pathlib, unittest
from prove import MIG, runner, sql

class Adoption(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.db='adoption_contract_template'
        sql('postgres',f'CREATE DATABASE {cls.db}')
        for path in sorted(MIG.glob('*.sql')):
            if int(path.name[:6]) <= 18 or path.name.startswith('000022_'):
                sql(cls.db,path.read_text())
        sql(cls.db,"INSERT INTO users(hname) VALUES('constructed adoption sentinel')")

    def test_01_catalog_controls(self):
        cases=json.loads(pathlib.Path(__file__).with_name('adoption-cases.json').read_text())
        helpers=(MIG/'adoption/helpers.sql').read_text()
        for case in cases:
            with self.subTest(case=case['name']):
                predicate=next((MIG/'adoption').glob(f"{case['migration']:06d}_*.sql")).read_text()
                out=sql(self.db,'BEGIN;\n'+case['mutation']+'\n'+helpers+'\n'+predicate+'\nROLLBACK;')
                # psql also prints transaction/function command tags.
                values=[line for line in out.splitlines() if line in ('t','f')]
                self.assertEqual(values,[case['expected']])

    def test_02_conflicts_leave_no_history(self):
        cases=[(3,"ALTER TABLE participants_extended ALTER COLUMN origin SET DEFAULT 'constructed';"),
               (13,'ALTER TABLE treevite_invites DISABLE TRIGGER ALL;'),
               (17,'ALTER TABLE byod_import_jobs ALTER COLUMN id DROP DEFAULT;')]
        for n,mutation in cases:
            with self.subTest(migration=n):
                db=f'adoption_contract_conflict_{n}'
                sql('postgres',f'CREATE DATABASE {db} TEMPLATE {self.db}')
                sql(db,mutation)
                p=runner(db,'reconcile','--through','000022',ok=False)
                self.assertIn(f'{n:06d}_',p.stderr)
                self.assertEqual(sql(db,"SELECT to_regclass('public.migrations') IS NULL"),'t')

    def test_03_canonical_adoption(self):
        db='adoption_contract_success'
        sql('postgres',f'CREATE DATABASE {db} TEMPLATE {self.db}')
        runner(db,'reconcile','--through','000022')
        self.assertEqual(sql(db,"SELECT count(*) FROM migrations WHERE status='ADOPTED'"),'20')
        self.assertEqual(sql(db,'SELECT hname FROM users'),'constructed adoption sentinel')

if __name__=='__main__': unittest.main(verbosity=2)
