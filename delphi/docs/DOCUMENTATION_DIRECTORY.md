# Delphi Documentation Directory

This document provides an overview of key documentation files in the Delphi system, organized by topic for easy reference.

## Core System Documentation

| Document | Description |
|----------|-------------|
| [CLAUDE.md](../CLAUDE.md) | Main reference guide with configuration details, database interactions, and system operation |
| [README.md](../README.md) | Project overview and basic setup instructions |
| [QUICK_START.md](QUICK_START.md) | Get started quickly with the Delphi system |
| [RUNNING_THE_SYSTEM.md](RUNNING_THE_SYSTEM.md) | Step-by-step instructions for operating the Delphi system |
| [architecture_overview.md](architecture_overview.md) | High-level overview of the system architecture |
| [project_structure.md](project_structure.md) | Explanation of the project's directory and file organization |

## Database and Data Format Documentation

| Document | Description |
|----------|-------------|
| [DATABASE_NAMING_PROPOSAL.md](DATABASE_NAMING_PROPOSAL.md) | Explanation of table naming conventions and migration plan |
| [DATA_FORMAT_STANDARDS.md](DATA_FORMAT_STANDARDS.md) | **Critical standards for data formats throughout the system, including DynamoDB key formats** |
| [JOB_QUEUE_SCHEMA.md](JOB_QUEUE_SCHEMA.md) | Schema documentation for the job queue system |
| [S3_STORAGE.md](S3_STORAGE.md) | Information about S3 storage configuration and access |

## Job System Documentation

| Document | Description |
|----------|-------------|
| [JOB_SYSTEM_DESIGN.md](JOB_SYSTEM_DESIGN.md) | Overall job system architecture and design principles |
| [JOB_STATE_MACHINE_DESIGN.md](JOB_STATE_MACHINE_DESIGN.md) | **Detailed explanation of the job state machine and workflow design** |
| [DELPHI_JOB_SYSTEM_TROUBLESHOOTING.md](DELPHI_JOB_SYSTEM_TROUBLESHOOTING.md) | **Comprehensive guide to troubleshooting common job system issues** |
| [JOB_ID_MIGRATION_PLAN.md](JOB_ID_MIGRATION_PLAN.md) | Plan for migrating to the new job ID system |

## API Integration Documentation

| Document | Description |
|----------|-------------|
| [ANTHROPIC_BATCH_API_GUIDE.md](ANTHROPIC_BATCH_API_GUIDE.md) | **Complete guide for working with Anthropic's Batch API, including common issues and solutions** |
| [OLLAMA_MODEL_CONFIG.md](OLLAMA_MODEL_CONFIG.md) | Configuration guide for Ollama models |
| [CLI_STATUS_COMMAND.md](CLI_STATUS_COMMAND.md) | Documentation for the CLI status command |

## Deployment and Infrastructure

| Document | Description |
|----------|-------------|
| [DELPHI_AUTOSCALING_SETUP.md](DELPHI_AUTOSCALING_SETUP.md) | Configuration for auto-scaling the system |
| [DISTRIBUTED_SYSTEM_ROADMAP.md](DISTRIBUTED_SYSTEM_ROADMAP.md) | Roadmap for distributed system improvements |

## Algorithm and Analysis Documentation

| Document | Description |
|----------|-------------|
| [algorithm_analysis.md](algorithm_analysis.md) | Analysis of the core algorithms used in Delphi |
| [TOPIC_NAMING.md](TOPIC_NAMING.md) | Topic naming pipeline: exact prompt, deterministic 5‑comment sampling, logging, storage |
| [usage_examples.md](usage_examples.md) | Examples of system usage and output interpretations |

## Testing and Development

| Document | Description |
|----------|-------------|
| [SIMPLIFIED_TESTS.md](SIMPLIFIED_TESTS.md) | Simplified testing procedures |
| [TESTING_LOG.md](TESTING_LOG.md) | Log of testing activities and results |
| [TEST_RESULTS_SUMMARY.md](TEST_RESULTS_SUMMARY.md) | Summary of test results |

## Recently Added Documentation

The following documentation was recently added to address specific system challenges:

1. **[ANTHROPIC_BATCH_API_GUIDE.md](ANTHROPIC_BATCH_API_GUIDE.md)** - Comprehensive guide for working with Anthropic's Batch API in the Delphi system, including:
   - Handling JSON Lines (JSONL) responses from the API
   - Proper error handling for API interactions
   - Key format requirements for storing results in DynamoDB
   - Debugging strategies for batch processing issues

2. **[DELPHI_JOB_SYSTEM_TROUBLESHOOTING.md](DELPHI_JOB_SYSTEM_TROUBLESHOOTING.md)** - Detailed guide for troubleshooting job system issues, including:
   - Strategies for diagnosing stuck jobs
   - Solutions for common DynamoDB reserved keyword issues
   - Techniques for tracing end-to-end job execution
   - Database verification processes

3. **[DATA_FORMAT_STANDARDS.md](DATA_FORMAT_STANDARDS.md)** - Critical standards document focusing on:
   - Required format for DynamoDB keys (using # as delimiters)
   - JSON structure standards for reports
   - Handling of reserved keywords in DynamoDB
   - Conversion between PostgreSQL and DynamoDB data types

4. **[JOB_STATE_MACHINE_DESIGN.md](JOB_STATE_MACHINE_DESIGN.md)** - Documentation of the state machine design for job processing:
   - Explicit job types for different processing stages
   - Clear script mapping between job types and processing scripts
   - Clean state transition patterns
   - Error handling best practices