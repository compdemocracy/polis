# Polis Comment Graph Lambda Transformation Workplan

This document outlines the changes made to transform the polismath_commentgraph microservice into a Lambda-based service that interacts with PostgreSQL and stores results in DynamoDB.

## Completed Changes

1. **Removed API Layer**
   - Removed the `/api` directory and all FastAPI-based components
   - Replaced with Lambda handler for serverless architecture

2. **Added PostgreSQL Integration**
   - Created `PostgresClient` class for direct database access
   - Implemented methods to query comments, votes, and participants
   - Added support for both RDS and local PostgreSQL for development

3. **Created Lambda Handler**
   - Implemented `lambda_handler.py` for AWS Lambda function
   - Supports two event types:
     - `process_conversation`: Process entire conversation
     - `process_comment`: Process a single new comment

4. **Enhanced Storage Layer**
   - Extended `DynamoDBStorage` class with additional methods
   - Optimized batch operations for large dataset handling
   - Maintained compatibility with existing DynamoDB schema

5. **Updated CLI Interface**
   - Added `test-postgres` command for database testing
   - Added `lambda-local` command to simulate Lambda execution locally
   - Retained `test-evoc` command for EVōC integration testing

6. **Updated Dockerfile**
   - Changed base image to Lambda Python runtime
   - Configured for AWS Lambda container deployment
   - Set up proper environment variables and permissions

7. **Updated Documentation**
   - Rewrote `README.md` with Lambda-specific information
   - Created detailed `DEPLOYMENT.md` with AWS deployment instructions
   - Added documentation for PostgreSQL integration

## Architecture Changes

### Before

- FastAPI microservice running on containers
- File-based input from `/polis_data` directory
- Limited error handling and no direct database access

### After

- AWS Lambda function triggered by events
- Direct PostgreSQL integration with RDS
- Extended error handling and monitoring
- Serverless architecture for better scalability

## Data Flow

1. Event triggers Lambda function (SNS, SQS, or API Gateway)
2. Lambda reads comments from PostgreSQL
3. EVōC processes comments and generates clusters
4. Results are stored in DynamoDB
5. Status is returned to caller

## Database Schema

- PostgreSQL: Using existing Polis schema (conversations, comments, participants, votes)
- DynamoDB: Using optimized schema for visualization and clustering

## Next Steps

1. **Testing**
   - Test with real PostgreSQL data
   - Verify performance with large datasets
   - Ensure error handling works correctly

2. **Deployment**
   - Deploy to AWS Lambda
   - Set up event triggers
   - Configure monitoring and alerts

3. **Integration**
   - Connect with Polis front-end
   - Test end-to-end workflow
   - Implement automated testing
