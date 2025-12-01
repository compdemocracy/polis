import sys
import os
from unittest import mock
import pytest

# Add the 'umap_narrative' directory to the Python path to allow the script to be imported
umap_narrative_dir = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', 'umap_narrative'))
if umap_narrative_dir not in sys.path:
    sys.path.insert(0, umap_narrative_dir)

# Now we can import the main function from the script to be tested
from reset_conversation import main as reset_conversation_main

@pytest.fixture
def mock_boto3_resources():
    """Mocks the get_boto_resource function to return mock objects for S3 and DynamoDB."""
    
    # --- Create Mock for S3 ---
    mock_s3_resource = mock.MagicMock()
    mock_bucket = mock.MagicMock()
    mock_s3_object = mock.MagicMock()
    mock_s3_object.key = 'visualizations/test-rid/some_file.html'
    # Configure the mock bucket's objects.filter to return a list containing our mock object
    mock_bucket.objects.filter.return_value = [mock_s3_object]
    # The Bucket() method of the S3 resource will return our mock bucket
    mock_s3_resource.Bucket.return_value = mock_bucket
    
    # --- Create Mock for DynamoDB ---
    mock_dynamodb_resource = mock.MagicMock()
    mock_table = mock.MagicMock()
    # Configure the query/scan methods to return one fake item to trigger the deletion logic
    mock_table.query.return_value = {'Items': [{'pk': 'some_key', 'sk': 'some_sort_key'}]}
    mock_table.scan.return_value = {'Items': [{'pk': 'some_key', 'sk': 'some_sort_key'}]}
    # The Table() method of the DynamoDB resource will return our mock table
    mock_dynamodb_resource.Table.return_value = mock_table
    
    # --- Create the main mock that replaces get_boto_resource ---
    with mock.patch('reset_conversation.get_boto_resource') as mock_get_resource:
        # Define a side effect to return the correct mock based on service name
        def get_resource_side_effect(service_name):
            if service_name == 'dynamodb':
                return mock_dynamodb_resource
            if service_name == 's3':
                return mock_s3_resource
            return mock.MagicMock()

        mock_get_resource.side_effect = get_resource_side_effect
        
        # Yield the mocks to the test function
        yield {
            "get_resource": mock_get_resource,
            "dynamodb": mock_dynamodb_resource,
            "s3": mock_s3_resource,
            "table": mock_table,
            "bucket": mock_bucket
        }

def test_reset_conversation_calls_all_services(mock_boto3_resources):
    """
    Tests that the main reset script calls both DynamoDB and S3 deletion logic.
    """
    test_zid = "12345"
    test_rid = "r_test_12345"
    
    # Run the main function with test arguments
    reset_conversation_main(zid=test_zid, rid=test_rid)

    # 1. Assert that our main mock was called for both services
    mock_boto3_resources["get_resource"].assert_any_call("dynamodb")
    mock_boto3_resources["get_resource"].assert_any_call("s3")

    # 2. Assert that the script tried to get a DynamoDB table
    # It will be called many times, so just check it was called at all
    mock_boto3_resources["dynamodb"].Table.assert_called()
    
    # 3. Assert that a deletion was attempted on a table
    # This confirms that the query/scan + delete loop was entered
    mock_table = mock_boto3_resources["table"]
    # Check that batch_writer (for query results) or delete_item (for single items) was called
    assert mock_table.batch_writer.called or mock_table.delete_item.called

    # 4. Assert that the script tried to access the S3 bucket
    mock_boto3_resources["s3"].Bucket.assert_called_with(mock.ANY) # bucket name is from env
    
    # 5. Assert that the script attempted to delete S3 objects
    mock_bucket = mock_boto3_resources["bucket"]
    mock_bucket.delete_objects.assert_called_once()

def test_reset_conversation_skips_s3_if_no_rid(mock_boto3_resources):
    """
    Tests that S3 deletion is skipped if no report_id (rid) is provided.
    """
    test_zid = "54321"
    
    # Run the main function without the 'rid' argument
    reset_conversation_main(zid=test_zid, rid=None)
    
    # Assert that the DynamoDB deletion logic was still called
    mock_boto3_resources["get_resource"].assert_any_call("dynamodb")
    mock_boto3_resources["dynamodb"].Table.assert_called()

    # Assert that the S3 logic was SKIPPED
    mock_bucket = mock_boto3_resources["bucket"]
    mock_bucket.delete_objects.assert_not_called()

