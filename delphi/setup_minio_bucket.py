#!/usr/bin/env python3
"""
This script creates the required MinIO bucket for Delphi visualizations.
Run this script after starting the MinIO container to ensure the bucket exists.
"""

import os
import sys
import logging
import boto3
from botocore.exceptions import ClientError

# Configure logging
logging.basicConfig(
    level=logging.INFO, format="%(asctime)s - %(levelname)s - %(message)s"
)
logger = logging.getLogger(__name__)


def setup_minio_bucket():
    """Create the MinIO bucket for storing Delphi visualizations"""

    # Get S3 settings from environment or use defaults
    endpoint_url = os.environ.get("AWS_S3_ENDPOINT", "http://host.docker.internal:9000")
    access_key = os.environ.get("AWS_ACCESS_KEY_ID", "minioadmin")
    secret_key = os.environ.get("AWS_SECRET_ACCESS_KEY", "minioadmin")
    bucket_name = os.environ.get("AWS_S3_BUCKET_NAME", "delphi")
    region = os.environ.get("AWS_REGION", "us-east-1")

    logger.info(f"S3 settings:")
    logger.info(f"  Endpoint: {endpoint_url}")
    logger.info(f"  Bucket: {bucket_name}")
    logger.info(f"  Region: {region}")

    try:
        # Create S3 client
        s3_client = boto3.client(
            "s3",
            endpoint_url=endpoint_url,
            aws_access_key_id=access_key,
            aws_secret_access_key=secret_key,
            region_name=region,
            # For MinIO/local development, these settings help
            config=boto3.session.Config(signature_version="s3v4"),
            verify=False,
        )

        # Check if bucket exists
        try:
            s3_client.head_bucket(Bucket=bucket_name)
            logger.info(f"Bucket '{bucket_name}' already exists")
        except ClientError as e:
            error_code = e.response.get("Error", {}).get("Code")

            # If bucket doesn't exist (404) or we're not allowed to access it (403)
            if error_code == "404" or error_code == "403":
                logger.info(f"Creating bucket '{bucket_name}'...")
                # Create bucket
                if region == "us-east-1":
                    # us-east-1 is the default and requires a different syntax
                    s3_client.create_bucket(Bucket=bucket_name)
                else:
                    s3_client.create_bucket(
                        Bucket=bucket_name,
                        CreateBucketConfiguration={"LocationConstraint": region},
                    )
                logger.info(f"Bucket '{bucket_name}' created successfully")
            else:
                logger.error(f"Error checking bucket: {e}")
                return False

        # Set up bucket policy for public access if needed
        # For this use case, we'll leave the bucket private

        # Upload a test file to verify bucket is working
        test_file_path = os.path.join(
            os.path.dirname(__file__), "setup_minio_bucket.py"
        )
        test_key = "test/setup_script.py"

        logger.info(f"Uploading test file to verify bucket...")
        s3_client.upload_file(
            test_file_path,
            bucket_name,
            test_key,
            ExtraArgs={"ContentType": "text/plain"},
        )

        logger.info(f"Test file uploaded successfully to s3://{bucket_name}/{test_key}")

        return True
    except Exception as e:
        logger.error(f"Error setting up MinIO bucket: {e}")
        import traceback

        logger.error(traceback.format_exc())
        return False


if __name__ == "__main__":
    logger.info("Setting up MinIO bucket for Delphi visualizations")
    if setup_minio_bucket():
        logger.info("✅ MinIO bucket setup completed successfully")
        sys.exit(0)
    else:
        logger.error("❌ MinIO bucket setup failed")
        sys.exit(1)
