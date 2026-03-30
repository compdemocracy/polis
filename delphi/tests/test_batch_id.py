#!/usr/bin/env python3
"""
Tests for batch_id storage and retrieval in DynamoDB.

Verifies that:
1. Batch_id is stored and retrieved correctly
2. Poller's scan query finds jobs with batch_id
3. Simple scan can find jobs by job_id
"""

import pytest
import boto3
import uuid
import json
import time
import logging
import os
from datetime import datetime
from typing import Dict, Any

logger = logging.getLogger(__name__)


class TestBatchIdStorage:
    """Tests for batch_id storage and retrieval in DynamoDB JobQueue."""

    @pytest.fixture(scope="class")
    def dynamodb_resource(self):
        """Set up DynamoDB resource connection."""
        from tests.conftest import require_dynamodb
        require_dynamodb()
        logger.debug("Setting up DynamoDB resource connection")
        return boto3.resource(
            'dynamodb',
            endpoint_url=os.environ.get('DYNAMODB_ENDPOINT', 'http://localhost:8000'),
            region_name='us-east-1',
            aws_access_key_id='fakeMyKeyId',
            aws_secret_access_key='fakeSecretAccessKey'
        )

    @pytest.fixture(scope="class")
    def job_table(self, dynamodb_resource):
        """Get the Delphi_JobQueue table."""
        logger.debug("Getting Delphi_JobQueue table")
        return dynamodb_resource.Table('Delphi_JobQueue')

    @pytest.fixture
    def job_id(self) -> str:
        """Generate a unique job ID for testing."""
        generated_id = f"test_batch_job_{int(time.time())}_{uuid.uuid4().hex[:8]}"
        logger.debug(f"Generated job ID: {generated_id}")
        return generated_id

    @pytest.fixture
    def sample_batch_id(self) -> str:
        """Provide a sample batch ID for testing."""
        return "msgbatch_01HkcTjaV5uDC8jWR4ZsDV8d"

    @pytest.fixture
    def created_job(self, job_id: str, sample_batch_id: str, job_table) -> Dict[str, Any]:
        """
        Create and store a job with a batch_id in DynamoDB.

        Yields the job item, then cleans up after the test.
        """
        current_time = datetime.now().isoformat()

        job_item = {
            'job_id': job_id,
            'conversation_id': '19305',
            'status': 'PROCESSING',
            'job_type': 'NARRATIVE_BATCH',
            'created_at': current_time,
            'updated_at': current_time,
            'batch_id': sample_batch_id,
            'batch_status': 'processing',
            'priority': 10,
            'version': 1,
            'logs': json.dumps({'entries': []})
        }

        # Store the job
        logger.debug(f"Creating job: {job_id}")
        response = job_table.put_item(Item=job_item)
        logger.debug(f"Job created with response: {response}")

        # Wait briefly for consistency
        time.sleep(1)

        yield job_item

        # Cleanup: delete the test job
        try:
            logger.debug(f"Cleaning up job: {job_id}")
            job_table.delete_item(Key={'job_id': job_id})
        except Exception as e:
            logger.warning(f"Failed to cleanup job {job_id}: {e}")

    def test_batch_id_stored_correctly(self, created_job: Dict[str, Any], job_table, job_id: str, sample_batch_id: str):
        """Test that batch_id is stored and retrieved correctly from DynamoDB."""
        # Retrieve the job
        get_response = job_table.get_item(Key={'job_id': job_id})

        # Assert job was retrieved
        assert 'Item' in get_response, f"Job {job_id} not found in DynamoDB"

        job = get_response['Item']
        logger.debug(f"Retrieved job fields: {list(job.keys())}")

        # Assert batch_id is present
        assert 'batch_id' in job, "batch_id field not found in retrieved job"

        # Assert batch_id has correct value
        assert job['batch_id'] == sample_batch_id, \
            f"batch_id mismatch: expected {sample_batch_id}, got {job['batch_id']}"

        logger.debug(f"Verification success: batch_id is present and correct: {job['batch_id']}")

    def test_poller_scan_finds_batch_jobs(self, created_job: Dict[str, Any], job_table, job_id: str):
        """
        Test that the poller's scan query correctly finds jobs with batch_id.

        This tests the actual FilterExpression used by the batch job poller.
        Note: Uses ExpressionAttributeNames to properly escape 'status' reserved keyword.
        """
        # Use the poller's scan query with proper attribute name escaping
        scan_response = job_table.scan(
            FilterExpression='attribute_exists(batch_id) AND (attribute_not_exists(#status) OR #status <> :completed_status)',
            ExpressionAttributeNames={
                '#status': 'status'  # Escape reserved keyword
            },
            ExpressionAttributeValues={
                ':completed_status': 'COMPLETED'
            }
        )

        items = scan_response.get('Items', [])
        logger.debug(f"Scan returned {len(items)} items")

        # Find our test job in the results
        found_job = None
        for item in items:
            if item.get('job_id') == job_id:
                found_job = item
                break

        # Assert job was found by scan
        assert found_job is not None, \
            f"Job {job_id} not found by poller scan with batch_id filter"

        # Assert it has the expected fields
        assert 'batch_id' in found_job, "batch_id missing from scanned job"
        assert 'job_id' in found_job, "job_id missing from scanned job"

        logger.debug(f"Scan success: Job found with fields: {list(found_job.keys())}")

    def test_simple_scan_by_job_id(self, created_job: Dict[str, Any], job_table, job_id: str):
        """Test that a simple scan can find jobs by job_id."""
        # Simple scan by job_id
        simple_scan = job_table.scan(
            FilterExpression='job_id = :job_id',
            ExpressionAttributeValues={':job_id': job_id}
        )

        items = simple_scan.get('Items', [])

        # Assert job was found
        assert len(items) > 0, f"Job {job_id} not found in simple scan"
        assert len(items) == 1, f"Expected 1 job, found {len(items)}"

        job = items[0]

        # Assert it's the correct job
        assert job['job_id'] == job_id, "Wrong job returned by simple scan"
        assert 'batch_id' in job, "batch_id missing from job in simple scan"

        logger.debug(f"Simple scan success: Job found with batch_id: {job.get('batch_id')}")

    def test_batch_id_attribute_exists_filter(self, created_job: Dict[str, Any], job_table, job_id: str):
        """Test that attribute_exists(batch_id) filter works correctly."""
        # Scan only for jobs with batch_id attribute
        scan_response = job_table.scan(
            FilterExpression='attribute_exists(batch_id)'
        )

        items = scan_response.get('Items', [])
        logger.debug(f"Found {len(items)} jobs with batch_id attribute")

        # Find our test job
        found = any(item.get('job_id') == job_id for item in items)

        # Assert our test job is in the results
        assert found, f"Job {job_id} not found in scan for batch_id attribute"

        # Assert all returned items have batch_id
        for item in items:
            assert 'batch_id' in item, \
                f"Job {item.get('job_id')} returned without batch_id attribute"

        logger.debug("attribute_exists(batch_id) filter working correctly")
