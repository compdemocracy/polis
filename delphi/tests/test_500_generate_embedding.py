import os
import sys
from unittest import mock
import pytest
import numpy as np
import importlib

# Add the 'umap_narrative' directory to the Python path to allow the target script to be imported.
umap_narrative_dir = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', 'umap_narrative'))
if umap_narrative_dir not in sys.path:
    sys.path.insert(0, umap_narrative_dir)

@pytest.fixture(autouse=True)
def setup_and_teardown(tmp_path, monkeypatch):
    """Fixture to set up a clean environment for each test."""
    monkeypatch.setenv("ANTHROPIC_API_KEY", "mock_key_for_testing")
    cwd = os.getcwd()
    os.chdir(tmp_path)
    yield
    os.chdir(cwd)

def test_pipeline_flow_with_mocks(tmp_path):
    """
    Tests the main control flow of the script with mocks.
    
    This test verifies that the script calls the main data processing and storage
    functions without executing the actual ML or database operations. It uses
    `importlib` and `mock.patch.object` to handle the script's non-standard filename.
    """
    zid = "98765"
    test_args = [
        "500_generate_embedding_umap_cluster.py",
        "--use-mock-data",
        "--zid", zid,
    ]

    num_comments = 100

    # Define a valid, predictable return value for the ML processing function
    mock_process_comments_return_value = (
        np.random.rand(num_comments, 2),  # document_map
        np.random.rand(num_comments, 32), # document_vectors
        [np.random.randint(0, 5, num_comments) for _ in range(3)], # cluster_layers
        [f"comment text {i}" for i in range(num_comments)], # comment_texts
        [i for i in range(num_comments)] # comment_ids
    )

    # Import the module programmatically because its name starts with a number.
    generate_embedding_module = importlib.import_module("500_generate_embedding_umap_cluster")

    # Patch the objects directly on the imported module object to avoid mock's string parsing issue.
    with mock.patch.object(generate_embedding_module, 'process_comments', return_value=mock_process_comments_return_value) as mock_process_comments, \
         mock.patch.object(generate_embedding_module, 'DynamoDBStorage') as MockDynamoStorage:
        
        # Configure the mock DynamoDB instance that will be created
        mock_dynamo_instance = mock.MagicMock()
        MockDynamoStorage.return_value = mock_dynamo_instance

        # Run the main function from the script
        with mock.patch.object(sys, 'argv', test_args):
            try:
                generate_embedding_module.main()
            except SystemExit as e:
                pytest.fail(f"Script exited unexpectedly: {e}")

    # Assert that the main functions were called, confirming the control flow
    mock_process_comments.assert_called_once()
    
    # Assert that the script attempted to initialize the DynamoDB client
    MockDynamoStorage.assert_called_once()
    
    # Assert that the script called the various methods to store data
    assert mock_dynamo_instance.create_conversation_meta.call_count == 1
    assert mock_dynamo_instance.batch_create_comment_embeddings.call_count == 1
    assert mock_dynamo_instance.batch_create_graph_edges.call_count == 1
    assert mock_dynamo_instance.batch_create_comment_clusters.call_count == 1
    assert mock_dynamo_instance.batch_create_cluster_topics.call_count == 1
    assert mock_dynamo_instance.batch_create_cluster_characteristics.call_count > 0