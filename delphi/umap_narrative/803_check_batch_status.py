#!/usr/bin/env python3
"""
Check and process Anthropic Batch API results for a specific job.

This script is a simple worker that is called by the job_poller. It does not
contain any job-finding or locking logic itself. It expects to be given a
single job ID to process.

Usage:
    python 803_check_batch_status.py --job-id JOB_ID
"""

import argparse
import asyncio
import logging
import os
import sys
from datetime import UTC, datetime, timedelta

import boto3
from anthropic import Anthropic
from botocore.exceptions import ClientError

# Configure logging
logging.basicConfig(level=logging.INFO, format="%(asctime)s - %(levelname)s - %(message)s")
logger = logging.getLogger(__name__)

# Anthropic Batch API Statuses
ANTHROPIC_BATCH_PREPARING = "preparing"
ANTHROPIC_BATCH_IN_PROGRESS = "in_progress"
ANTHROPIC_BATCH_COMPLETED = "completed"
ANTHROPIC_BATCH_ENDED = "ended"  # Anthropic API returns "ended" for completed batches
ANTHROPIC_BATCH_FAILED = "failed"
ANTHROPIC_BATCH_CANCELLED = "cancelled"

TERMINAL_BATCH_STATES = [
    ANTHROPIC_BATCH_COMPLETED,
    ANTHROPIC_BATCH_ENDED,
    ANTHROPIC_BATCH_FAILED,
    ANTHROPIC_BATCH_CANCELLED,
]
NON_TERMINAL_BATCH_STATES = [ANTHROPIC_BATCH_PREPARING, ANTHROPIC_BATCH_IN_PROGRESS]

# Script Exit Codes (when --job-id is used)
EXIT_CODE_TERMINAL_STATE = 0  # Batch is done (completed/failed/cancelled), script handled it.
EXIT_CODE_SCRIPT_ERROR = 1  # The script itself had an issue processing the specified job.
EXIT_CODE_PROCESSING_CONTINUES = 3  # Batch is still processing, poller should wait and re-check.


class BatchStatusChecker:
    """Checks a single batch job's status and processes results if complete."""

    def __init__(self) -> None:
        """Initialize the checker."""
        raw_endpoint = os.environ.get("DYNAMODB_ENDPOINT")
        endpoint_url = raw_endpoint if raw_endpoint and raw_endpoint.strip() else None

        self.dynamodb = boto3.resource(
            "dynamodb",
            endpoint_url=endpoint_url,
            region_name=os.environ.get("AWS_REGION", "us-east-1"),
        )
        self.job_table = self.dynamodb.Table("Delphi_JobQueue")
        self.report_table = self.dynamodb.Table("Delphi_NarrativeReports")

        try:
            api_key = os.environ.get("ANTHROPIC_API_KEY")
            if not api_key:
                raise ValueError("ANTHROPIC_API_KEY is not set.")
            self.anthropic = Anthropic(api_key=api_key)
        except (ImportError, ValueError) as e:
            logger.error(f"Failed to initialize Anthropic client: {e}")
            self.anthropic = None

    async def check_and_process_job(self, job_id: str) -> int:  # noqa: PLR0911
        """
        Main logic: Fetches a job, checks its batch status, and processes if complete.
        Returns an exit code to the calling process.
        """
        if not self.anthropic:
            return EXIT_CODE_SCRIPT_ERROR

        try:
            # 1. Fetch the single job we are responsible for checking.
            response = self.job_table.get_item(Key={"job_id": job_id})
            job_item = response.get("Item")
            if not job_item:
                logger.error(f"Job {job_id} not found in DynamoDB.")
                return EXIT_CODE_SCRIPT_ERROR

            batch_id = job_item.get("batch_id")
            if not batch_id:
                logger.error(f"Job {job_id} is missing a 'batch_id'. Cannot check status.")
                self.job_table.update_item(
                    Key={"job_id": job_id},
                    UpdateExpression="SET #s = :s",
                    ExpressionAttributeNames={"#s": "status"},
                    ExpressionAttributeValues={":s": "FAILED"},
                )
                return EXIT_CODE_TERMINAL_STATE

            # 2. Check the status on the Anthropic API
            logger.info(f"Checking status for Anthropic batch {batch_id} (from job {job_id})...")
            batch = self.anthropic.beta.messages.batches.retrieve(batch_id)
            status = batch.processing_status
            logger.info(f"Anthropic API returned status '{status}' for batch {batch_id}.")

            # 3. Decide what to do based on the status
            if status in ["completed", "ended"]:
                await self.process_batch_results(job_item)
                return EXIT_CODE_TERMINAL_STATE

            elif status in ["failed", "cancelled"]:
                logger.error(f"Batch {batch_id} for job {job_id} is in a terminal failure state: {status}")
                self.job_table.update_item(
                    Key={"job_id": job_id},
                    UpdateExpression="SET #s = :s, error_message = :e",
                    ExpressionAttributeNames={"#s": "status"},
                    ExpressionAttributeValues={
                        ":s": "FAILED",
                        ":e": f"Batch status: {status}",
                    },
                )
                return EXIT_CODE_TERMINAL_STATE

            elif status in ["in_progress", "preparing"]:
                logger.info(f"Batch {batch_id} is still {status}. Will check again later.")
                return EXIT_CODE_PROCESSING_CONTINUES

            else:
                logger.error(f"Unrecognized batch status '{status}' for batch {batch_id}.")
                return EXIT_CODE_SCRIPT_ERROR

        except ClientError as e:
            if "ResourceNotFoundException" in str(e):
                logger.error(f"Job {job_id} not found in DynamoDB during processing.")
            else:
                logger.error(
                    f"A DynamoDB error occurred processing job {job_id}: {e}",
                    exc_info=True,
                )
            return EXIT_CODE_SCRIPT_ERROR
        except Exception as e:
            logger.error(f"A critical error occurred processing job {job_id}: {e}", exc_info=True)
            return EXIT_CODE_SCRIPT_ERROR

    async def process_batch_results(self, job_item: dict) -> bool:
        """Downloads, parses, and stores results for a completed batch job."""
        job_id = job_item.get("job_id", "unknown")
        batch_id = job_item.get("batch_id")
        report_id = job_item.get("report_id")

        if not all([job_id, batch_id, report_id, self.anthropic]):
            logger.error(
                f"Job {job_id}: Missing required info (job_id, batch_id, report_id, or client) for processing."
            )
            return False

        try:
            logger.info(f"Job {job_id}: Retrieving results for completed batch {batch_id}...")
            # Anthropic's SDK can stream results which is memory efficient
            results_stream = self.anthropic.beta.messages.batches.results(batch_id)

            processed_count = 0
            failed_count = 0

            for entry in results_stream:
                if entry.result.type == "succeeded":
                    custom_id = entry.custom_id
                    response_message = entry.result.message
                    model = response_message.model
                    content = response_message.content[0].text if response_message.content else "{}"

                    # Reconstruct the section name from the custom_id
                    parts = custom_id.split("_", 1)
                    if len(parts) < 2:
                        logger.error(f"Job {job_id}: Invalid custom_id format '{custom_id}'. Skipping result.")
                        failed_count += 1
                        continue
                    section_name = parts[1]

                    # Store the report
                    rid_section_model = f"{report_id}#{section_name}#{model}"
                    self.report_table.put_item(
                        Item={
                            "rid_section_model": rid_section_model,
                            "timestamp": datetime.now(UTC).isoformat(),
                            "report_id": report_id,
                            "section": section_name,
                            "model": model,
                            "report_data": content,
                            "job_id": job_id,
                            "batch_id": batch_id,
                        }
                    )
                    logger.info(f"Job {job_id}: Successfully stored report for section '{section_name}'.")
                    processed_count += 1

                elif entry.result.type == "failed":
                    failed_count += 1
                    logger.error(
                        f"Job {job_id}: A request in batch {batch_id} failed. Custom ID: {entry.custom_id}, Error: {entry.result.error}"
                    )

            # Finalize the job status
            final_status = "COMPLETED" if processed_count > 0 else "FAILED"
            update_expression = "SET #s = :status, completed_at = :time"
            expression_values = {
                ":status": final_status,
                ":time": datetime.now(UTC).isoformat(),
            }

            if failed_count > 0:
                update_expression += ", error_message = :error"
                expression_values[":error"] = (
                    f"{failed_count} of {failed_count + processed_count} batch requests failed."
                )

            self.job_table.update_item(
                Key={"job_id": job_id},
                UpdateExpression=update_expression,
                ExpressionAttributeNames={"#s": "status"},
                ExpressionAttributeValues=expression_values,
            )
            logger.info(
                f"Job {job_id}: Final status set to '{final_status}'. Processed: {processed_count}, Failed: {failed_count}."
            )

            return processed_count > 0

        except Exception as e:
            logger.error(
                f"Job {job_id}: A critical error occurred during result processing for batch {batch_id}: {e}",
                exc_info=True,
            )
            # Mark the job as FAILED
            self.job_table.update_item(
                Key={"job_id": job_id},
                UpdateExpression="SET #s = :s, error_message = :e",
                ExpressionAttributeNames={"#s": "status"},
                ExpressionAttributeValues={
                    ":s": "FAILED",
                    ":e": f"Result processing error: {str(e)}",
                },
            )
            return False

    async def check_and_process_jobs(self, specific_job_id: str | None = None) -> int | None:
        jobs_to_check = self.find_pending_jobs(specific_job_id)

        if not jobs_to_check:
            if specific_job_id:
                logger.error(f"Job {specific_job_id} not found or no longer in a processable state.")
                return self.EXIT_CODE_TERMINAL_STATE
            logger.info("No pending batch jobs found in this polling cycle.")
            return None

        for job_item in jobs_to_check:
            job_id = job_item.get("job_id")
            if not job_id:
                continue

            current_status = job_item.get("status")
            now_iso = datetime.now(UTC).isoformat()
            new_expiry_iso = (datetime.now(UTC) + timedelta(minutes=15)).isoformat()

            try:
                logger.info(f"Attempting to lock job {job_id} (current status: {current_status})...")
                condition_expr = "(#s = :processing_status) OR (#s = :locked_status AND lock_expires_at < :now)"
                self.job_table.update_item(
                    Key={"job_id": job_id},
                    UpdateExpression="SET #s = :new_locked_status, lock_expires_at = :new_expiry, last_checked = :now",
                    ConditionExpression=condition_expr,
                    ExpressionAttributeNames={"#s": "status"},
                    ExpressionAttributeValues={
                        ":processing_status": "PROCESSING",
                        ":locked_status": "LOCKED_FOR_CHECKING",
                        ":new_locked_status": "LOCKED_FOR_CHECKING",
                        ":now": now_iso,
                        ":new_expiry": new_expiry_iso,
                    },
                )
                logger.info(f"Successfully locked job {job_id}. Lock expires at {new_expiry_iso}.")

            except ClientError as e:
                if e.response["Error"]["Code"] == "ConditionalCheckFailedException":
                    logger.warning(f"Job {job_id} was locked or processed by another worker. Skipping.")
                    continue
                else:
                    logger.error(f"Error locking job {job_id}: {e}")
                    continue

            current_job_processing_signal = self.EXIT_CODE_SCRIPT_ERROR
            try:
                batch_api_status = await self.check_batch_status(job_item)

                if batch_api_status in [
                    ANTHROPIC_BATCH_COMPLETED,
                    ANTHROPIC_BATCH_ENDED,
                ]:
                    await self.process_batch_results(job_item)
                    current_job_processing_signal = self.EXIT_CODE_TERMINAL_STATE

                elif batch_api_status in [
                    ANTHROPIC_BATCH_FAILED,
                    ANTHROPIC_BATCH_CANCELLED,
                    "BATCH_NOT_FOUND",
                ]:
                    self.job_table.update_item(
                        Key={"job_id": job_id},
                        UpdateExpression="SET #s = :final_status, completed_at = :time, error_message = :error",
                        ExpressionAttributeNames={"#s": "status"},
                        ExpressionAttributeValues={
                            ":final_status": "FAILED",
                            ":time": now_iso,
                            ":error": f"Batch terminal status: {batch_api_status}",
                        },
                    )
                    current_job_processing_signal = self.EXIT_CODE_TERMINAL_STATE

                elif batch_api_status in NON_TERMINAL_BATCH_STATES:
                    logger.info(f"Job {job_id}: Batch still {batch_api_status}. Lock will time out if worker fails.")
                    current_job_processing_signal = self.EXIT_CODE_PROCESSING_CONTINUES

                else:
                    logger.error(f"Job {job_id}: Could not determine batch status. Lock will time out.")
                    current_job_processing_signal = self.EXIT_CODE_SCRIPT_ERROR

            except Exception as processing_error:
                logger.error(
                    f"Critical error processing locked job {job_id}: {processing_error}",
                    exc_info=True,
                )
                try:
                    self.job_table.update_item(
                        Key={"job_id": job_id},
                        UpdateExpression="SET #s = :s, error_message = :e",
                        ExpressionAttributeNames={"#s": "status"},
                        ExpressionAttributeValues={
                            ":s": "FAILED",
                            ":e": str(processing_error),
                        },
                    )
                except Exception as final_error:
                    logger.critical(f"FATAL: Could not mark job {job_id} as FAILED. It is now a zombie: {final_error}")
                current_job_processing_signal = self.EXIT_CODE_SCRIPT_ERROR

            if specific_job_id:
                return current_job_processing_signal

        return None


async def main() -> None:
    """Main entry point."""
    parser = argparse.ArgumentParser(description="Check a single Anthropic Batch Job status.")
    parser.add_argument(
        "--job-id",
        type=str,
        required=True,
        help="The main job ID (e.g., batch_report_...) to check.",
    )
    args = parser.parse_args()

    checker = BatchStatusChecker()
    exit_signal = await checker.check_and_process_job(args.job_id)

    logger.info(f"Script finished for job {args.job_id} with exit signal: {exit_signal}")
    sys.exit(exit_signal)


if __name__ == "__main__":
    asyncio.run(main())

if __name__ == "__main__":
    # Module-level constants are accessible here
    asyncio.run(main())
