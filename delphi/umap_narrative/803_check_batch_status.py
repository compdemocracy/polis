#!/usr/bin/env python3
"""
Check and process Anthropic Batch API results for a specific job.

This script is a simple worker that is called by the job_poller. It does not
contain any job-finding or locking logic itself. It expects to be given a
single job ID to process.

Usage:
    python 803_check_batch_status.py --job-id JOB_ID
"""

import os, sys, json, boto3, logging, argparse, asyncio
from typing import Dict, Optional
from datetime import datetime, timedelta, timezone
from botocore.exceptions import ClientError

sys.path.append(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from umap_narrative.llm_factory_constructor.model_provider import _narrative_error_json

# Configure logging
logging.basicConfig(level=logging.INFO, format='%(asctime)s - %(levelname)s - %(message)s')
logger = logging.getLogger(__name__)

# Anthropic Batch API Statuses
ANTHROPIC_BATCH_PREPARING = "preparing"
ANTHROPIC_BATCH_IN_PROGRESS = "in_progress"
ANTHROPIC_BATCH_COMPLETED = "completed"
ANTHROPIC_BATCH_ENDED = "ended"  # Anthropic API returns "ended" for completed batches
ANTHROPIC_BATCH_FAILED = "failed"
ANTHROPIC_BATCH_CANCELLED = "cancelled"

TERMINAL_BATCH_STATES = [ANTHROPIC_BATCH_COMPLETED, ANTHROPIC_BATCH_ENDED, ANTHROPIC_BATCH_FAILED, ANTHROPIC_BATCH_CANCELLED]
NON_TERMINAL_BATCH_STATES = [ANTHROPIC_BATCH_PREPARING, ANTHROPIC_BATCH_IN_PROGRESS]

# Script Exit Codes (when --job-id is used)
EXIT_CODE_TERMINAL_STATE = 0      # Batch is done (completed/failed/cancelled), script handled it.
EXIT_CODE_SCRIPT_ERROR = 1        # The script itself had an issue processing the specified job.
EXIT_CODE_PROCESSING_CONTINUES = 3 # Batch is still processing, poller should wait and re-check.

class BatchStatusChecker:
    """Checks a single batch job's status and processes results if complete."""

    def __init__(self):
        """Initialize the checker."""
        raw_endpoint = os.environ.get('DYNAMODB_ENDPOINT')
        endpoint_url = raw_endpoint if raw_endpoint and raw_endpoint.strip() else None
        
        self.dynamodb = boto3.resource('dynamodb', endpoint_url=endpoint_url, region_name=os.environ.get('AWS_REGION', 'us-east-1'))
        self.job_table = self.dynamodb.Table('Delphi_JobQueue')
        self.report_table = self.dynamodb.Table('Delphi_NarrativeReports')
        # Provider token usage summed over the stored results, only when the
        # polis-jobs daemon runs this script (count_usage); the legacy run is unchanged.
        self.count_usage = False
        self.tokens_in = 0
        self.tokens_out = 0

        try:
            from anthropic import Anthropic
            api_key = os.environ.get("ANTHROPIC_API_KEY")
            if not api_key: raise ValueError("ANTHROPIC_API_KEY is not set.")
            self.anthropic = Anthropic(api_key=api_key)
        except (ImportError, ValueError) as e:
            logger.error(f"Failed to initialize Anthropic client: {e}")
            self.anthropic = None

    async def check_and_process_job(self, job_id: str) -> int:
        """
        Main logic: Fetches a job, checks its batch status, and processes if complete.
        Returns an exit code to the calling process.
        """
        if not self.anthropic:
            return EXIT_CODE_SCRIPT_ERROR

        try:
            # 1. Fetch the single job we are responsible for checking.
            response = self.job_table.get_item(Key={'job_id': job_id})
            job_item = response.get('Item')
            if not job_item:
                logger.error(f"Job {job_id} not found in DynamoDB.")
                return EXIT_CODE_SCRIPT_ERROR

            batch_id = job_item.get('batch_id')
            if not batch_id:
                logger.error(f"Job {job_id} is missing a 'batch_id'. Cannot check status.")
                self.job_table.update_item(Key={'job_id': job_id}, UpdateExpression="SET #s = :s, process_exit_confirmed = :confirmed", ExpressionAttributeNames={'#s':'status'}, ExpressionAttributeValues={':s':'FAILED', ':confirmed': True})
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
                self.job_table.update_item(Key={'job_id': job_id}, UpdateExpression="SET #s = :s, error_message = :e, process_exit_confirmed = :confirmed", ExpressionAttributeNames={'#s':'status'}, ExpressionAttributeValues={':s':'FAILED', ':e': f'Batch status: {status}', ':confirmed': True})
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
                logger.error(f"A DynamoDB error occurred processing job {job_id}: {e}", exc_info=True)
            return EXIT_CODE_SCRIPT_ERROR
        except Exception as e:
            logger.error(f"A critical error occurred processing job {job_id}: {e}", exc_info=True)
            return EXIT_CODE_SCRIPT_ERROR

    async def process_batch_results(self, job_item: Dict) -> bool:
        """Downloads, parses, and stores results for a completed batch job."""
        job_id = job_item.get('job_id', 'unknown')
        batch_id = job_item.get('batch_id')
        report_id = job_item.get('report_id')

        if not all([job_id, batch_id, report_id, self.anthropic]):
            logger.error(f"Job {job_id}: Missing required info (job_id, batch_id, report_id, or client) for processing.")
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
                    usage = getattr(response_message, "usage", None) if self.count_usage else None
                    if usage is not None:
                        self.tokens_in += int(getattr(usage, "input_tokens", 0) or 0)
                        self.tokens_out += int(getattr(usage, "output_tokens", 0) or 0)
                    if response_message.stop_reason == "max_tokens":
                        logger.warning(
                            f"Job {job_id}: response for {custom_id} was truncated by max_tokens; "
                            "output may be incomplete/invalid JSON."
                        )

                    if response_message.stop_reason == "refusal":
                        # Batch API refusals still report result.type == "succeeded" — stop_details
                        # may be null on batch results, so branch on stop_reason alone.
                        # Server-side fallback isn't available on the Batch API, so this can't be
                        # auto-recovered here; it needs a separate non-batch retry (which does
                        # support fallback for claude-fable-5).
                        logger.warning(
                            f"Job {job_id}: model {model} declined request for {custom_id} "
                            "(stop_reason=refusal)."
                        )
                        content = _narrative_error_json(
                            "Model Declined Request",
                            "This section could not be generated because the request was declined "
                            "by the model's safety classifier. Try regenerating, or switch to a "
                            "different model."
                        )
                    else:
                        text_block = next((b for b in response_message.content if b.type == "text"), None)
                        content = text_block.text if text_block else "{}"

                    # Reconstruct the section name from the custom_id
                    parts = custom_id.split('_', 1)
                    if len(parts) < 2:
                        logger.error(f"Job {job_id}: Invalid custom_id format '{custom_id}'. Skipping result.")
                        failed_count += 1
                        continue
                    section_name = parts[1]

                    # Store the report
                    rid_section_model = f"{report_id}#{section_name}#{model}"
                    self.report_table.put_item(Item={
                        'rid_section_model': rid_section_model,
                        'timestamp': datetime.now(timezone.utc).isoformat(),
                        'report_id': report_id,
                        'section': section_name,
                        'model': model,
                        'report_data': content,
                        'job_id': job_id,
                        'batch_id': batch_id,
                    })
                    logger.info(f"Job {job_id}: Successfully stored report for section '{section_name}'.")
                    processed_count += 1

                elif entry.result.type == "failed":
                    failed_count += 1
                    logger.error(f"Job {job_id}: A request in batch {batch_id} failed. Custom ID: {entry.custom_id}, Error: {entry.result.error}")

            # Finalize the job status
            final_status = 'COMPLETED' if processed_count > 0 else 'FAILED'
            update_expression = "SET #s = :status, completed_at = :time"
            expression_values = {':status': final_status, ':time': datetime.now(timezone.utc).isoformat()}
            
            if failed_count > 0:
                update_expression += ", error_message = :error"
                expression_values[':error'] = f"{failed_count} of {failed_count + processed_count} batch requests failed."

            # This script is the process doing the work, so its own terminal
            # write can carry the exit claim the server's guard checks.
            update_expression += ", process_exit_confirmed = :confirmed"
            expression_values[':confirmed'] = True
            self.job_table.update_item(
                Key={'job_id': job_id},
                UpdateExpression=update_expression,
                ExpressionAttributeNames={'#s': 'status'},
                ExpressionAttributeValues=expression_values
            )
            logger.info(f"Job {job_id}: Final status set to '{final_status}'. Processed: {processed_count}, Failed: {failed_count}.")
            
            return processed_count > 0
        
        except Exception as e:
            logger.error(f"Job {job_id}: A critical error occurred during result processing for batch {batch_id}: {e}", exc_info=True)
            # Mark the job as FAILED
            self.job_table.update_item(Key={'job_id': job_id}, UpdateExpression="SET #s = :s, error_message = :e, process_exit_confirmed = :confirmed", ExpressionAttributeNames={'#s':'status'}, ExpressionAttributeValues={':s':'FAILED', ':e': f"Result processing error: {str(e)}", ':confirmed': True})
            return False

    async def check_and_process_jobs(self, specific_job_id: Optional[str] = None) -> Optional[int]:
        jobs_to_check = self.find_pending_jobs(specific_job_id)

        if not jobs_to_check:
            if specific_job_id:
                logger.error(f"Job {specific_job_id} not found or no longer in a processable state.")
                return self.EXIT_CODE_TERMINAL_STATE
            logger.info("No pending batch jobs found in this polling cycle.")
            return None

        for job_item in jobs_to_check:
            job_id = job_item.get('job_id')
            if not job_id: continue

            current_status = job_item.get('status')
            now_iso = datetime.now(timezone.utc).isoformat()
            new_expiry_iso = (datetime.now(timezone.utc) + timedelta(minutes=15)).isoformat()

            try:
                logger.info(f"Attempting to lock job {job_id} (current status: {current_status})...")
                condition_expr = "(#s = :processing_status) OR (#s = :locked_status AND lock_expires_at < :now)"
                self.job_table.update_item(
                    Key={'job_id': job_id},
                    UpdateExpression="SET #s = :new_locked_status, lock_expires_at = :new_expiry, last_checked = :now",
                    ConditionExpression=condition_expr,
                    ExpressionAttributeNames={'#s': 'status'},
                    ExpressionAttributeValues={
                        ':processing_status': 'PROCESSING',
                        ':locked_status': 'LOCKED_FOR_CHECKING',
                        ':new_locked_status': 'LOCKED_FOR_CHECKING',
                        ':now': now_iso,
                        ':new_expiry': new_expiry_iso
                    }
                )
                logger.info(f"Successfully locked job {job_id}. Lock expires at {new_expiry_iso}.")
            
            except ClientError as e:
                if e.response['Error']['Code'] == 'ConditionalCheckFailedException':
                    logger.warning(f"Job {job_id} was locked or processed by another worker. Skipping.")
                    continue
                else:
                    logger.error(f"Error locking job {job_id}: {e}")
                    continue

            current_job_processing_signal = self.EXIT_CODE_SCRIPT_ERROR
            try:
                batch_api_status = await self.check_batch_status(job_item)

                if batch_api_status in [ANTHROPIC_BATCH_COMPLETED, ANTHROPIC_BATCH_ENDED]:
                    await self.process_batch_results(job_item)
                    current_job_processing_signal = self.EXIT_CODE_TERMINAL_STATE
                
                elif batch_api_status in [ANTHROPIC_BATCH_FAILED, ANTHROPIC_BATCH_CANCELLED, "BATCH_NOT_FOUND"]:
                    self.job_table.update_item(
                        Key={'job_id': job_id},
                        UpdateExpression="SET #s = :final_status, completed_at = :time, error_message = :error",
                        ExpressionAttributeNames={'#s': 'status'},
                        ExpressionAttributeValues={
                            ':final_status': 'FAILED',
                            ':time': now_iso,
                            ':error': f"Batch terminal status: {batch_api_status}"
                        }
                    )
                    current_job_processing_signal = self.EXIT_CODE_TERMINAL_STATE

                elif batch_api_status in NON_TERMINAL_BATCH_STATES:
                    logger.info(f"Job {job_id}: Batch still {batch_api_status}. Lock will time out if worker fails.")
                    current_job_processing_signal = self.EXIT_CODE_PROCESSING_CONTINUES

                else:
                    logger.error(f"Job {job_id}: Could not determine batch status. Lock will time out.")
                    current_job_processing_signal = self.EXIT_CODE_SCRIPT_ERROR
            
            except Exception as processing_error:
                logger.error(f"Critical error processing locked job {job_id}: {processing_error}", exc_info=True)
                try:
                    self.job_table.update_item(Key={'job_id': job_id}, UpdateExpression="SET #s = :s, error_message = :e, process_exit_confirmed = :confirmed", ExpressionAttributeNames={'#s':'status'}, ExpressionAttributeValues={':s':'FAILED', ':e': str(processing_error), ':confirmed': True})
                except Exception as final_error:
                    logger.critical(f"FATAL: Could not mark job {job_id} as FAILED. It is now a zombie: {final_error}")
                current_job_processing_signal = self.EXIT_CODE_SCRIPT_ERROR

            if specific_job_id:
                return current_job_processing_signal
        
        return None

# --- run by the polis-jobs daemon (P-077 P1) --------------------------------
# The recheck is the same logical job as the submit, parked and reclaimed. The
# batch id and report id come from the daemon's frame; the queue row lives in
# Postgres, so nothing here writes Delphi_JobQueue. Active only when
# DELPHI_OUTPUT_MANIFEST is set; the legacy poller never sets it.

class _NoQueueWrites:
    """Stands in for Delphi_JobQueue in daemon mode: the daemon owns the job's state."""

    def update_item(self, **kwargs):
        return {}

    def put_item(self, **kwargs):
        return {}


class _RecordingTable:
    """Passes writes through to Delphi_NarrativeReports and keeps each written item's key."""

    def __init__(self, table):
        self._table = table
        self.keys = []

    def put_item(self, Item, **kwargs):
        response = self._table.put_item(Item=Item, **kwargs)
        self.keys.append({"rid_section_model": str(Item["rid_section_model"]), "timestamp": str(Item["timestamp"])})
        return response


def _iso(value):
    if value is None:
        return None
    if isinstance(value, datetime):
        if value.tzinfo is None:
            value = value.replace(tzinfo=timezone.utc)
        return value.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.%fZ")
    return str(value) or None


async def run_daemon_recheck(cli_job_id: str, checker_factory=None) -> int:
    """Check the job's provider batch; store results and write the manifest. Returns the exit code."""
    from polismath import job_child

    try:
        job = job_child.JobContext.from_env(
            expected_stage=job_child.STAGE_NARRATIVE, zid=None,
            allowed_phases={job_child.PHASE_RECHECK}, default_phase=job_child.PHASE_RECHECK,
        )
    except job_child.JobEnvError as e:
        job_child.refuse(str(e))
    if cli_job_id != job.job_id:
        job_child.refuse("--job-id does not match DELPHI_JOB_ID")
    batch_id = job.provider_batch_id
    report_id = job.report_id or os.environ.get('DELPHI_REPORT_ID')
    if not batch_id:
        job_child.refuse("the frame names no provider batch_id to recheck")
    if not report_id:
        job_child.refuse("the frame names no report_id")

    checker = (checker_factory or BatchStatusChecker)()
    if not checker.anthropic:
        return job_child.EXIT_STAGE_FAILED
    checker.job_table = _NoQueueWrites()
    checker.count_usage = True
    recorder = _RecordingTable(checker.report_table)
    checker.report_table = recorder

    try:
        batch = checker.anthropic.beta.messages.batches.retrieve(batch_id)
        status = batch.processing_status
        logger.info(f"Anthropic API returned status '{status}' for batch {batch_id}.")
        submitted_at = _iso(getattr(batch, "created_at", None))
        provider_batches = ([{"provider": "anthropic", "batch_id": str(batch_id), "submitted_at": submitted_at}]
                            if submitted_at else None)
        model = (job.frame.get("config") or {}).get("model") or os.environ.get("ANTHROPIC_MODEL") or None

        if status in ("in_progress", "preparing"):
            recheck_seconds = int(os.environ.get("DELPHI_RECHECK_SECONDS", "300"))
            manifest = job_child.build_manifest(
                job, outcome="parked", inputs=job_child.empty_inputs(), outputs=[],
                models={"embed": None, "topic": None, "narrative": model},
                cost={"llm_tokens_in": None, "llm_tokens_out": None, "provider_batches": provider_batches},
                recheck_after=_iso(datetime.now(timezone.utc) + timedelta(seconds=recheck_seconds)),
            )
        elif status in ("completed", "ended"):
            ok = await checker.process_batch_results({'job_id': job.job_id, 'batch_id': batch_id, 'report_id': report_id})
            if not ok:
                logger.error(f"Batch {batch_id}: no result could be stored.")
                return job_child.EXIT_STAGE_FAILED
            keys = sorted(recorder.keys, key=lambda k: (k["rid_section_model"], k["timestamp"]))
            manifest = job_child.build_manifest(
                job, outcome="succeeded", inputs=job_child.empty_inputs(),
                outputs=[{"store": "dynamodb", "family": "Delphi_NarrativeReports",
                          "table": "Delphi_NarrativeReports", "keys": keys, "rows": len(keys)}],
                models={"embed": None, "topic": None, "narrative": model},
                cost={"llm_tokens_in": checker.tokens_in, "llm_tokens_out": checker.tokens_out,
                      "provider_batches": provider_batches},
            )
        else:
            logger.error(f"Batch {batch_id} ended in state '{status}'.")
            return job_child.EXIT_STAGE_FAILED
    except job_child.ManifestError as e:
        print(f"polis-jobs child: the manifest could not be built: {e}", file=sys.stderr, flush=True)
        return job_child.EXIT_MANIFEST_UNBUILDABLE
    except Exception as e:
        logger.error(f"Recheck of batch {batch_id} failed: {e}", exc_info=True)
        return job_child.EXIT_STAGE_FAILED

    try:
        job_child.write_manifest(job, manifest)
    except (job_child.ManifestError, OSError) as e:
        print(f"polis-jobs child: the manifest could not be written: {e}", file=sys.stderr, flush=True)
        return job_child.EXIT_MANIFEST_UNBUILDABLE
    return job_child.EXIT_OK


async def main():
    """Main entry point."""
    parser = argparse.ArgumentParser(description='Check a single Anthropic Batch Job status.')
    parser.add_argument('--job-id', type=str, required=True, help='The main job ID (e.g., batch_report_...) to check.')
    args = parser.parse_args()

    if os.environ.get("DELPHI_OUTPUT_MANIFEST", "").strip():
        sys.exit(await run_daemon_recheck(args.job_id))

    checker = BatchStatusChecker()
    exit_signal = await checker.check_and_process_job(args.job_id)
    
    logger.info(f"Script finished for job {args.job_id} with exit signal: {exit_signal}")
    sys.exit(exit_signal)

if __name__ == "__main__":
    asyncio.run(main())

if __name__ == "__main__":
    # Module-level constants are accessible here
    asyncio.run(main())