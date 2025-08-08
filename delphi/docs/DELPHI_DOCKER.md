# Delphi Docker Container Guide

This document provides information about the Delphi Docker container setup and operation.

## Container Initialization

When the Delphi container starts, it performs the following steps:

1. Initializes DynamoDB tables using `create_dynamodb_tables.py`
2. Starts the job poller service using `start_poller.sh`

## Environment Variables

The following environment variables control the container's behavior:

- `DYNAMODB_ENDPOINT`: URL of the DynamoDB service (default: http://dynamodb:8000)
- `POLL_INTERVAL`: Polling interval in seconds for the job poller (default: 2)
- `LOG_LEVEL`: Logging level (default: INFO)
- `DATABASE_URL`: PostgreSQL database URL for math pipeline
- `DELPHI_DEV_OR_PROD`: Environment setting (dev/prod)

## Container Services

The Delphi container runs the following services:

1. **DynamoDB Integration**: Creates and maintains tables in DynamoDB for storing results
2. **Job Poller**: Continuously polls the DynamoDB job queue for new jobs
3. **Math Pipeline**: Processes conversations from PostgreSQL using the Python math pipeline

## Troubleshooting

If the container exits with code 127, check that:

1. The scripts directory is correctly copied into the container
2. The `start_poller.sh` script is executable
3. The DynamoDB endpoint is correct and accessible

## Maintaining State

The container stores results in DynamoDB, which persists its data to the `dynamodb-data` volume.