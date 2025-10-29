"""
Pytest configuration and fixtures for Delphi tests.

This file provides common fixtures and configuration for all tests in the project.
It handles database setup, DynamoDB mocking, and other common test infrastructure.
"""

import os
import sys
import tempfile
import time
from pathlib import Path
from unittest.mock import MagicMock, patch

import boto3
import numpy as np
import pandas as pd
import pytest
from moto import mock_dynamodb

# Add project root to Python path
sys.path.insert(0, str(Path(__file__).parent))


# ============================================================================
# Test Configuration
# ============================================================================


def pytest_configure(config):
    """Configure pytest with custom markers."""
    config.addinivalue_line("markers", "slow: marks tests as slow running")
    config.addinivalue_line("markers", "integration: marks tests as integration tests")
    config.addinivalue_line("markers", "unit: marks tests as unit tests")
    config.addinivalue_line("markers", "real_data: marks tests that use real conversation data")


def pytest_collection_modifyitems(config, items):
    """Automatically mark tests based on their location and name."""
    for item in items:
        # Mark real data tests
        if "real_data" in item.nodeid or "real_data" in str(item.fspath):
            item.add_marker(pytest.mark.real_data)

        # Mark slow tests
        if "slow" in item.nodeid or any(
            keyword in item.nodeid.lower() for keyword in ["full_pipeline", "system", "integration"]
        ):
            item.add_marker(pytest.mark.slow)

        # Mark integration tests
        if any(keyword in item.nodeid.lower() for keyword in ["integration", "system", "full_pipeline"]):
            item.add_marker(pytest.mark.integration)
        else:
            item.add_marker(pytest.mark.unit)


# ============================================================================
# Environment and Configuration Fixtures
# ============================================================================


@pytest.fixture(scope="session")
def test_env():
    """Set up test environment variables."""
    original_env = os.environ.copy()

    # Set test-specific environment variables
    test_vars = {
        "MATH_ENV": "test",
        "LOG_LEVEL": "WARNING",
        "DATABASE_HOST": "localhost",
        "DATABASE_NAME": "polis_test",
        "DATABASE_USER": "test_user",
        "DATABASE_PASSWORD": "test_pass",
        "DATABASE_PORT": "5432",
        "DYNAMODB_ENDPOINT": "http://localhost:8000",
        "AWS_ACCESS_KEY_ID": "testing",
        "AWS_SECRET_ACCESS_KEY": "testing",
        "AWS_REGION": "us-east-1",
        "OLLAMA_HOST": "http://localhost:11434",
        "OLLAMA_MODEL": "llama3.1:8b",
        "SENTENCE_TRANSFORMER_MODEL": "all-MiniLM-L6-v2",
    }

    for key, value in test_vars.items():
        os.environ[key] = value

    yield test_vars

    # Restore original environment
    os.environ.clear()
    os.environ.update(original_env)


@pytest.fixture
def temp_dir():
    """Create a temporary directory for test outputs."""
    with tempfile.TemporaryDirectory() as tmpdir:
        yield Path(tmpdir)


# ============================================================================
# Database Fixtures
# ============================================================================


@pytest.fixture(scope="session")
@mock_dynamodb
def mock_dynamodb_resource():
    """Create a mocked DynamoDB resource for testing."""
    dynamodb = boto3.resource("dynamodb", region_name="us-east-1", endpoint_url="http://localhost:8000")
    yield dynamodb


@pytest.fixture
def dynamodb_tables(mock_dynamodb_resource):
    """Create test DynamoDB tables."""
    tables = {}

    # Define table schemas (simplified versions of production tables)
    table_schemas = {
        "Delphi_PCAConversationConfig": {
            "AttributeDefinitions": [{"AttributeName": "conversation_id", "AttributeType": "S"}],
            "KeySchema": [{"AttributeName": "conversation_id", "KeyType": "HASH"}],
            "BillingMode": "PAY_PER_REQUEST",
        },
        "Delphi_CommentEmbeddings": {
            "AttributeDefinitions": [
                {"AttributeName": "conversation_id", "AttributeType": "S"},
                {"AttributeName": "comment_id", "AttributeType": "S"},
            ],
            "KeySchema": [
                {"AttributeName": "conversation_id", "KeyType": "HASH"},
                {"AttributeName": "comment_id", "KeyType": "RANGE"},
            ],
            "BillingMode": "PAY_PER_REQUEST",
        },
    }

    for table_name, schema in table_schemas.items():
        table = mock_dynamodb_resource.create_table(TableName=table_name, **schema)
        tables[table_name] = table

    yield tables


# ============================================================================
# Data Fixtures
# ============================================================================


@pytest.fixture
def sample_conversation_data():
    """Provide sample conversation data for testing."""
    return {
        "conversation_id": "12345",
        "participants": [
            {"pid": 1, "created": "2023-01-01"},
            {"pid": 2, "created": "2023-01-02"},
            {"pid": 3, "created": "2023-01-03"},
        ],
        "comments": [
            {"tid": 1, "txt": "This is comment 1", "pid": 1},
            {"tid": 2, "txt": "This is comment 2", "pid": 2},
            {"tid": 3, "txt": "This is comment 3", "pid": 3},
        ],
        "votes": [
            {"tid": 1, "pid": 2, "vote": 1},  # agree
            {"tid": 1, "pid": 3, "vote": -1},  # disagree
            {"tid": 2, "pid": 1, "vote": 1},  # agree
            {"tid": 2, "pid": 3, "vote": 0},  # pass
            {"tid": 3, "pid": 1, "vote": -1},  # disagree
            {"tid": 3, "pid": 2, "vote": 1},  # agree
        ],
    }


@pytest.fixture
def sample_vote_matrix():
    """Create a sample vote matrix for testing."""
    # 3 participants, 3 comments
    # Vote values: 1 (agree), -1 (disagree), 0 (pass), NaN (not voted)
    data = np.array(
        [
            [np.nan, 1, -1],  # Participant 1 votes
            [1, np.nan, 1],  # Participant 2 votes
            [-1, 0, np.nan],  # Participant 3 votes
        ]
    )

    return pd.DataFrame(
        data,
        index=[f"pid_{i}" for i in range(1, 4)],
        columns=[f"tid_{i}" for i in range(1, 4)],
    )


@pytest.fixture
def sample_embeddings():
    """Create sample comment embeddings for testing."""
    np.random.seed(42)  # For reproducible tests
    return {
        "comment_1": np.random.randn(384),
        "comment_2": np.random.randn(384),
        "comment_3": np.random.randn(384),
    }


# ============================================================================
# Mock Fixtures
# ============================================================================


@pytest.fixture
def mock_ollama_client():
    """Mock the Ollama client for testing."""
    with patch("ollama.Client") as mock_client:
        mock_instance = MagicMock()
        mock_instance.chat.return_value = {"message": {"content": "Mock LLM response"}}
        mock_client.return_value = mock_instance
        yield mock_instance


@pytest.fixture
def mock_sentence_transformer():
    """Mock the SentenceTransformer for testing."""
    with patch("sentence_transformers.SentenceTransformer") as mock_st:
        mock_instance = MagicMock()
        mock_instance.encode.return_value = np.random.randn(10, 384)
        mock_st.return_value = mock_instance
        yield mock_instance


@pytest.fixture
def mock_postgres_connection():
    """Mock PostgreSQL connection for testing."""
    with patch("sqlalchemy.create_engine") as mock_engine:
        mock_conn = MagicMock()
        mock_engine.return_value.connect.return_value = mock_conn
        yield mock_conn


# ============================================================================
# Integration Test Fixtures
# ============================================================================


@pytest.fixture(scope="session")
def integration_test_setup():
    """Set up resources for integration tests."""
    # Only run integration setup if integration tests are being run
    if "integration" not in sys.argv and "-m integration" not in " ".join(sys.argv):
        pytest.skip("Integration test setup only runs for integration tests")

    # This would set up real databases, etc. for integration tests
    # For now, just provide a placeholder
    yield {"status": "integration_ready"}


# ============================================================================
# Performance Test Helpers
# ============================================================================


@pytest.fixture
def performance_timer():
    """Fixture for timing test performance."""

    class Timer:
        def __init__(self):
            self.start_time = None
            self.end_time = None

        def start(self):
            self.start_time = time.time()

        def stop(self):
            self.end_time = time.time()
            return self.elapsed

        @property
        def elapsed(self):
            if self.start_time is None or self.end_time is None:
                return None
            return self.end_time - self.start_time

    return Timer()


# ============================================================================
# Cleanup Fixtures
# ============================================================================


@pytest.fixture(autouse=True)
def cleanup_after_test():
    """Automatic cleanup after each test."""
    yield
    # Cleanup code here if needed
    # For example, clearing caches, resetting global state, etc.
    pass
