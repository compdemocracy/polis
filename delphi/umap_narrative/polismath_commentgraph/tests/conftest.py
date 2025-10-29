"""
PyTest configuration for the Polis comment graph microservice tests.
"""

import logging
import os
import uuid

import pytest

# Disable boto3 logging
logging.getLogger("boto3").setLevel(logging.CRITICAL)
logging.getLogger("botocore").setLevel(logging.CRITICAL)


@pytest.fixture
def aws_credentials():
    """Mocked AWS Credentials for testing."""
    os.environ["AWS_ACCESS_KEY_ID"] = "testing"
    os.environ["AWS_SECRET_ACCESS_KEY"] = "testing"
    os.environ["AWS_SECURITY_TOKEN"] = "testing"
    os.environ["AWS_SESSION_TOKEN"] = "testing"
    os.environ["AWS_DEFAULT_REGION"] = "us-east-1"


@pytest.fixture
def test_conversation_id():
    """Generate a unique conversation ID for testing."""
    return f"test-conversation-{uuid.uuid4()}"
