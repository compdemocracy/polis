# Batch Narrative Report Generation

This document describes the Anthropic Batch API integration for generating narrative reports in the Delphi system.

## Overview

The Anthropic Batch API allows for efficient processing of multiple LLM requests in a single API call. This is particularly useful for generating topic-based narrative reports in Polis conversations, where there might be dozens of topics to process.

## Components

The batch narrative report generation system consists of three main scripts:

1. `801_narrative_report_batch.py` - Prepares and submits batch requests
2. `802_process_batch_results.py` - Processes batch results and stores them
3. `803_check_batch_status.py` - Monitors batch job status

## Prerequisites

- Anthropic API key (set in the `ANTHROPIC_API_KEY` environment variable)
- DynamoDB tables:
  - `Delphi_BatchJobs` - Stores batch job metadata
  - `Delphi_NarrativeReports` - Stores generated reports
  - `Delphi_CommentHierarchicalClusterAssignments` - Contains topic assignment data
  - `Delphi_CommentClustersLLMTopicNames` - Contains topic names

## Usage

### 1. Submitting a Batch Job

To submit a batch job for a conversation, use the `801_narrative_report_batch.py` script:

```bash
python 801_narrative_report_batch.py --conversation_id CONVERSATION_ID [--model MODEL] [--no-cache] [--max-batch-size MAX_BATCH_SIZE]
```

Arguments:
- `--conversation_id` or `--zid`: Conversation ID to process
- `--model`: LLM model to use (default: claude-3-5-sonnet-20241022)
- `--no-cache`: Ignore cached report data
- `--max-batch-size`: Maximum number of topics in a batch (default: 20)

This will:
1. Extract topics for the conversation from DynamoDB
2. Prepare batch requests with appropriate prompts
3. Submit the batch to Anthropic's Batch API
4. Store batch job metadata in DynamoDB

If the Batch API is not available, it will fall back to sequential processing.

### 2. Checking Batch Status

To check the status of a batch job, use the `803_check_batch_status.py` script:

```bash
python 803_check_batch_status.py --batch_id BATCH_ID [--watch]
python 803_check_batch_status.py --conversation_id CONVERSATION_ID
```

Arguments:
- `--batch_id`: ID of a specific batch job to check
- `--conversation_id` or `--zid`: ID of a conversation to show all batch jobs for
- `--watch`: Continuously monitor the batch job (poll every 30 seconds)

This will display:
- Batch job metadata
- Current status and progress
- Request statuses from the Anthropic Batch API

### 3. Processing Batch Results

To process batch results and store them in the report database, use the `802_process_batch_results.py` script:

```bash
python 802_process_batch_results.py --batch_id BATCH_ID [--force]
```

Arguments:
- `--batch_id`: ID of the batch job to process
- `--force`: Force processing even if the job is not marked as completed

This will:
1. Retrieve batch job metadata from DynamoDB
2. Check the status of the Anthropic batch job
3. Process completed requests and store results in `Delphi_NarrativeReports`
4. Handle sequential fallback processing when batch API is unavailable

## Workflow

The typical workflow is:

1. Submit a batch job:
   ```bash
   python 801_narrative_report_batch.py --conversation_id 12345
   ```

2. Monitor the batch job status:
   ```bash
   python 803_check_batch_status.py --batch_id batch_12345_1620000000_abcd1234 --watch
   ```

3. Process the batch results when complete:
   ```bash
   python 802_process_batch_results.py --batch_id batch_12345_1620000000_abcd1234
   ```

## DynamoDB Schema

### Delphi_BatchJobs

This table stores metadata about batch jobs:

- `batch_id` (Hash Key): Unique identifier for the batch job
- `conversation_id`: Conversation ID
- `model`: LLM model used
- `status`: Current status of the batch job (prepared, submitting, submitted, completed, error, sequential_fallback, etc.)
- `created_at`: Timestamp when the batch job was created
- `updated_at`: Timestamp when the batch job was last updated
- `total_requests`: Total number of requests in the batch
- `completed_requests`: Number of completed requests
- `request_map`: Mapping of request IDs to topic metadata
- `anthropic_batch_id`: Anthropic's batch job ID (if available)
- `batch_data`: Original batch request data
- `anthropic_status`: Status from Anthropic Batch API (if available)
- `processing_completed`: Whether result processing is complete
- `processing_timestamp`: When results were processed

### Delphi_NarrativeReports

This table stores the generated reports:

- `rid_section_model` (Hash Key): Combined key of report ID, section, and model
- `timestamp` (Range Key): Timestamp when the report was created
- `report_data`: The generated report content
- `model`: LLM model used
- `errors`: Any errors encountered
- `batch_id`: ID of the batch job that generated this report
- `request_id`: ID of the specific request within the batch

## Fallback Mechanism

If the Anthropic Batch API is not available (returns a 404 error), the system will automatically:

1. Mark the batch job as `sequential_fallback`
2. Store the batch request data for later processing
3. When `802_process_batch_results.py` is run, it will process the requests sequentially

## Error Handling

The system includes several error handling mechanisms:

- Retries for HTTP errors
- Fallback to sequential processing
- Detailed error logging
- Storing error information in DynamoDB
- Partial processing (continue even if some requests fail)

## Performance Considerations

- The Anthropic Batch API is significantly faster than sequential processing for large numbers of topics
- Batch size is limited to 20 requests by default to avoid API limitations
- Sequential processing adds a 1-second delay between requests to avoid rate limiting

## Integration with Existing Systems

The batch narrative report generation system is integrated with the existing Delphi system:

- Uses the same DynamoDB tables for storing reports
- Compatible with the same JSON report format
- Can be triggered from the same API endpoints