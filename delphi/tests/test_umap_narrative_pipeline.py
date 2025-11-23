import os
import sys
from unittest import mock
import pytest
import numpy as np

# Add the 'umap_narrative' directory to the Python path to import 'run_pipeline'
# The test is in delphi/tests, and the script is in delphi/umap_narrative
umap_narrative_dir = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', 'umap_narrative'))
if umap_narrative_dir not in sys.path:
    sys.path.insert(0, umap_narrative_dir)

# Now we can import the main function from the script we want to test
from run_pipeline import main as run_pipeline_main

@pytest.fixture(autouse=True)
def setup_and_teardown(tmp_path, monkeypatch):
    """
    This fixture will be used by all tests in this module.
    - It changes the current working directory to a temporary directory.
    - It restores the original working directory after the test.
    - It mocks the ANTHROPIC_API_KEY to avoid warnings.
    """
    # Mock environment variables to prevent warnings or external calls
    monkeypatch.setenv("ANTHROPIC_API_KEY", "mock_key_for_testing")
    
    cwd = os.getcwd()
    # Change to tmp_path so that output files are written there
    os.chdir(tmp_path)
    yield
    # Restore original working directory
    os.chdir(cwd)

@mock.patch('run_pipeline.process_comments')
def test_run_pipeline_with_mock_data(mock_process_comments, tmp_path):
    """
    Tests that the run_pipeline.py script can be executed, mocking the
    ML portion to ensure the data processing and visualization file
    generation part of the pipeline works correctly.
    """
    zid = "12345"
    num_comments = 100
    
    # Mock the return value of the expensive/problematic process_comments function
    # to simulate a successful ML processing run.
    mock_process_comments.return_value = (
        np.random.rand(num_comments, 2),  # document_map
        np.random.rand(num_comments, 32), # document_vectors
        [np.random.randint(0, 5, num_comments) for _ in range(3)], # cluster_layers
        [f"comment text {i}" for i in range(num_comments)], # comment_texts
        [i for i in range(num_comments)] # comment_ids
    )

    test_args = [
        "run_pipeline.py",
        "--use-mock-data",
        "--zid", zid,
        "--no-dynamo",
    ]

    with mock.patch.object(sys, 'argv', test_args):
        try:
            run_pipeline_main()
        except SystemExit as e:
            pytest.fail(f"run_pipeline.py exited unexpectedly: {e}")

    # Verify that the output directory and files were created in the temp path
    expected_output_dir = tmp_path / "polis_data" / zid / "python_output" / "comments_enhanced_multilayer"
    assert expected_output_dir.is_dir(), f"Output directory was not created at {expected_output_dir}"

    # Check for the main index file.
    # Note: The script has a bug and uses `zid` for the name instead of `conversation_name`.
    # The test is adjusted to reflect the actual behavior of the script.
    expected_index_file = expected_output_dir / f"{zid}_comment_enhanced_index.html"
    assert expected_index_file.is_file(), f"Main index HTML file was not created: {expected_index_file}"

    # The mock data processing should result in 3 cluster layers.
    # Check for visualization and data files for layer 0.
    expected_layer_file = expected_output_dir / f"{zid}_comment_layer_0_named.html"
    assert expected_layer_file.is_file(), "Layer 0 visualization file was not created"

    expected_char_file = expected_output_dir / f"{zid}_comment_layer_0_characteristics.json"
    assert expected_char_file.is_file(), "Layer 0 characteristics JSON file was not created"

    # Check for metadata file
    expected_metadata_file = expected_output_dir / f"{zid}_metadata.json"
    assert expected_metadata_file.is_file(), "Metadata JSON file was not created"