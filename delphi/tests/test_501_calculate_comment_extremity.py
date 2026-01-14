import sys
import os
from unittest import mock
import pytest
import importlib

# Add the 'umap_narrative' directory to the Python path to allow the script to be imported.
umap_narrative_dir = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', 'umap_narrative'))
if umap_narrative_dir not in sys.path:
    sys.path.insert(0, umap_narrative_dir)

# Import the module and function to be tested using importlib
extremity_module = importlib.import_module("501_calculate_comment_extremity")
calculate_and_store_extremity = extremity_module.calculate_and_store_extremity

def test_calculate_and_store_extremity_with_mocks():
    """
    Tests the main logic of calculate_and_store_extremity by mocking its dependencies.
    - Mocks GroupDataProcessor to avoid database calls.
    - Mocks check_existing_extremity_values to force recalculation.
    - Verifies that the function correctly processes the mock output.
    """
    conversation_id = 12345

    # 1. Define a mock return value for the GroupDataProcessor
    mock_export_data = {
        'comments': [
            {'comment_id': 101, 'comment_extremity': 0.85},
            {'comment_id': 102, 'comment_extremity': 0.25},
            {'comment_id': 103, 'comment_extremity': 0.50},
            # A comment that might be missing the extremity value
            {'comment_id': 104}, 
        ]
    }

    # 2. Patch the dependencies within the script's namespace
    with mock.patch.object(extremity_module, 'GroupDataProcessor') as MockGroupDataProcessor, \
         mock.patch.object(extremity_module, 'check_existing_extremity_values', return_value={}) as mock_check_existing:

        # Configure the mock instance of GroupDataProcessor
        mock_processor_instance = mock.MagicMock()
        mock_processor_instance.get_export_data.return_value = mock_export_data
        MockGroupDataProcessor.return_value = mock_processor_instance

        # 3. Call the actual function to be tested
        result = calculate_and_store_extremity(conversation_id, force_recalculation=True)

    # 4. Assert the results
    # Assert that the function correctly extracted the extremity values from the mock data
    expected_result = {
        101: 0.85,
        102: 0.25,
        103: 0.50,
        104: 0, # Should default to 0 if key is missing
    }
    assert result == expected_result, "The returned extremity values do not match the expected output."

    # Assert that the dependencies were called as expected
    mock_check_existing.assert_not_called() # Should not be called when force_recalculation is True
    MockGroupDataProcessor.assert_called_once()
    mock_processor_instance.get_export_data.assert_called_once_with(conversation_id, False)

def test_check_for_existing_values(monkeypatch):
    """
    Tests that the main function returns existing values and skips recalculation
    if they are found and `force` is False.
    """
    conversation_id = 54321
    existing_values = {201: 0.9, 202: 0.1}

    # Patch the check function and the GroupDataProcessor class
    with mock.patch.object(extremity_module, 'check_existing_extremity_values', return_value=existing_values) as mock_check_existing, \
         mock.patch.object(extremity_module, 'GroupDataProcessor') as MockGroupDataProcessor:
        
        # Configure the mock instance that the class will produce upon instantiation
        mock_processor_instance = mock.MagicMock()
        MockGroupDataProcessor.return_value = mock_processor_instance
        
        # Call the function with force_recalculation=False
        result = calculate_and_store_extremity(conversation_id, force_recalculation=False)

    # Assert that the function correctly returned the pre-existing values
    assert result == existing_values

    # Assert that the check for existing values was performed
    mock_check_existing.assert_called_once_with(conversation_id)
    
    # Assert that GroupDataProcessor was instantiated (due to the script's structure)
    MockGroupDataProcessor.assert_called_once()
    
    # Crucially, assert that the expensive calculation method was NOT called on the instance
    mock_processor_instance.get_export_data.assert_not_called()


class TestExcludeCommentSelections:
    """Tests for the exclude_comment_selections flag."""

    def test_exclude_comment_selections_filters_excluded_tids(self):
        """
        Tests that comments with selection=-1 in report_comment_selections are excluded
        when exclude_comment_selections=True.
        """
        conversation_id = 12345

        # Mock export data with several comments
        mock_export_data = {
            'comments': [
                {'comment_id': 101, 'comment_extremity': 0.85},
                {'comment_id': 102, 'comment_extremity': 0.25},  # Will be excluded
                {'comment_id': 103, 'comment_extremity': 0.50},
                {'comment_id': 104, 'comment_extremity': 0.75},  # Will be excluded
            ]
        }

        # Mock report_comment_selections data - tids 102 and 104 have selection=-1
        mock_selections = [
            {'tid': 102, 'selection': -1, 'rid': 1, 'zid': conversation_id},
            {'tid': 104, 'selection': -1, 'rid': 1, 'zid': conversation_id},
            {'tid': 101, 'selection': 1, 'rid': 1, 'zid': conversation_id},  # Included (selection=1)
        ]

        with mock.patch.object(extremity_module, 'PostgresClient') as MockPostgresClient, \
             mock.patch.object(extremity_module, 'GroupDataProcessor') as MockGroupDataProcessor, \
             mock.patch.object(extremity_module, 'check_existing_extremity_values', return_value={}):

            # Configure PostgresClient mock
            mock_postgres_instance = mock.MagicMock()
            mock_postgres_instance.get_report_comment_selections.return_value = mock_selections
            MockPostgresClient.return_value = mock_postgres_instance

            # Configure GroupDataProcessor mock
            mock_processor_instance = mock.MagicMock()
            mock_processor_instance.get_export_data.return_value = mock_export_data
            MockGroupDataProcessor.return_value = mock_processor_instance

            # Call with exclude_comment_selections=True (default)
            result = calculate_and_store_extremity(
                conversation_id, 
                force_recalculation=True,
                exclude_comment_selections=True
            )

        # Assert that excluded comments (102, 104) are NOT in the result
        assert 102 not in result, "Comment 102 should be excluded (selection=-1)"
        assert 104 not in result, "Comment 104 should be excluded (selection=-1)"
        
        # Assert that non-excluded comments ARE in the result
        assert result.get(101) == 0.85, "Comment 101 should be included"
        assert result.get(103) == 0.50, "Comment 103 should be included"
        
        # Verify the postgres client method was called
        mock_postgres_instance.get_report_comment_selections.assert_called_once_with(conversation_id)

    def test_exclude_comment_selections_disabled_includes_all(self):
        """
        Tests that all comments are included when exclude_comment_selections=False.
        """
        conversation_id = 12345

        mock_export_data = {
            'comments': [
                {'comment_id': 101, 'comment_extremity': 0.85},
                {'comment_id': 102, 'comment_extremity': 0.25},
                {'comment_id': 103, 'comment_extremity': 0.50},
            ]
        }

        with mock.patch.object(extremity_module, 'PostgresClient') as MockPostgresClient, \
             mock.patch.object(extremity_module, 'GroupDataProcessor') as MockGroupDataProcessor, \
             mock.patch.object(extremity_module, 'check_existing_extremity_values', return_value={}):

            mock_postgres_instance = mock.MagicMock()
            MockPostgresClient.return_value = mock_postgres_instance

            mock_processor_instance = mock.MagicMock()
            mock_processor_instance.get_export_data.return_value = mock_export_data
            MockGroupDataProcessor.return_value = mock_processor_instance

            # Call with exclude_comment_selections=False
            result = calculate_and_store_extremity(
                conversation_id,
                force_recalculation=True,
                exclude_comment_selections=False
            )

        # Assert all comments are included
        assert result == {101: 0.85, 102: 0.25, 103: 0.50}
        
        # Verify get_report_comment_selections was NOT called
        mock_postgres_instance.get_report_comment_selections.assert_not_called()

    def test_exclude_comment_selections_handles_empty_selections(self):
        """
        Tests that when no comment selections exist, all comments are included.
        """
        conversation_id = 12345

        mock_export_data = {
            'comments': [
                {'comment_id': 101, 'comment_extremity': 0.85},
                {'comment_id': 102, 'comment_extremity': 0.25},
            ]
        }

        # Empty selections list
        mock_selections = []

        with mock.patch.object(extremity_module, 'PostgresClient') as MockPostgresClient, \
             mock.patch.object(extremity_module, 'GroupDataProcessor') as MockGroupDataProcessor, \
             mock.patch.object(extremity_module, 'check_existing_extremity_values', return_value={}):

            mock_postgres_instance = mock.MagicMock()
            mock_postgres_instance.get_report_comment_selections.return_value = mock_selections
            MockPostgresClient.return_value = mock_postgres_instance

            mock_processor_instance = mock.MagicMock()
            mock_processor_instance.get_export_data.return_value = mock_export_data
            MockGroupDataProcessor.return_value = mock_processor_instance

            result = calculate_and_store_extremity(
                conversation_id,
                force_recalculation=True,
                exclude_comment_selections=True
            )

        # All comments should be included since there are no exclusions
        assert result == {101: 0.85, 102: 0.25}

    def test_exclude_comment_selections_handles_database_error(self):
        """
        Tests that when get_report_comment_selections fails, processing continues
        without filtering (graceful degradation).
        """
        conversation_id = 12345

        mock_export_data = {
            'comments': [
                {'comment_id': 101, 'comment_extremity': 0.85},
                {'comment_id': 102, 'comment_extremity': 0.25},
            ]
        }

        with mock.patch.object(extremity_module, 'PostgresClient') as MockPostgresClient, \
             mock.patch.object(extremity_module, 'GroupDataProcessor') as MockGroupDataProcessor, \
             mock.patch.object(extremity_module, 'check_existing_extremity_values', return_value={}):

            mock_postgres_instance = mock.MagicMock()
            # Simulate a database error
            mock_postgres_instance.get_report_comment_selections.side_effect = Exception("Database connection error")
            MockPostgresClient.return_value = mock_postgres_instance

            mock_processor_instance = mock.MagicMock()
            mock_processor_instance.get_export_data.return_value = mock_export_data
            MockGroupDataProcessor.return_value = mock_processor_instance

            # Should not raise an exception - graceful degradation
            result = calculate_and_store_extremity(
                conversation_id,
                force_recalculation=True,
                exclude_comment_selections=True
            )

        # All comments should be included since the query failed
        assert result == {101: 0.85, 102: 0.25}

    def test_exclude_comment_selections_only_excludes_negative_selections(self):
        """
        Tests that only selection=-1 excludes comments, while selection=1 and selection=0
        do not exclude comments.
        """
        conversation_id = 12345

        mock_export_data = {
            'comments': [
                {'comment_id': 101, 'comment_extremity': 0.85},  # selection=1 (included)
                {'comment_id': 102, 'comment_extremity': 0.25},  # selection=-1 (excluded)
                {'comment_id': 103, 'comment_extremity': 0.50},  # selection=0 (included)
                {'comment_id': 104, 'comment_extremity': 0.75},  # no selection (included)
            ]
        }

        mock_selections = [
            {'tid': 101, 'selection': 1, 'rid': 1, 'zid': conversation_id},
            {'tid': 102, 'selection': -1, 'rid': 1, 'zid': conversation_id},
            {'tid': 103, 'selection': 0, 'rid': 1, 'zid': conversation_id},
            # tid 104 has no selection record
        ]

        with mock.patch.object(extremity_module, 'PostgresClient') as MockPostgresClient, \
             mock.patch.object(extremity_module, 'GroupDataProcessor') as MockGroupDataProcessor, \
             mock.patch.object(extremity_module, 'check_existing_extremity_values', return_value={}):

            mock_postgres_instance = mock.MagicMock()
            mock_postgres_instance.get_report_comment_selections.return_value = mock_selections
            MockPostgresClient.return_value = mock_postgres_instance

            mock_processor_instance = mock.MagicMock()
            mock_processor_instance.get_export_data.return_value = mock_export_data
            MockGroupDataProcessor.return_value = mock_processor_instance

            result = calculate_and_store_extremity(
                conversation_id,
                force_recalculation=True,
                exclude_comment_selections=True
            )

        # Only comment 102 should be excluded
        assert 102 not in result, "Comment 102 should be excluded (selection=-1)"
        assert result.get(101) == 0.85, "Comment 101 should be included (selection=1)"
        assert result.get(103) == 0.50, "Comment 103 should be included (selection=0)"
        assert result.get(104) == 0.75, "Comment 104 should be included (no selection)"
