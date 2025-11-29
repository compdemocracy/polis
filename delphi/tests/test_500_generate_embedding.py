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
    Tests the control flow of the script's mock data path.
    
    This test verifies that when using `--use-mock-data`, the script calls the
    correct subset of data processing and storage functions.
    """
    zid = "98765"
    test_args = [
        "500_generate_embedding_umap_cluster.py",
        "--use-mock-data",
        "--zid", zid,
    ]

    num_comments = 100
    num_layers = 3

    # Define a valid, predictable return value for the ML processing step.
    mock_process_comments_return_value = (
        np.random.rand(num_comments, 2),  # document_map
        np.random.rand(num_comments, 32), # document_vectors
        [np.random.randint(0, 5, num_comments) for _ in range(num_layers)], # cluster_layers
        [f"comment text {i}" for i in range(num_comments)], # comment_texts
        [str(i) for i in range(num_comments)] # comment_ids
    )

    # Import the module to be tested programmatically.
    generate_embedding_module = importlib.import_module("500_generate_embedding_umap_cluster")

    # Patch the external dependencies.
    with mock.patch.object(generate_embedding_module, 'process_comments', return_value=mock_process_comments_return_value) as mock_process_comments, \
         mock.patch.object(generate_embedding_module, 'DataConverter') as MockDataConverter, \
         mock.patch.object(generate_embedding_module, 'DynamoDBStorage') as MockDynamoStorage:
        
        # Configure mocks to return simple, non-empty data.
        MockDataConverter.create_conversation_meta.return_value = "mock_meta_model"
        MockDataConverter.batch_convert_cluster_characteristics.return_value = ["mock_char_model"]
        
        mock_dynamo_instance = mock.MagicMock()
        MockDynamoStorage.return_value = mock_dynamo_instance

        # Run the main function from the script.
        with mock.patch.object(sys, 'argv', test_args):
            try:
                generate_embedding_module.main()
            except SystemExit as e:
                pytest.fail(f"Script exited unexpectedly: {e}")

    # Assert that the mocked functions were called as expected for the mock data path.
    mock_process_comments.assert_called_once()
    MockDynamoStorage.assert_called_once()
    
    # Assert that the DataConverter was used for the methods called in the mock path.
    MockDataConverter.create_conversation_meta.assert_called_once()
    assert MockDataConverter.batch_convert_cluster_characteristics.call_count == num_layers

    # Assert that the correct subset of DynamoDB methods were called.
    mock_dynamo_instance.create_conversation_meta.assert_called_with("mock_meta_model")
    assert mock_dynamo_instance.batch_create_cluster_characteristics.call_count == num_layers
    mock_dynamo_instance.batch_create_cluster_characteristics.assert_called_with(["mock_char_model"])

    # Assert that methods NOT in the mock data path were NOT called.
    mock_dynamo_instance.batch_create_comment_embeddings.assert_not_called()
    mock_dynamo_instance.batch_create_graph_edges.assert_not_called()
    mock_dynamo_instance.batch_create_comment_clusters.assert_not_called()
    mock_dynamo_instance.batch_create_topics.assert_not_called()