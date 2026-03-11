#!/usr/bin/env python3
"""
Script to download real test data from Polis exports for delphi tests.

This script downloads data from a running Polis instance:
1. Downloads CSV exports (comments, votes, summary) from the report endpoint
   - Requires: Polis web server running (default: http://localhost)
   - Use --base-url to specify a different instance (e.g., --base-url https://pol.is for production)
2. Extracts the math blob JSON from the Postgres database
   - Requires: DATABASE_URL environment variable set to a valid Postgres connection string
   - Requires: Postgres database with the reports and math_main table populated
   - Note: Math blobs may not be available if the database is not accessible or
     if the Clojure math computation hasn't run for the given report
3. Saves all files to real_data/.local/<report_id>-<name>/ by default
   (use --commit to save to real_data/ for committed datasets)

Requirements:
    - DATABASE_URL environment variable must be set (e.g., postgres://user:pass@host:port/dbname)
    - Polis web server accessible (default: http://localhost, use --base-url for other instances)

Usage:
    # Download a new dataset (saves to .local/ by default)
    python regression_download.py rexample1234 myconvo

    # Download to committed location (for public datasets)
    python regression_download.py rexample1234 myconvo --commit

    # Download from production (https://pol.is)
    python regression_download.py rexample1234 myconvo --base-url https://pol.is

    # Force re-download all configured datasets
    python regression_download.py --force

    # Download specific datasets by name (from config)
    python regression_download.py --datasets biodiversity vw

Examples:
    python regression_download.py rexample1234 myconvo          # Downloads to .local/
    python regression_download.py rexample1234 myconvo --commit # Downloads to real_data/
    python regression_download.py --datasets vw                 # Downloads configured dataset
    python regression_download.py rexample1234 myconvo --base-url https://pol.is  # From production
"""

import json
import os
import sys
from datetime import datetime
from pathlib import Path
from typing import Optional
from dotenv import load_dotenv

import click
import psycopg2
import requests
from tqdm import tqdm

from polismath.regression import list_available_datasets, get_dataset_report_id

# Load .env from polis/ parent directory (script is at polis/delphi/scripts/regression_download.py)
# Need to go up 3 levels: scripts/ -> delphi/ -> polis/
load_dotenv(Path(__file__).parent.parent.parent / '.env')


def get_db_connection():
    """Create a connection to the Postgres database using environment variables."""
    # These will be automatically loaded from .env by pyauto-dotenv when running from delphi directory
    # Try to use DATABASE_URL first (connection string), fall back to individual parameters
    database_url = os.environ.get('DATABASE_URL')
    if not database_url:
        raise ValueError(
            "DATABASE_URL environment variable is not set. "
            "Please set it to a valid Postgres connection string (e.g., postgres://user:pass@host:port/dbname)"
        )
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
@click.argument('report_id', required=False)
@click.argument('dataset_name', required=False)
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
    help='Output directory (overrides default location)'
)
@click.option(
    '--commit',
    is_flag=True,
    help='Save to real_data/ instead of real_data/.local/ (for public datasets to commit)'
)
@click.option(
    '--force',
    is_flag=True,
    help='Force re-download even if files already exist'
)
def main(report_id: Optional[str], dataset_name: Optional[str], datasets: tuple,
         base_url: str, output_dir: Optional[Path], commit: bool, force: bool):
    """
    Download real test data from Polis exports.

    By default, downloads to real_data/.local/ (git-ignored).
    Use --commit to download to real_data/ for datasets intended to be committed.

    Examples:

        \b
        # Download a new dataset to .local/ (git-ignored)
        python regression_download.py rexample1234 myconvo

        \b
        # Download a dataset for committing to the repo
        python regression_download.py rexample1234 myconvo --commit

        \b
        # Download configured datasets by name
        python regression_download.py --datasets biodiversity --datasets vw

        \b
        # Force re-download all configured datasets
        python regression_download.py --force

        \b
        # Download from production Polis instance
        python regression_download.py rexample1234 myconvo --base-url https://pol.is

        \b
        # Specify custom base URL (e.g., local dev server on different port)
        python regression_download.py rexample1234 myconvo --base-url http://localhost:5000
    """
    # Check for required DATABASE_URL environment variable
    database_url = os.environ.get('DATABASE_URL')
    if not database_url:
        click.echo("Error: DATABASE_URL environment variable is required", err=True)
        click.echo("\nThe DATABASE_URL must be set to a valid Postgres connection string.", err=True)
        click.echo("Example: postgres://user:password@localhost:5432/dbname", err=True)
        click.echo("\nYou can set it in your .env file or export it before running:", err=True)
        click.echo("  export DATABASE_URL='postgres://user:pass@host:port/dbname'", err=True)
        click.echo("  python scripts/regression_download.py ...", err=True)
        raise click.Abort()

    # Get the delphi directory (script is at delphi/scripts/regression_download.py)
    delphi_dir = Path(__file__).parent.parent

    # Determine base directory: .local/ by default, real_data/ with --commit
    if commit:
        base_data_dir = delphi_dir / 'real_data'
        location_msg = "real_data/ (will be committed)"
    else:
        base_data_dir = delphi_dir / 'real_data' / '.local'
        location_msg = "real_data/.local/ (git-ignored)"

    # Ensure .local directory exists
    if not commit:
        base_data_dir.mkdir(parents=True, exist_ok=True)

    # Determine which datasets to download
    download_items = []  # List of (report_id, name) tuples
    env_report_ids = os.getenv('TEST_REPORT_IDS', '').strip()

    # Option 1: Positional arguments (report_id and dataset_name)
    if report_id:
        if not dataset_name:
            click.echo("Error: Both report_id and dataset_name are required when downloading a single dataset", err=True)
            click.echo("Usage: python scripts/regression_download.py <report_id> <dataset_name>", err=True)
            raise click.Abort()
        download_items.append((report_id, dataset_name))
        click.echo(f"Downloading dataset '{dataset_name}' ({report_id}) to {location_msg}")

    # Option 2: Specific dataset names from --datasets flag
    elif datasets:
        available_datasets = list_available_datasets(include_local=True)
        for ds_name in datasets:
            if ds_name not in available_datasets:
                available = ', '.join(available_datasets.keys())
                click.echo(f"Error: Unknown dataset: {ds_name}", err=True)
                click.echo(f"Available datasets: {available}", err=True)
                raise click.Abort()
            ds_report_id = get_dataset_report_id(ds_name)
            download_items.append((ds_report_id, ds_name))
        click.echo(f"Downloading {len(download_items)} dataset(s) from config: {', '.join(datasets)}")
        click.echo(f"Saving to: {location_msg}")

    # Option 3: Environment variable
    elif env_report_ids:
        for rid in env_report_ids.replace(',', ' ').split():
            rid = rid.strip()
            if rid:
                ds_name = get_dataset_name_from_report_id(rid)
                download_items.append((rid, ds_name or rid))
        click.echo(f"Downloading {len(download_items)} report IDs from TEST_REPORT_IDS")
        click.echo(f"Saving to: {location_msg}")

    # Option 4: Default - all configured datasets
    else:
        available_datasets = list_available_datasets(include_local=True)
        for ds_name, info in available_datasets.items():
            download_items.append((info['report_id'], ds_name))
        click.echo(f"No datasets specified. Downloading all {len(download_items)} dataset(s) from config:")
        for ds_name, info in available_datasets.items():
            click.echo(f"  - {ds_name}: {info['report_id']} ({info['description']})")
        click.echo(f"Saving to: {location_msg}")
        click.echo()

    # Process each dataset
    results = {}
    for rid, ds_name in download_items:
        # Determine output directory
        dir_name = f"{rid}-{ds_name}"

        if output_dir:
            out_dir = output_dir / dir_name
        else:
            out_dir = base_data_dir / dir_name

        results[rid] = save_test_data(rid, out_dir, base_url, force=force)

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

    # Build a map of report_id -> dataset_name for display
    rid_to_name = {rid: ds_name for rid, ds_name in download_items}

    if successful:
        click.echo(f"\n✓ Successful:")
        for rid in successful:
            ds_name = rid_to_name.get(rid) or get_dataset_name_from_report_id(rid)
            if ds_name:
                click.echo(f"  {rid} ({ds_name})")
            else:
                click.echo(f"  {rid}")

    if failed:
        click.echo(f"\n✗ Failed:")
        for rid in failed:
            ds_name = rid_to_name.get(rid) or get_dataset_name_from_report_id(rid)
            if ds_name:
                click.echo(f"  {rid} ({ds_name})")
            else:
                click.echo(f"  {rid}")
        click.echo("\nSome datasets failed to download!", err=True)
        sys.exit(1)
    else:
        click.echo("\n✓ All datasets processed successfully!")

    # Check for missing golden snapshots and offer to create them
    if successful:
        _offer_golden_snapshot_creation(download_items, rid_to_name, base_data_dir, output_dir)


def _offer_golden_snapshot_creation(download_items: list, rid_to_name: dict,
                                     base_data_dir: Path, output_dir: Optional[Path]):
    """Check for missing golden snapshots and offer to create them."""
    # Find datasets missing golden snapshots
    missing_golden = []
    for rid, ds_name in download_items:
        dir_name = f"{rid}-{ds_name}"
        if output_dir:
            ds_dir = output_dir / dir_name
        else:
            ds_dir = base_data_dir / dir_name

        golden_path = ds_dir / "golden_snapshot.json"
        if not golden_path.exists():
            missing_golden.append(ds_name)

    if not missing_golden:
        return

    click.echo(f"\n{'='*60}")
    click.echo("GOLDEN SNAPSHOTS")
    click.echo(f"{'='*60}\n")
    click.echo("The following datasets are missing golden snapshots:")
    for name in missing_golden:
        click.echo(f"  - {name}")

    click.echo("\n⚠️  Without golden snapshots, these datasets cannot be used for regression testing.")
    click.echo("   Golden snapshots capture the expected output at a known-good commit.")
    click.echo("\n   To create golden snapshots later, run:")
    click.echo(f"     python scripts/regression_recorder.py {' '.join(missing_golden)}")

    if click.confirm("\nWould you like to create golden snapshots now?", default=True):
        click.echo()
        # Import here to avoid circular imports and speed up script loading
        from polismath.regression import ConversationRecorder
        recorder = ConversationRecorder()

        successful = []
        failed = []
        for ds_name in missing_golden:
            click.echo(f"\n{'='*60}")
            click.echo(f"Recording golden snapshot for: {ds_name}")
            click.echo(f"{'='*60}")
            try:
                recorder.record_golden(ds_name, force=False, benchmark=True)
                click.echo(f"✓ Created golden snapshot for {ds_name}")
                successful.append(ds_name)
            except Exception as e:
                click.echo(f"✗ Failed to create golden snapshot for {ds_name}: {e}", err=True)
                failed.append(ds_name)

        if successful and not failed:
            click.echo("\n✓ Golden snapshot creation complete!")
        elif successful:
            click.echo(f"\n⚠️  Golden snapshot creation partially complete: {len(successful)} succeeded, {len(failed)} failed")
        else:
            click.echo("\n✗ Golden snapshot creation failed for all datasets", err=True)


if __name__ == '__main__':
    main()
