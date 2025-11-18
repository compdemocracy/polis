#!/usr/bin/env python3
"""
Script to download real test data from Polis exports for delphi tests.

This script downloads data from a running Polis instance:
1. Downloads CSV exports (comments, votes, summary) from the report endpoint
   - Requires: Polis web server running (default: http://localhost)
2. Extracts the math blob JSON from the Postgres database
   - Requires: Postgres database with the reports and math_main table populated
   - Note: Math blobs may not be available if the database is not accessible or
     if the Clojure math computation hasn't run for the given report
3. Saves all files to the real_data/<report_id>/ folder

Usage:
    # Download all datasets from config (skip existing)
    # From environment variable (if TEST_REPORT_IDS set .env)
    python download_real_data.py

    # Force re-download all datasets
    python download_real_data.py --force

    # Download specific datasets by name
    python download_real_data.py --datasets biodiversity vw

    # Download specific report IDs
    python download_real_data.py rabc123xyz456 rdef789uvw012

Examples:
    python download_real_data.py
    python download_real_data.py --force
    python download_real_data.py --datasets vw bg2018
"""

import json
import os
import sys
from datetime import datetime
from pathlib import Path
from typing import List, Optional
from dotenv import load_dotenv

load_dotenv(Path(__file__).parent.parent.parent / '.env')

import click
import psycopg2
import requests
from tqdm import tqdm

from polismath.regression import list_available_datasets, get_dataset_report_id


def get_db_connection():
    """Create a connection to the Postgres database using environment variables."""
    # These will be automatically loaded from .env by pyauto-dotenv when running from delphi directory
    # Try to use DATABASE_URL first (connection string), fall back to individual parameters
    database_url = os.environ.get('DATABASE_URL')
    return psycopg2.connect(database_url)

    # TODO: Uncomment once sorted the difference between env var names between delphi and rest of polis
    ## Fallback to individual parameters
    # return psycopg2.connect(
    #     database=os.environ.get('POSTGRES_DB', 'polismath'),
    #     user=os.environ.get('POSTGRES_USER', 'postgres'),
    #     password=os.environ.get('POSTGRES_PASSWORD', 'postgres'),
    #     host=os.environ.get('POSTGRES_HOST', 'localhost'),
    #     port=os.environ.get('POSTGRES_PORT', '5432')
    # )


def fetch_csv_export(report_id: str, export_type: str, base_url: str = "http://localhost") -> Optional[str]:
    """
    Fetch CSV export from the report endpoint with progress bar.

    Args:
        report_id: The report ID to export
        export_type: Type of export (comments, votes, summary, etc.)
        base_url: Base URL for the Polis instance

    Returns:
        CSV content as string, or None if failed
    """
    url = f"{base_url}/api/v3/reportExport/{report_id}/{export_type}.csv"

    try:
        # Make request with streaming enabled
        print(f"Fetching {export_type} from {url}...")
        response = requests.get(url, timeout=30, stream=True)
        response.raise_for_status()

        # Check if we got CSV content
        if 'text/csv' not in response.headers.get('content-type', ''):
            print(f"Warning: Response is not CSV (content-type: {response.headers.get('content-type')})")

        # Get total size if available (0 if server doesn't send Content-Length)
        total_size = int(response.headers.get('content-length', 0))

        # Set up progress bar - always show it
        desc = f"Downloading {export_type}"
        chunks = []

        # If total_size is 0 (unknown), show bytes downloaded without percentage
        # Otherwise show progress percentage
        if total_size == 0:
            # Unknown size - show indeterminate progress
            with tqdm(unit='B', unit_scale=True, desc=desc, miniters=1) as pbar:
                for chunk in response.iter_content(chunk_size=8192, decode_unicode=True):
                    if chunk:
                        chunks.append(chunk)
                        pbar.update(len(chunk.encode('utf-8')))
        else:
            # Known size - show progress bar with percentage
            with tqdm(total=total_size, unit='B', unit_scale=True, desc=desc) as pbar:
                for chunk in response.iter_content(chunk_size=8192, decode_unicode=True):
                    if chunk:
                        chunks.append(chunk)
                        pbar.update(len(chunk.encode('utf-8')))

        return ''.join(chunks)

    except requests.exceptions.RequestException as e:
        print(f"Error fetching {export_type}: {e}")
        return None


def extract_math_blob(report_id: str) -> Optional[dict]:
    """
    Extract the math blob JSON from the Postgres database.

    Args:
        report_id: The report ID to query

    Returns:
        Math blob as dictionary, or None if failed
    """
    try:
        conn = get_db_connection()
        cursor = conn.cursor()

        # Query to get the math blob from math_main table
        # We join with reports to get the zid from the report_id
        query = """
            SELECT m.data
            FROM math_main m
            JOIN reports r ON m.zid = r.zid
            WHERE r.report_id = %s
            ORDER BY m.modified DESC
            LIMIT 1
        """

        print(f"Querying database for math blob (report_id: {report_id})...")
        cursor.execute(query, (report_id,))
        result = cursor.fetchone()

        if result:
            # The data column is already a JSON object in psycopg2
            math_blob = result[0]
            size_kb = len(json.dumps(math_blob)) / 1024
            print(f"✓ Extracted math blob ({size_kb:.1f} KB)")
            return math_blob
        else:
            print(f"✗ No math blob found for report_id: {report_id}")
            return None

    except Exception as e:
        print(f"Error extracting math blob: {e}")
        return None
    finally:
        if 'cursor' in locals():
            cursor.close()
        if 'conn' in locals():
            conn.close()


def check_existing_files(output_dir: Path, report_id: str) -> dict:
    """
    Check which files already exist for a report.

    Args:
        output_dir: Directory to check
        report_id: The report ID

    Returns:
        Dict with keys 'comments', 'votes', 'summary', 'math_blob' and boolean values
    """
    existing = {}

    # Check CSV files (use glob to match timestamped filenames)
    for csv_type in ['comments', 'votes', 'summary']:
        pattern = f"*-{report_id}-{csv_type}.csv"
        matches = list(output_dir.glob(pattern))
        existing[csv_type] = len(matches) > 0

    # Check math blob
    math_filename = f"{report_id}_math_blob.json"
    existing['math_blob'] = (output_dir / math_filename).exists()

    return existing


def get_dataset_name_from_report_id(report_id: str) -> Optional[str]:
    """
    Get dataset name from report ID by looking up in config.

    Args:
        report_id: The report ID to look up

    Returns:
        Dataset name if found, None otherwise
    """
    datasets = list_available_datasets()
    for name, info in datasets.items():
        if info['report_id'] == report_id:
            return name
    return None


def save_test_data(report_id: str, output_dir: Path, base_url: str = "http://localhost", force: bool = False) -> bool:
    """
    Download and save test data for a given report ID.

    Args:
        report_id: The report ID to process
        output_dir: Directory to save the files
        base_url: Base URL for the Polis instance
        force: If True, download even if files exist; if False, skip existing files

    Returns:
        True if successful, False otherwise
    """
    # Get dataset name if available
    dataset_name = get_dataset_name_from_report_id(report_id)

    print(f"\n{'='*60}")
    if dataset_name:
        print(f"Processing: {dataset_name} ({report_id})")
    else:
        print(f"Processing report ID: {report_id}")
    print(f"{'='*60}\n")

    # Create output directory if it doesn't exist
    output_dir.mkdir(parents=True, exist_ok=True)

    # Check existing files if not forcing download
    if not force and output_dir.exists():
        existing = check_existing_files(output_dir, report_id)
        all_exist = all(existing.values())

        if all_exist:
            print(f"✓ All files already exist for {report_id} (skipping)")
            print(f"  Use --force to re-download")
            return True

        # Show which files exist
        if any(existing.values()):
            print(f"Some files already exist:")
            for file_type, exists in existing.items():
                if exists:
                    print(f"  ✓ {file_type}")

    # Generate timestamp for filenames (matching the format in test files)
    timestamp = datetime.now().strftime("%Y-%m-%d-%H%M")

    # Download CSV files
    csv_types = ['comments', 'votes', 'summary']
    success = True

    for csv_type in csv_types:
        csv_content = fetch_csv_export(report_id, csv_type, base_url)

        if csv_content:
            # Save with timestamp prefix (matching test file naming convention)
            filename = f"{timestamp}-{report_id}-{csv_type}.csv"
            filepath = output_dir / filename

            with open(filepath, 'w', encoding='utf-8') as f:
                f.write(csv_content)

            size_kb = len(csv_content.encode('utf-8')) / 1024
            print(f"✓ Saved {csv_type} ({size_kb:.1f} KB)")
        else:
            print(f"✗ Failed to download {csv_type}")
            success = False

    # Extract and save math blob
    math_blob = extract_math_blob(report_id)

    if math_blob:
        # Save math blob with descriptive name
        math_filename = f"{report_id}_math_blob.json"
        math_filepath = output_dir / math_filename

        with open(math_filepath, 'w', encoding='utf-8') as f:
            json.dump(math_blob, f, indent=2)

        size_kb = len(json.dumps(math_blob)) / 1024
        print(f"✓ Saved math_blob ({size_kb:.1f} KB)")
    else:
        print(f"✗ Failed to extract math blob")
        success = False

    if success:
        print(f"\n✓ Successfully generated test data for {report_id}")
        print(f"  Files saved to: {output_dir}")
    else:
        print(f"\n✗ Some files failed to generate for {report_id}")

    return success


@click.command()
@click.argument('report_ids', nargs=-1)
@click.option(
    '--datasets',
    multiple=True,
    help='Dataset names from config to download (e.g., biodiversity vw). Can be specified multiple times.'
)
@click.option(
    '--base-url',
    default='http://localhost',
    help='Base URL for the Polis instance'
)
@click.option(
    '--output-dir',
    type=click.Path(path_type=Path),
    default=None,
    help='Output directory (default: real_data/<report_id>)'
)
@click.option(
    '--force',
    is_flag=True,
    help='Force re-download even if files already exist'
)
def main(report_ids: tuple, datasets: tuple, base_url: str, output_dir: Optional[Path], force: bool):
    """
    Download real test data from Polis exports.

    If no arguments are provided, downloads all datasets from config.
    Otherwise, downloads specified datasets or report IDs.

    Examples:

        \b
        # Download all datasets from config (skip existing)
        python download_real_data.py

        \b
        # Force re-download all datasets from config
        python download_real_data.py --force

        \b
        # Download specific datasets by name
        python download_real_data.py --datasets biodiversity --datasets vw

        \b
        # Download specific datasets by report ID
        python download_real_data.py rabc123xyz456 rdef789uvw012

        \b
        # Specify custom base URL
        python download_real_data.py --base-url http://localhost:5000

        \b
        # Specify custom output directory
        python download_real_data.py --output-dir /path/to/output
    """
    # Determine which datasets to download
    download_report_ids = []
    env_report_ids = os.getenv('TEST_REPORT_IDS', '').strip()

    # Option 1: Specific dataset names from --datasets flag
    if datasets:
        available_datasets = list_available_datasets()
        for dataset_name in datasets:
            if dataset_name not in available_datasets:
                available = ', '.join(available_datasets.keys())
                click.echo(f"Error: Unknown dataset: {dataset_name}", err=True)
                click.echo(f"Available datasets: {available}", err=True)
                raise click.Abort()
            report_id = get_dataset_report_id(dataset_name)
            download_report_ids.append(report_id)
        click.echo(f"Downloading {len(download_report_ids)} dataset(s) from config: {', '.join(datasets)}")
    # Option 2: Specific report IDs from command line
    elif report_ids:
        download_report_ids = list(report_ids)
        click.echo(f"Downloading {len(download_report_ids)} report ID(s) from command line")
    # Option 3: environment variable
    elif env_report_ids:
        download_report_ids = [rid.strip() for rid in env_report_ids.replace(',', ' ').split() if rid.strip()]
        click.echo(f"Downloading {len(report_ids)} report IDs from TEST_REPORT_IDS environment variable")
    # Option 4: Default - all datasets from config
    else:
        available_datasets = list_available_datasets()
        download_report_ids = [dataset['report_id'] for dataset in available_datasets.values()]
        click.echo(f"No datasets specified. Downloading all {len(download_report_ids)} dataset(s) from config:")
        for name, info in available_datasets.items():
            click.echo(f"  - {name}: {info['report_id']} ({info['description']})")
        click.echo()

    # Get the delphi directory (parent of tests directory where this script lives)
    delphi_dir = Path(__file__).parent.parent

    # Process each report ID
    results = {}
    for report_id in download_report_ids:
        # Determine output directory
        # Use format "reportID-name" if name is available from config
        dataset_name = get_dataset_name_from_report_id(report_id)
        if dataset_name:
            dir_name = f"{report_id}-{dataset_name}"
        else:
            dir_name = report_id

        if output_dir:
            out_dir = output_dir / dir_name
        else:
            out_dir = delphi_dir / 'real_data' / dir_name

        results[report_id] = save_test_data(report_id, out_dir, base_url, force=force)

    # Print summary
    click.echo(f"\n{'='*60}")
    click.echo("SUMMARY")
    click.echo(f"{'='*60}\n")

    successful = [rid for rid, success in results.items() if success]
    failed = [rid for rid, success in results.items() if not success]

    click.echo(f"Total: {len(results)} dataset(s)")
    click.echo(f"Successful: {len(successful)}")
    if failed:
        click.echo(f"Failed: {len(failed)}")

    if successful:
        click.echo(f"\n✓ Successful:")
        for rid in successful:
            dataset_name = get_dataset_name_from_report_id(rid)
            if dataset_name:
                click.echo(f"  {rid} ({dataset_name})")
            else:
                click.echo(f"  {rid}")

    if failed:
        click.echo(f"\n✗ Failed:")
        for rid in failed:
            dataset_name = get_dataset_name_from_report_id(rid)
            if dataset_name:
                click.echo(f"  {rid} ({dataset_name})")
            else:
                click.echo(f"  {rid}")
        click.echo("\nSome datasets failed to download!", err=True)
        sys.exit(1)
    else:
        click.echo("\n✓ All datasets processed successfully!")


if __name__ == '__main__':
    main()
