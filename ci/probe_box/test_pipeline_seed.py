"""Public seed controls: raw signs, local identity and role metrics."""
import csv
import json
from pathlib import Path
import sys
import unittest

ROOT=Path(__file__).resolve().parents[2]
sys.path.insert(0,str(ROOT/'ci/probe_box/local'))
sys.path.insert(0,str(ROOT/'delphi'))
from pipeline_seed import exported,measured,BASE_MS


class PipelineSeedTests(unittest.TestCase):
    def test_public_export_sign_and_order(self):
        (votes,_,_),_=exported('vw')
        path=next(next((ROOT/'delphi/real_data').glob('*-vw')).glob('*votes.csv'))
        with path.open(newline='') as stream:source=list(csv.DictReader(stream))
        self.assertEqual([v['vote'] for v in votes],[-int(r['vote']) for r in source])
        self.assertEqual([v['created'] for v in votes],list(range(BASE_MS+1000,BASE_MS+1000+len(votes))))

    def test_public_id_rebase_is_contiguous_and_unique(self):
        (votes,comments,participants),source=exported('biodiversity')
        self.assertEqual({v['pid'] for v in votes},set(range(len(participants))))
        self.assertEqual({v['tid'] for v in votes},set(range(len(comments))))
        path=next(next((ROOT/'delphi/real_data').glob('*-biodiversity')).glob('*votes.csv'))
        with path.open(newline='') as stream:original=list(csv.DictReader(stream))
        self.assertEqual(len({(v['pid'],v['tid']) for v in votes}),len({(r['voter-id'],r['comment-id']) for r in original}))
        self.assertGreater(len(votes),len({(v['pid'],v['tid']) for v in votes}))
        self.assertEqual(source['votes'],len(votes))
        self.assertEqual(len(source['sha256']),64)

    def test_missing_required_role_is_not_silently_replaced(self):
        from polismath.replay.fixture_survey import resolve_roles,RoleUnsatisfied
        config=json.loads((ROOT/'delphi/scripts/certify_datasets.probe.json').read_text())
        with self.assertRaises(RoleUnsatisfied) as caught:
            resolve_roles(config,[],accept_public_fixture=config['accepted_public_fixture_replacements'])
        self.assertEqual(caught.exception.slug,'pc-v1-revote')

    def test_zero_votes_preserve_null_ratio_metrics(self):
        m=measured(([],[{'tid':0,'mod':0,'is_meta':False}],[{'pid':0,'mod':0}]),1)
        self.assertEqual(m['V'],0);self.assertIsNone(m['revote_share']);self.assertIsNone(m['density'])
        self.assertEqual(m['all_comments'],1);self.assertEqual(m['registered_participants'],1)

    def test_revotes_count_events_without_inventing_cells(self):
        data=([{'pid':0,'tid':0},{'pid':0,'tid':0}], [{'tid':0,'mod':0,'is_meta':False}], [{'pid':0,'mod':0}])
        m=measured(data,1)
        self.assertEqual((m['V'],m['U'],m['revote_share']),(2,1,.5))

    def test_moderation_meta_and_bans_have_distinct_denominators(self):
        data=([{'pid':0,'tid':0},{'pid':1,'tid':1}],
              [{'tid':0,'mod':-1,'is_meta':False},{'tid':1,'mod':0,'is_meta':True}],
              [{'pid':0,'mod':-1},{'pid':1,'mod':0}])
        m=measured(data,1)
        self.assertEqual((m['mod_out_share'],m['meta_share'],m['banned_voters']),(.5,.5,1))
        self.assertEqual(m['eligible_participants'],0)
        self.assertEqual(m['mod_out_or_meta_comments'],2)


if __name__=='__main__':unittest.main()
