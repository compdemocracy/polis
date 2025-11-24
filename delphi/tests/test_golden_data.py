
import pytest
import json
import os
import sys

# Add the parent directory to the path to import the module
sys.path.append(os.path.abspath(os.path.dirname(__file__)))

from polismath.conversation.conversation import Conversation
from common_utils import create_test_conversation
from tests.dataset_config import get_dataset_files
from conftest import make_dataset_params

@pytest.mark.xfail(reason="Discrepancies between Python and Clojure implementations")
@pytest.mark.parametrize("dataset_name", make_dataset_params(["biodiversity", "vw"]))
def test_compare_to_golden_data(dataset_name):
    """
    Runs the full pipeline and compares the output to the 'golden' Clojure data.
    """
    # 1. Run the Python pipeline
    conv = create_test_conversation(dataset_name)
    conv = conv.recompute()

    # 2. Load the Clojure math_blob.json
    dataset_files = get_dataset_files(dataset_name)
    with open(dataset_files['math_blob']) as f:
        clojure_data = json.load(f)

    # 3. Perform comparisons
    # Example comparison: Check if the PCA dimensions match
    py_pca_comps = conv.pca['comps']
    clj_pca_comps = clojure_data['pca']['comps']

    assert py_pca_comps.shape == (len(clj_pca_comps), len(clj_pca_comps[0])), "PCA component dimensions do not match"

    # Compare group clusters
    py_clusters = conv.group_clusters
    clj_clusters = clojure_data['group-clusters']

    assert len(py_clusters) == len(clj_clusters), "Number of clusters does not match"

    py_cluster_members = sorted([len(c['members']) for c in py_clusters])
    clj_cluster_members = sorted([len(c['members']) for c in clj_clusters])

    assert py_cluster_members == clj_cluster_members, "Cluster sizes do not match"

    # TODO: Add more comparisons, for example for repness
