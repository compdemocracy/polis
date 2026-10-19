"""UMAP and EVōC take one seed, so a cluster run on the same embeddings repeats.

Runs the real UMAP and EVōC (numba JIT on first call), so it is slower than
the adapter boundary checks in test_numerical_stages.py.
"""
import hashlib
import json
import logging
from pathlib import Path
import sys
import unittest
from unittest import mock

import numba
import numpy as np

DELPHI = Path(__file__).resolve().parents[2]
SCRIPTS = DELPHI / 'scripts'
for path in (str(SCRIPTS), str(DELPHI), str(DELPHI / 'umap_narrative')):
    if path not in sys.path:
        sys.path.insert(0, path)
import delphi_graph_stages as stages
from umap_narrative import numerical_stages
from umap_narrative.numerical_stages import project_and_cluster


def fixture_vectors():
    """240 unit vectors in 384 dimensions (the all-MiniLM-L6-v2 width): four
    broad themes of three overlapping sub-themes each, so EVōC finds more
    than one layer and has borderline points to assign."""
    rng = np.random.default_rng(20261019)
    themes = rng.normal(size=(4, 384))
    rows = []
    for theme in themes:
        for sub in rng.normal(size=(3, 384)):
            rows.append(theme + 0.6 * sub + 0.55 * rng.normal(size=(20, 384)))
    vectors = np.vstack(rows).astype(np.float32)
    return vectors / np.linalg.norm(vectors, axis=1, keepdims=True)


class ClusterSeed(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.vectors = fixture_vectors()

    def run_stage(self, seed=None):
        state, threads = np.random.get_state(), numba.get_num_threads()
        with self.assertLogs('umap_narrative.numerical_stages', logging.INFO) as logs:
            if seed is None:
                points, layers = project_and_cluster(self.vectors)
            else:
                points, layers = project_and_cluster(self.vectors, seed=seed)
        # The KMeans fallback would also repeat; the test is about EVōC.
        self.assertFalse(any('Falling back' in line for line in logs.output), logs.output)
        # The seeding is scoped: NumPy's global generator and Numba's thread
        # count are as the caller left them.
        after = np.random.get_state()
        self.assertEqual((state[0], *state[2:]), (after[0], *after[2:]))
        np.testing.assert_array_equal(state[1], after[1])
        self.assertEqual(numba.get_num_threads(), threads)
        return points, [np.asarray(layer).tolist() for layer in layers]

    def test_two_runs_with_the_default_seed_assign_identically(self):
        first_points, first = self.run_stage()
        second_points, second = self.run_stage()
        self.assertEqual(first, second)
        np.testing.assert_array_equal(first_points, second_points)

    def test_two_runs_with_a_named_seed_assign_identically(self):
        _, first = self.run_stage(seed=7)
        _, second = self.run_stage(seed=7)
        self.assertEqual(first, second)

    def test_an_argument_evoc_refuses_raises_instead_of_falling_back(self):
        refused = TypeError("EVoC.__init__() got an unexpected keyword argument 'random_state'")
        with mock.patch('evoc.EVoC', side_effect=refused), self.assertRaises(TypeError):
            project_and_cluster(self.vectors)

    def frame(self, seed):
        ids = list(range(len(self.vectors)))
        rows = [dict(conversation_id='9001', comment_id=i,
                     embedding=dict(vector=v.tolist(), dimensions=384, model=stages.MODELS['graph_embed']))
                for i, v in zip(ids, self.vectors)]
        embeddings = json.dumps(dict(family_files=stages.family_files({'Delphi_CommentEmbeddings': rows})))
        declared = dict(model=stages.MODELS['graph_cluster'], mode='full', seed=seed,
                        snapshot=dict(data=dict(texts=[f'fixture statement {i}' for i in ids])),
                        config=dict(comment_ids=ids, report_id='fixture-report'))
        artifacts = dict(embeddings=dict(payload=embeddings, sha256=hashlib.sha256(embeddings.encode()).hexdigest()))
        return dict(stage='graph_cluster', zid=9001, job_id='00000000-0000-4000-8000-000000009001',
                    input=dict(schema='polis-job-input/1', declared=declared, artifacts=artifacts))

    def test_cluster_stage_uses_and_names_the_declared_seed(self):
        self.assertEqual(stages.MODELS['graph_cluster'], getattr(numerical_stages, 'CLUSTER_MODEL', None))
        first = stages.execute(self.frame(42))
        second = stages.execute(self.frame(42))
        self.assertEqual(first['seed'], 42)
        self.assertEqual(first['layers'], second['layers'])
        self.assertEqual(first['points'], second['points'])
        for family in ('Delphi_CommentHierarchicalClusterAssignments', 'Delphi_UMAPGraph'):
            self.assertEqual(first['family_files'][family], second['family_files'][family], family)
        # The conversation config also carries the wall clock it was written at.
        config = [{k: v for k, v in stages.read_family(run, 'Delphi_UMAPConversationConfig')[0].items()
                   if k != 'processed_date'} for run in (first, second)]
        self.assertEqual(config[0], config[1])
        _, layers = self.run_stage(seed=42)
        self.assertEqual(first['layers'], layers)
        # So the topics stage over each run's clusters writes the same families.
        topics = [stages.execute(self.topics_frame(run)) for run in (first, second)]
        self.assertTrue(topics[0]['topics'])
        self.assertEqual(topics[0]['family_files'], topics[1]['family_files'])

    def topics_frame(self, clusters):
        frame = self.frame(42)
        payload = json.dumps(clusters)
        frame.update(stage='graph_topics')
        frame['input']['declared']['model'] = stages.MODELS['graph_topics']
        frame['input']['artifacts'] = dict(clusters=dict(
            payload=payload, sha256=hashlib.sha256(payload.encode()).hexdigest()))
        return frame

    def test_cluster_stage_refuses_a_seed_numpy_cannot_take(self):
        for seed in (-1, 2**32, 4.5, True, '42'):
            with self.subTest(seed=seed), self.assertRaisesRegex(ValueError, 'declared seed'):
                stages.execute(self.frame(seed))


if __name__ == '__main__':
    unittest.main()
