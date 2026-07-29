"""
Tests for the exclude_comment_selections feature in modules OTHER than 501_calculate_comment_extremity.

The 501 module tests are in test_501_calculate_comment_extremity.py.
This file covers:
- run_pipeline.py
- 801_narrative_report_batch.py  
- PostgresClient.get_report_comment_selections()
"""

import sys
import os
from unittest import mock
import pytest
import importlib

# Add parent directories to path for imports
delphi_dir = os.path.abspath(os.path.join(os.path.dirname(__file__), '..'))
umap_narrative_dir = os.path.join(delphi_dir, 'umap_narrative')
if delphi_dir not in sys.path:
    sys.path.insert(0, delphi_dir)
if umap_narrative_dir not in sys.path:
    sys.path.insert(0, umap_narrative_dir)


class TestRunPipelineExcludeCommentSelections:
    """Tests for exclude_comment_selections in run_pipeline.py."""

    @pytest.fixture
    def run_pipeline_module(self):
        """Import and return the run_pipeline module."""
        return importlib.import_module("run_pipeline")

    def test_process_conversation_filters_when_enabled(self, run_pipeline_module):
        """Test that process_conversation filters comments when exclude_comment_selections=True."""
        run_pipeline = run_pipeline_module
        
        mock_comments = [
            {'tid': 1, 'txt': 'Comment 1', 'mod': 0},
            {'tid': 2, 'txt': 'Comment 2', 'mod': 0},  # Will be excluded
            {'tid': 3, 'txt': 'Comment 3', 'mod': 0},
        ]
        
        mock_metadata = {'conversation_name': 'Test', 'zid': 12345}
        mock_selections = [{'tid': 2, 'selection': -1, 'rid': 1, 'zid': 12345}]
        
        with mock.patch.object(run_pipeline, 'fetch_conversation_data', return_value=(mock_comments, mock_metadata)), \
             mock.patch.object(run_pipeline, 'PostgresClient') as MockPostgresClient, \
             mock.patch.object(run_pipeline, 'process_comments') as mock_process_comments, \
             mock.patch.object(run_pipeline, 'DynamoDBStorage'), \
             mock.patch.object(run_pipeline, 'process_layers_and_create_visualizations'), \
             mock.patch('os.makedirs'), \
             mock.patch('builtins.open', mock.mock_open()):
            
            mock_postgres = mock.MagicMock()
            mock_postgres.get_report_comment_selections.return_value = mock_selections
            MockPostgresClient.return_value = mock_postgres
            
            mock_process_comments.return_value = ([[0, 0]], [[0.1]], [[0]], ['C1'], [1])
            
            run_pipeline.process_conversation(
                zid=12345, export_dynamo=False, exclude_comment_selections=True
            )
            
            # Verify filtered comments passed to process_comments
            comments_passed = mock_process_comments.call_args[0][0]
            passed_tids = [c['tid'] for c in comments_passed]
            assert 2 not in passed_tids, "tid 2 should be excluded"
            assert 1 in passed_tids and 3 in passed_tids

    def test_process_conversation_no_filter_when_disabled(self, run_pipeline_module):
        """Test that all comments included when exclude_comment_selections=False."""
        run_pipeline = run_pipeline_module
        
        mock_comments = [
            {'tid': 1, 'txt': 'Comment 1', 'mod': 0},
            {'tid': 2, 'txt': 'Comment 2', 'mod': 0},
        ]
        mock_metadata = {'conversation_name': 'Test', 'zid': 12345}
        
        with mock.patch.object(run_pipeline, 'fetch_conversation_data', return_value=(mock_comments, mock_metadata)), \
             mock.patch.object(run_pipeline, 'PostgresClient') as MockPostgresClient, \
             mock.patch.object(run_pipeline, 'process_comments') as mock_process_comments, \
             mock.patch.object(run_pipeline, 'DynamoDBStorage'), \
             mock.patch.object(run_pipeline, 'process_layers_and_create_visualizations'), \
             mock.patch('os.makedirs'), \
             mock.patch('builtins.open', mock.mock_open()):
            
            mock_postgres = mock.MagicMock()
            MockPostgresClient.return_value = mock_postgres
            mock_process_comments.return_value = ([[0, 0]], [[0.1]], [[0]], ['C1'], [1])
            
            run_pipeline.process_conversation(
                zid=12345, export_dynamo=False, exclude_comment_selections=False
            )
            
            # get_report_comment_selections should NOT be called
            mock_postgres.get_report_comment_selections.assert_not_called()


class TestBatchReportGeneratorExcludeCommentSelections:
    """Tests for exclude_comment_selections in BatchReportGenerator."""

    def test_init_stores_exclude_flag(self):
        """Test that BatchReportGenerator stores the exclude_comment_selections flag."""
        batch_module = importlib.import_module("801_narrative_report_batch")
        
        with mock.patch.object(batch_module, 'PostgresClient'), \
             mock.patch.object(batch_module, 'GroupDataProcessor'), \
             mock.patch.object(batch_module, 'NarrativeReportService'), \
             mock.patch('boto3.resource'), \
             mock.patch.dict(os.environ, {'ANTHROPIC_MODEL': 'test-model'}):
            
            gen_true = batch_module.BatchReportGenerator(
                conversation_id=123, exclude_comment_selections=True
            )
            gen_false = batch_module.BatchReportGenerator(
                conversation_id=123, exclude_comment_selections=False
            )
            
            assert gen_true.exclude_comment_selections is True
            assert gen_false.exclude_comment_selections is False


class TestPostgresClientGetReportCommentSelections:
    """Tests for the get_report_comment_selections database method."""

    def test_query_without_rid(self):
        """Test SQL query structure when rid is not provided."""
        from polismath.database.postgres import PostgresClient
        
        with mock.patch.object(PostgresClient, 'query') as mock_query:
            mock_query.return_value = []
            client = PostgresClient()
            client._engine = mock.MagicMock()
            
            client.get_report_comment_selections(zid=12345)
            
            sql, params = mock_query.call_args[0]
            assert 'report_comment_selections' in sql
            assert 'zid = :zid' in sql
            assert params == {'zid': 12345}
            assert 'rid = :rid' not in sql

    def test_query_with_rid(self):
        """Test SQL query includes rid filter when provided."""
        from polismath.database.postgres import PostgresClient
        
        with mock.patch.object(PostgresClient, 'query') as mock_query:
            mock_query.return_value = []
            client = PostgresClient()
            client._engine = mock.MagicMock()
            
            client.get_report_comment_selections(zid=12345, rid=99)
            
            sql, params = mock_query.call_args[0]
            assert 'rid = :rid' in sql
            assert params == {'zid': 12345, 'rid': 99}
