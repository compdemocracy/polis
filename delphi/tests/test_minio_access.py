#!/usr/bin/env python3
"""
Test script to verify MinIO/S3 connection and list objects in the bucket.
"""

import os
import sys
import logging
import boto3

# Configure logging
logging.basicConfig(level=logging.INFO, format='%(asctime)s - %(levelname)s - %(message)s')
logger = logging.getLogger(__name__)

def test_s3_access():
    """Test S3/MinIO access by listing bucket contents"""
    
    # Get S3 settings from environment or use defaults
    endpoint_url = os.environ.get('AWS_S3_ENDPOINT', 'http://localhost:9000')
    access_key = os.environ.get('AWS_ACCESS_KEY_ID', 'minioadmin')
    secret_key = os.environ.get('AWS_SECRET_ACCESS_KEY', 'minioadmin')
    bucket_name = os.environ.get('AWS_S3_BUCKET_NAME', 'delphi')
    region = os.environ.get('AWS_REGION', 'us-east-1')
    
    logger.info(f"S3 settings:")
    logger.info(f"  Endpoint: {endpoint_url}")
    logger.info(f"  Bucket: {bucket_name}")
    logger.info(f"  Region: {region}")
    
    try:
        # Create S3 client
        s3_client = boto3.client(
            's3',
            endpoint_url=endpoint_url,
            aws_access_key_id=access_key,
            aws_secret_access_key=secret_key,
            region_name=region,
            # For MinIO/local development, these settings help
            config=boto3.session.Config(signature_version='s3v4'),
            verify=False
        )
        
        # Check if bucket exists
        try:
            s3_client.head_bucket(Bucket=bucket_name)
            logger.info(f"Bucket '{bucket_name}' exists ✅")
        except Exception as e:
            logger.error(f"Bucket '{bucket_name}' does not exist or cannot be accessed ❌")
            logger.error(f"Error: {e}")
            return False
            
        # List objects in bucket
        try:
            response = s3_client.list_objects_v2(Bucket=bucket_name)
            
            if 'Contents' in response:
                objects = response['Contents']
                logger.info(f"Found {len(objects)} objects in bucket")
                
                # Print first 10 objects
                for i, obj in enumerate(objects[:10]):
                    logger.info(f"  {i+1}. {obj.get('Key')} ({obj.get('Size')} bytes)")
                    
                if len(objects) > 10:
                    logger.info(f"  ... and {len(objects) - 10} more")
            else:
                logger.info("Bucket is empty")
                
            return True
        except Exception as list_error:
            logger.error(f"Error listing objects in bucket: {list_error}")
            return False
            
    except Exception as e:
        logger.error(f"Error connecting to S3/MinIO: {e}")
        import traceback
        logger.error(traceback.format_exc())
        return False

if __name__ == "__main__":
    logger.info("Testing S3/MinIO access")
    if test_s3_access():
        logger.info("✅ S3/MinIO connection test passed")
        sys.exit(0)
    else:
        logger.error("❌ S3/MinIO connection test failed")
        sys.exit(1)