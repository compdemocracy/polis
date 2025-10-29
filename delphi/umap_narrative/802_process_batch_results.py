#!/usr/bin/env python3
"""
Process batch narrative report results from Anthropic Batch API.

This script:
1. Retrieves batch job metadata from DynamoDB
2. Checks the status of Anthropic batch jobs
3. Processes completed requests and stores results
4. Handles sequential fallback processing when batch API is unavailable

Usage:
    python 802_process_batch_results.py --batch_id BATCH_ID [--force]

Args:
    --batch_id: ID of the batch job to process
    --force: Force processing even if the job is not marked as completed
"""

import argparse
import asyncio
import logging
import os
import sys
import traceback
from datetime import datetime

import boto3
import requests

# Import from local modules (set the path first)
sys.path.append(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from umap_narrative.llm_factory_constructor import get_model_provider

# Configure logging
logging.basicConfig(level=logging.INFO, format="%(asctime)s - %(levelname)s - %(message)s")
logger = logging.getLogger(__name__)


class ReportStorageService:
    """Storage service for report data in DynamoDB."""

    def __init__(
        self,
        dynamodb_resource,
        table_name="Delphi_NarrativeReports",
        disable_cache=False,
    ):
        """Initialize the report storage service."""
        self.table_name = table_name
        self.disable_cache = disable_cache
        self.dynamodb = dynamodb_resource
        self.table = self.dynamodb.Table(self.table_name)

    def init_table(self):
        """Check if the table exists"""
        try:
            _ = self.table.table_status  # Check table accessibility
            logger.info(f"Table {self.table_name} exists and is accessible.")
        except Exception as e:
            logger.error(f"Error checking table {self.table_name}: {str(e)}")
            return e

    def put_item(self, item):
        """Store an item in DynamoDB.

        Args:
            item: Dictionary with the item data
        """
        try:
            response = self.table.put_item(Item=item)
            logger.info(f"Item stored successfully: {response}")
            return response
        except Exception as e:
            logger.error(f"Error storing item: {str(e)}")
            return None


class BatchReportStorageService:
    """Storage service for batch job metadata in DynamoDB."""

    def __init__(self, dynamodb_resource, table_name="Delphi_BatchJobs"):
        """Initialize the batch job storage service."""
        self.table_name = table_name
        self.dynamodb = dynamodb_resource
        self.table = self.dynamodb.Table(self.table_name)

    def get_item(self, batch_id):
        """Get a batch job by ID.

        Args:
            batch_id: ID of the batch job

        Returns:
            Dictionary with the batch job metadata
        """
        try:
            response = self.table.get_item(Key={"batch_id": batch_id})
            return response.get("Item")
        except Exception as e:
            logger.error(f"Error getting batch job: {str(e)}")
            return None

    def update_item(self, batch_id, updates):
        """Update a batch job.

        Args:
            batch_id: ID of the batch job
            updates: Dictionary with updates to apply
        """
        try:
            # Build update expression
            update_expression = "SET "
            expression_attribute_values = {}

            for key, value in updates.items():
                update_expression += f"{key} = :{key.replace('.', '_')}, "
                expression_attribute_values[f":{key.replace('.', '_')}"] = value

            update_expression = update_expression[:-2]

            response = self.table.update_item(
                Key={"batch_id": batch_id},
                UpdateExpression=update_expression,
                ExpressionAttributeValues=expression_attribute_values,
            )
            logger.info(f"Batch job updated successfully: {response}")
            return response
        except Exception as e:
            logger.error(f"Error updating batch job: {str(e)}")
            return None


class AnthropicBatchChecker:
    """Check the status of Anthropic batch jobs."""

    def __init__(self, api_key=None):
        """Initialize the Anthropic batch checker.

        Args:
            api_key: Anthropic API key
        """
        self.api_key = api_key or os.environ.get("ANTHROPIC_API_KEY")

        if not self.api_key:
            logger.warning("No Anthropic API key provided. Set ANTHROPIC_API_KEY env var or pass api_key parameter.")

    def check_batch_status(self, batch_id):
        """Check the status of an Anthropic batch job.

        Args:
            batch_id: ID of the Anthropic batch job

        Returns:
            Dictionary with batch job status
        """
        if not self.api_key:
            logger.error("No Anthropic API key provided for checking batch status")
            return {"error": "API key missing"}

        try:
            logger.info(f"Checking status of Anthropic batch job: {batch_id}")

            # Use Anthropic API to check batch status
            headers = {
                "x-api-key": self.api_key,
                "anthropic-version": "2023-06-01",
                "content-type": "application/json",
            }

            response = requests.get(
                f"https://api.anthropic.com/v1/messages/batch/{batch_id}",
                headers=headers,
            )

            # Check if the batch endpoint is available
            if response.status_code == 404:
                logger.warning("Anthropic Batch API endpoint not found (404)")
                return {"error": "Batch API not available"}

            # Raise for other errors
            response.raise_for_status()

            # Get response data
            response_data = response.json()
            logger.info(f"Batch status: {response_data.get('status', 'unknown')}")

            return response_data

        except requests.exceptions.HTTPError as e:
            if e.response.status_code == 404:
                logger.warning("Anthropic Batch API endpoint not found (404)")
                return {"error": "Batch API not available"}
            else:
                logger.error(f"HTTP error checking Anthropic batch status: {str(e)}")
                return {"error": f"HTTP error: {str(e)}"}

        except Exception as e:
            logger.error(f"Error checking Anthropic batch status: {str(e)}")
            return {"error": str(e)}


class BatchResultProcessor:
    """Process batch narrative report results."""

    def __init__(self, batch_id, force=False):
        """Initialize the batch result processor."""
        self.batch_id = batch_id
        self.force = force

        dynamodb = boto3.resource(
            "dynamodb",
            endpoint_url=os.environ.get("DYNAMODB_ENDPOINT"),
            region_name=os.environ.get("AWS_DEFAULT_REGION", "us-east-1"),
        )
        # Set local credentials only if a local endpoint is actually being used
        if dynamodb.meta.client.meta.endpoint_url:
            os.environ.setdefault("AWS_ACCESS_KEY_ID", "fakeMyKeyId")
            os.environ.setdefault("AWS_SECRET_ACCESS_KEY", "fakeSecretAccessKey")

        self.batch_storage = BatchReportStorageService(dynamodb_resource=dynamodb)
        self.report_storage = ReportStorageService(dynamodb_resource=dynamodb)

        self.report_storage.init_table()
        self.batch_job = None
        self.anthropic_checker = AnthropicBatchChecker()

    async def process_batch_results(self):
        """Process the batch job results.

        Returns:
            True if processing is successful, False otherwise
        """
        # Get batch job from DynamoDB
        self.batch_job = self.batch_storage.get_item(self.batch_id)

        if not self.batch_job:
            logger.error(f"Batch job {self.batch_id} not found")
            return False

        # Check if we can process this job
        if not self.can_process_job():
            return False

        # Determine processing approach
        if self.batch_job.get("status") == "sequential_fallback":
            # Process with sequential fallback
            logger.info(f"Processing batch job {self.batch_id} with sequential fallback")
            return await self.process_sequential_fallback()
        elif self.batch_job.get("status") in ["submitted", "completed"]:
            # Process with Anthropic Batch API
            logger.info(f"Processing batch job {self.batch_id} with Anthropic Batch API")
            return await self.process_anthropic_batch()
        else:
            logger.error(f"Batch job {self.batch_id} has unsupported status: {self.batch_job.get('status')}")
            return False

    def can_process_job(self):
        """Check if we can process this batch job.

        Returns:
            True if we can process this job, False otherwise
        """
        # Check if batch job exists
        if not self.batch_job:
            logger.error(f"Batch job {self.batch_id} not found")
            return False

        # Check if we're in a valid state for processing
        valid_states = ["submitted", "completed", "sequential_fallback"]
        if self.batch_job.get("status") not in valid_states and not self.force:
            logger.error(
                f"Batch job {self.batch_id} is not in a valid state for processing: {self.batch_job.get('status')}"
            )
            logger.error(f"Valid states are: {valid_states}. Use --force to process anyway.")
            return False

        return True

    async def process_anthropic_batch(self):
        """Process batch job results from Anthropic Batch API.

        Returns:
            True if processing is successful, False otherwise
        """
        # Get batch status from Anthropic
        anthropic_batch_id = self.batch_job.get("anthropic_batch_id")
        if not anthropic_batch_id:
            logger.error(f"Batch job {self.batch_id} does not have an Anthropic batch ID")
            return False

        # Get batch status
        batch_status = self.anthropic_checker.check_batch_status(anthropic_batch_id)

        # Check if we got a valid status
        if isinstance(batch_status.get("error"), str):
            logger.error(f"Error checking Anthropic batch status: {batch_status.get('error')}")
            return False

        # Check if batch is completed
        if batch_status.get("status") != "completed" and not self.force:
            logger.error(f"Anthropic batch job {anthropic_batch_id} is not completed: {batch_status.get('status')}")
            logger.error("Use --force to process anyway.")
            return False

        # Process each request in the batch
        logger.info(f"Processing {len(batch_status.get('requests', []))} requests")

        # Get request metadata mapping
        request_metadata = {}
        if "request_map" in self.batch_job:
            for req_id, metadata in self.batch_job["request_map"].items():
                request_metadata[req_id] = metadata

        # Process each request
        successful_requests = 0
        for req in batch_status.get("requests", []):
            req_id = req.get("request_id")
            status = req.get("status")

            # Skip requests that are not completed
            if status != "completed" and not self.force:
                logger.warning(f"Skipping request {req_id} with status {status}")
                continue

            # Get metadata for this request
            metadata = request_metadata.get(req_id, {})
            if not metadata:
                logger.warning(f"No metadata found for request {req_id}")
                continue

            # Get topic info
            topic_name = metadata.get("topic_name", "Unknown")
            section_name = metadata.get("section_name", "Unknown")
            conversation_id = metadata.get("conversation_id", "Unknown")

            logger.info(f"Processing request {req_id} for topic '{topic_name}'")

            # Get response content
            if "message" not in req:
                logger.warning(f"No message found in request {req_id}")
                continue

            message = req.get("message", {})
            if "content" not in message or not message.get("content"):
                logger.warning(f"No content found in message for request {req_id}")
                continue

            # Extract content text
            content = message.get("content", [])
            if not content or not isinstance(content, list) or "text" not in content[0]:
                logger.warning(f"Invalid content format for request {req_id}")
                continue

            response_text = content[0].get("text", "")

            # Store in Delphi_NarrativeReports
            rid_section_model = f"{conversation_id}#{section_name}#{self.batch_job.get('model')}"

            report_item = {
                "rid_section_model": rid_section_model,
                "timestamp": datetime.now().isoformat(),
                "report_data": response_text,
                "model": self.batch_job.get("model"),
                "errors": None,
                "batch_id": self.batch_id,
                "request_id": req_id,
                "report_id": conversation_id,
                "metadata": {
                    "topic_name": topic_name,
                    "cluster_id": metadata.get("cluster_id"),
                },
            }

            self.report_storage.put_item(report_item)

            logger.info(f"Stored report for topic '{topic_name}'")
            successful_requests += 1

        # Update batch job status
        updates = {
            "updated_at": datetime.now().isoformat(),
            "completed_requests": successful_requests,
            "processing_completed": True,
            "processing_timestamp": datetime.now().isoformat(),
        }

        if successful_requests == len(batch_status.get("requests", [])):
            updates["status"] = "results_processed"

        self.batch_storage.update_item(self.batch_id, updates)

        logger.info(f"Processed {successful_requests} of {len(batch_status.get('requests', []))} requests")
        return True

    async def process_sequential_fallback(self):
        """
        Process batch job with sequential fallback, avoiding N+1 queries.

        This is used when the Anthropic Batch API is not available.

        Returns:
            True if processing is successful, False otherwise
        """
        # Get request data
        if "request_map" not in self.batch_job:
            logger.error(f"Batch job {self.batch_id} does not have request data for fallback.")
            return False

        # Get model provider and request data
        model_name = self.batch_job.get("model", "claude-3-5-sonnet-20241022")
        model_provider = get_model_provider("anthropic", model_name)
        request_map = self.batch_job.get("request_map", {})
        total_requests = len(request_map)
        successful_requests = 0

        logger.info(f"Processing {total_requests} requests sequentially")

        # Update batch job status to show it's in sequential processing
        self.batch_storage.update_item(
            self.batch_id,
            {
                "status": "sequential_processing",
                "updated_at": datetime.now().isoformat(),
            },
        )

        existing_reports = set()
        if not self.force and request_map:
            keys_to_check = []
            for metadata in request_map.values():
                # Construct the primary key for the Delphi_NarrativeReports table
                keys_to_check.append(
                    {
                        "rid_section_model": f"{metadata.get('conversation_id')}#{metadata.get('section_name')}#{model_name}"
                    }
                )

            # batch_get_item has a limit of 100 keys per request, so we may need to batch our check
            if keys_to_check:
                logger.info(f"Checking for {len(keys_to_check)} existing reports before processing...")
                for i in range(0, len(keys_to_check), 100):
                    batch_keys = keys_to_check[i : i + 100]
                    response = self.report_storage.dynamodb.batch_get_item(
                        RequestItems={self.report_storage.table_name: {"Keys": batch_keys}}
                    )

                    for item in response.get("Responses", {}).get(self.report_storage.table_name, []):
                        existing_reports.add(item["rid_section_model"])

                logger.info(f"Found {len(existing_reports)} existing reports to skip.")
        # Process each request
        for req_id, metadata in request_map.items():
            # Get topic info from metadata
            topic_name = metadata.get("topic_name", "Unknown")
            section_name = metadata.get("section_name", "Unknown")
            conversation_id = metadata.get("conversation_id", "Unknown")

            logger.info(f"Processing request {req_id} for topic '{topic_name}'")

            rid_section_model = f"{conversation_id}#{section_name}#{model_name}"

            if rid_section_model in existing_reports:
                logger.info(f"Report already exists for topic '{topic_name}', skipping.")
                successful_requests += 1
                continue

            try:
                # Find the original request data to pass to the LLM
                # This uses the 'custom_id' which was originally derived from section_name
                original_request_data = next(
                    (
                        req
                        for req in self.batch_job.get("batch_data", {}).get("requests", [])
                        if req.get("custom_id", "").endswith(section_name)
                    ),
                    None,
                )

                if original_request_data:
                    system = original_request_data.get("params", {}).get("system", "")
                    user_message_list = (
                        original_request_data.get("params", {}).get("messages", [{}])[0].get("content", [])
                    )

                    # Extract the text from the complex message structure
                    user_message = ""
                    if user_message_list and isinstance(user_message_list, list) and "text" in user_message_list[0]:
                        user_message = user_message_list[0]["text"]

                    if system and user_message:
                        logger.info(f"Generating response for topic '{topic_name}'")

                        # Add a short delay to avoid rate limiting
                        await asyncio.sleep(1)

                        # Get response from the LLM
                        response_text = await model_provider.get_response(system, user_message)

                        # Store in Delphi_NarrativeReports
                        report_item = {
                            "rid_section_model": rid_section_model,
                            "timestamp": datetime.now().isoformat(),
                            "report_data": response_text,
                            "model": model_name,
                            "errors": None,
                            "batch_id": self.batch_id,
                            "request_id": req_id,
                            "sequential_fallback": True,
                            "report_id": conversation_id,
                        }

                        self.report_storage.put_item(report_item)

                        logger.info(f"Stored report for topic '{topic_name}'")
                        successful_requests += 1

                        # Update batch job with progress
                        self.batch_storage.update_item(
                            self.batch_id,
                            {
                                "completed_requests": successful_requests,
                                "updated_at": datetime.now().isoformat(),
                            },
                        )
                    else:
                        logger.warning(f"Missing system or messages for request {req_id}")
                else:
                    logger.warning(f"Could not find matching original request data for request ID {req_id}")

            except Exception as e:
                logger.error(f"Error processing request {req_id} for topic '{topic_name}': {str(e)}")
                logger.error(traceback.format_exc())
        updates = {
            "updated_at": datetime.now().isoformat(),
            "completed_requests": successful_requests,
            "processing_completed": True,
            "processing_timestamp": datetime.now().isoformat(),
        }

        if successful_requests == total_requests:
            updates["status"] = "results_processed"
        else:
            updates["status"] = "partially_processed"

        self.batch_storage.update_item(self.batch_id, updates)

        logger.info(f"Processed {successful_requests} of {total_requests} requests sequentially")
        return True


async def main():
    """Main entry point."""
    parser = argparse.ArgumentParser(description="Process batch narrative report results")
    parser.add_argument("--batch_id", type=str, required=True, help="ID of the batch job to process")
    parser.add_argument(
        "--force",
        action="store_true",
        help="Force processing even if the job is not marked as completed",
    )
    args = parser.parse_args()

    # Process batch results
    processor = BatchResultProcessor(args.batch_id, args.force)
    success = await processor.process_batch_results()

    if success:
        logger.info(f"Successfully processed batch job {args.batch_id}")
        print(f"Successfully processed batch job {args.batch_id}")
    else:
        logger.error(f"Failed to process batch job {args.batch_id}")
        print(f"Failed to process batch job {args.batch_id}. See logs for details.")


if __name__ == "__main__":
    import asyncio

    asyncio.run(main())
