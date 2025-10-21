#!/usr/bin/env python3
"""
Script to set up MinIO bucket with public-read access.

Usage:
  python setup_minio.py [bucket_name]

The bucket_name is optional - if not provided, the script will use AWS_S3_BUCKET_NAME from the environment,
or default to 'delphi'.
"""

import os
import json
import sys
import boto3
import logging

# Configure logging
logging.basicConfig(
    level=logging.INFO, format="%(asctime)s - %(levelname)s - %(message)s"
)
logger = logging.getLogger(__name__)


def setup_minio_bucket(bucket_name=None):
    """Set up MinIO bucket with public read access"""
    # Get configuration from environment variables or defaults
    endpoint_url = os.environ.get("AWS_S3_ENDPOINT", "http://host.docker.internal:9000")
    access_key = os.environ.get("AWS_ACCESS_KEY_ID", "minioadmin")
    secret_key = os.environ.get("AWS_SECRET_ACCESS_KEY", "minioadmin")
    bucket_name = bucket_name or os.environ.get("AWS_S3_BUCKET_NAME", "polis-delphi")
    region = os.environ.get("AWS_REGION", "us-east-1")

    logger.info(f"Setting up MinIO bucket '{bucket_name}' with public-read access")
    logger.info(f"Using endpoint: {endpoint_url}")

    try:
        # Create S3 client
        s3_client = boto3.client(
            "s3",
            endpoint_url=endpoint_url,
            aws_access_key_id=access_key,
            aws_secret_access_key=secret_key,
            region_name=region,
            config=boto3.session.Config(signature_version="s3v4"),
            verify=False,
        )

        # Check if bucket exists
        bucket_exists = False
        try:
            s3_client.head_bucket(Bucket=bucket_name)
            logger.info(f"Bucket '{bucket_name}' already exists")
            bucket_exists = True
        except:
            logger.info(f"Bucket '{bucket_name}' doesn't exist, creating...")

            # Create bucket - no region needed for minio/us-east-1
            if (
                region == "us-east-1"
                or "localhost" in endpoint_url
                or "minio" in endpoint_url
            ):
                s3_client.create_bucket(Bucket=bucket_name)
            else:
                s3_client.create_bucket(
                    Bucket=bucket_name,
                    CreateBucketConfiguration={"LocationConstraint": region},
                )
            logger.info(f"Created bucket '{bucket_name}'")

        # Set bucket policy to public-read
        bucket_policy = {
            "Version": "2012-10-17",
            "Statement": [
                {
                    "Sid": "PublicReadGetObject",
                    "Effect": "Allow",
                    "Principal": "*",
                    "Action": ["s3:GetObject"],
                    "Resource": [f"arn:aws:s3:::{bucket_name}/*"],
                }
            ],
        }

        # Apply policy
        try:
            s3_client.put_bucket_policy(
                Bucket=bucket_name, Policy=json.dumps(bucket_policy)
            )
            logger.info(f"Applied public-read policy to bucket '{bucket_name}'")
        except Exception as e:
            logger.warning(f"Error setting bucket policy: {e}")

        # Just to verify everything is working correctly, create a test object
        try:
            test_key = "_test/setup_test.txt"
            s3_client.put_object(
                Bucket=bucket_name,
                Key=test_key,
                Body="Delphi S3 setup test",
                ACL="public-read",
                ContentType="text/plain",
            )
            logger.info(f"Created test object at s3://{bucket_name}/{test_key}")

            # Create index.html file for visualization root
            index_html = """<!DOCTYPE html>
<html>
<head>
    <title>Delphi Visualizations</title>
    <style>
        body { font-family: Arial, sans-serif; margin: 20px; }
        h1 { color: #333; }
        p { color: #666; }
    </style>
</head>
<body>
    <h1>Delphi Visualizations</h1>
    <p>This is the root directory for Delphi visualizations. Visualizations are organized by report ID and job ID.</p>
    <p>Path format: /visualizations/{report_id}/{job_id}/layer_{layer_id}_datamapplot.html</p>
</body>
</html>"""

            # Upload index.html to the root of the visualizations directory
            index_key = "visualizations/index.html"
            s3_client.put_object(
                Bucket=bucket_name,
                Key=index_key,
                Body=index_html,
                ACL="public-read",
                ContentType="text/html",
            )
            logger.info(f"Created index.html at s3://{bucket_name}/{index_key}")

            # Generate public URL based on endpoint type
            if "localhost" in endpoint_url or "127.0.0.1" in endpoint_url:
                # Local development URL
                public_url = f"{endpoint_url}/{bucket_name}/{test_key}"
            elif "minio" in endpoint_url:
                # Docker container URL
                public_url = f"{endpoint_url}/{bucket_name}/{test_key}"
            else:
                # AWS S3 URL
                public_url = f"https://{bucket_name}.s3.amazonaws.com/{test_key}"

            logger.info(f"Test object should be accessible at: {public_url}")

        except Exception as e:
            logger.warning(f"Could not create test object: {e}")

        return True
    except Exception as e:
        logger.error(f"Error setting up MinIO bucket: {e}")
        import traceback

        logger.error(traceback.format_exc())
        return False


if __name__ == "__main__":
    # Optional bucket name from command line
    bucket_name = sys.argv[1] if len(sys.argv) > 1 else None

    success = setup_minio_bucket(bucket_name)
    if success:
        logger.info("MinIO bucket setup completed successfully")
        sys.exit(0)
    else:
        logger.error("MinIO bucket setup failed")
        sys.exit(1)
