#!/usr/bin/env python3

import os
import boto3
import mimetypes
import json
import argparse
import sys
from pathlib import Path

# Map of file extensions to content types (only for special cases)
CONTENT_TYPES = {
    ".woff": "application/x-font-woff",
    ".woff2": "application/font-woff2",
    ".ttf": "application/x-font-ttf",
    ".otf": "application/x-font-opentype",
    ".eot": "application/vnd.ms-fontobject",
    ".svg": "image/svg+xml",
}

# Cache settings
CACHE_BUSTER = "no-transform,public,max-age=31536000,s-maxage=31536000"


def get_content_type(file_path):
    """Get content type based on file extension"""
    ext = os.path.splitext(file_path)[1]
    return CONTENT_TYPES.get(ext) or mimetypes.guess_type(file_path)[0]


def upload_file(s3_client, file_path, bucket, base_path):
    """Upload single file to S3 with appropriate headers"""
    relative_path = str(file_path).replace(base_path + "/", "")

    # Default upload arguments - no ACL
    extra_args = {"CacheControl": CACHE_BUSTER}

    # Check for associated headersJson file
    headers_path = str(file_path) + ".headersJson"
    if os.path.exists(headers_path):
        with open(headers_path) as f:
            headers = json.load(f)
            # Map only essential headers
            header_mapping = {
                "Cache-Control": "CacheControl",
                "Content-Type": "ContentType",
                "Content-Encoding": "ContentEncoding",
            }
            for old_key, new_key in header_mapping.items():
                if old_key in headers:
                    extra_args[new_key] = headers[old_key]
    else:
        # Set content type for files without headers
        content_type = get_content_type(file_path)
        if content_type:
            extra_args["ContentType"] = content_type

    print(f"Uploading {relative_path} to {bucket}")
    try:
        s3_client.upload_file(
            str(file_path), bucket, relative_path, ExtraArgs=extra_args
        )
    except Exception as e:
        print(f"Error uploading {relative_path}: {str(e)}")
        raise


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--bucket", required=True, help="S3 bucket name")
    args = parser.parse_args()

    s3_client = boto3.client("s3")
    script_dir = os.path.dirname(os.path.abspath(__file__))
    build_path = os.path.normpath(os.path.join(script_dir, "..", "build"))

    if not os.path.exists(build_path):
        print(f"Error: Build directory not found at {build_path}")
        sys.exit(1)

    for file_path in Path(build_path).rglob("*"):
        if file_path.is_file() and not str(file_path).endswith(".headersJson"):
            upload_file(s3_client, file_path, args.bucket, build_path)


if __name__ == "__main__":
    main()
