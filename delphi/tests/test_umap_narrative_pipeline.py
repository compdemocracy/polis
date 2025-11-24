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

def test_run_pipeline_with_mock_data(tmp_path):
    """
    Tests that the run_pipeline.py script's file generation logic works.
    This test mocks the entire `process_comments` function to bypass all
    unstable ML steps (embedding, UMAP, clustering) and provides a valid,
    pre-canned data structure directly to the visualization functions.
    """
    zid = "12345"
    test_args = [
        "run_pipeline.py",
        "--use-mock-data",
        "--zid", zid,
        "--no-dynamo",
    ]

    num_comments = 100
    mock_called = False

    # This side-effect function will be called instead of the real process_comments.
    # It confirms the mock is working and returns a valid data structure.
    def process_comments_side_effect(*args, **kwargs):
        nonlocal mock_called
        mock_called = True
        return (
            np.random.rand(num_comments, 2),  # document_map
            np.random.rand(num_comments, 32), # document_vectors
            [np.random.randint(0, 5, num_comments) for _ in range(3)], # cluster_layers
            [f"comment text {i}" for i in range(num_comments)], # comment_texts
            [i for i in range(num_comments)] # comment_ids
        )

    # We patch `run_pipeline.process_comments` which is where the function is looked up
    # when `run_pipeline_main` is executed.
    with mock.patch('run_pipeline.process_comments', side_effect=process_comments_side_effect):
        with mock.patch.object(sys, 'argv', test_args):
            try:
                run_pipeline_main()
            except SystemExit as e:
                pytest.fail(f"run_pipeline.py exited unexpectedly: {e}")

    # This assertion is crucial: it fails if the mock was not called.
    assert mock_called, "The mock for run_pipeline.process_comments was not called. Check the patch target."

    # Verify that the output directory and files were created in the temp path.
    expected_output_dir = tmp_path / "polis_data" / zid / "python_output" / "comments_enhanced_multilayer"
    assert expected_output_dir.is_dir(), f"Output directory was not created at {expected_output_dir}"

    # Check for the main index file.
    expected_index_file = expected_output_dir / f"{zid}_comment_enhanced_index.html"
    assert expected_index_file.is_file(), f"Main index HTML file was not created: {expected_index_file}"

    # Check for the layer 0 visualization file.
    expected_layer_file = expected_output_dir / f"{zid}_comment_layer_0_named.html"
    assert expected_layer_file.is_file(), "Layer 0 visualization file was not created"