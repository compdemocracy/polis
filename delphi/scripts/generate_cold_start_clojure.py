#!/usr/bin/env python3
"""
Generate cold-start Clojure math blobs for fair Python comparison.

This script:
1. Checks that no math worker is running (to prevent conflicts)
2. Backs up the existing math_main row (if any)
3. Deletes it to force cold-start
4. Runs Clojure computation via Docker
5. Extracts the fresh math blob
6. Restores the original row

Usage:
    python scripts/generate_cold_start_clojure.py biodiversity
    python scripts/generate_cold_start_clojure.py --all
    python scripts/generate_cold_start_clojure.py biodiversity --no-restore
"""

import argparse
import json
import os
import subprocess
import sys
from datetime import datetime
from pathlib import Path

import click
import psycopg2
from dotenv import load_dotenv

# Add parent directory to path for imports
sys.path.insert(0, str(Path(__file__).parent.parent))

from polismath.regression import discover_datasets, get_dataset_info

# Load .env from polis-kmeans root directory
load_dotenv(Path(__file__).parent.parent.parent / '.env')

POLIS_DIR = Path('/Users/julien/polis/github/polis')
MATH_ENV = os.environ.get('MATH_ENV', 'prod')


def check_math_worker_running() -> bool:
    """Check if math worker container is running."""
    result = subprocess.run(
        ['docker', 'ps', '--filter', 'name=math', '--format', '{{.Names}}'],
        capture_output=True, text=True
    )
    # Check for polis-math or similar container names
    return any('math' in line.lower() for line in result.stdout.splitlines())


def get_db_connection():
    """Create a connection to the Postgres database."""
    database_url = os.environ.get('DATABASE_URL')
    if not database_url:
        raise ValueError(
            "DATABASE_URL environment variable is not set. "
            "Please set it in the main polis/.env file."
        )
    return psycopg2.connect(database_url)


def get_zid_from_report_id(conn, report_id: str) -> int | None:
    """Look up zid from report_id."""
    cursor = conn.cursor()
    cursor.execute("SELECT zid FROM reports WHERE report_id = %s", (report_id,))
    row = cursor.fetchone()
    cursor.close()
    return row[0] if row else None


def verify_zid_has_votes(conn, zid: int) -> bool:
    """Verify that the zid has votes in the database."""
    cursor = conn.cursor()
    cursor.execute("SELECT COUNT(*) FROM votes WHERE zid = %s", (zid,))
    count = cursor.fetchone()[0]
    cursor.close()
    return count > 0


def backup_math_main(conn, zid: int, math_env: str) -> dict | None:
    """Backup existing math_main row. Returns None if no row exists."""
    cursor = conn.cursor()
    cursor.execute("""
        SELECT zid, math_env, data, last_vote_timestamp, math_tick, caching_tick, modified
        FROM math_main WHERE zid = %s AND math_env = %s
    """, (zid, math_env))
    row = cursor.fetchone()
    cursor.close()

    if not row:
        return None

    return {
        'zid': row[0],
        'math_env': row[1],
        'data': row[2],  # Already parsed from JSONB by psycopg2
        'last_vote_timestamp': row[3],
        'math_tick': row[4],
        'caching_tick': row[5],
        'modified': row[6],
    }


def delete_math_main(conn, zid: int, math_env: str) -> bool:
    """Delete existing row to force fresh computation. Returns True if row was deleted."""
    cursor = conn.cursor()
    cursor.execute("DELETE FROM math_main WHERE zid = %s AND math_env = %s", (zid, math_env))
    deleted = cursor.rowcount > 0
    conn.commit()
    cursor.close()
    return deleted


def run_clojure_computation(zid: int) -> bool:
    """Run Clojure computation via Docker. Returns True on success."""
    cmd = [
        'docker', 'compose', 'run', '--rm', 'math',
        'clojure', '-M:run', 'update', '-z', str(zid)
    ]
    click.echo(f"Running: {' '.join(cmd)}")
    click.echo("(This may take several minutes...)")
    result = subprocess.run(cmd, cwd=POLIS_DIR)
    return result.returncode == 0


def extract_math_blob(conn, zid: int, math_env: str) -> dict | None:
    """Extract newly computed math blob."""
    cursor = conn.cursor()
    cursor.execute("""
        SELECT data FROM math_main WHERE zid = %s AND math_env = %s
    """, (zid, math_env))
    row = cursor.fetchone()
    cursor.close()
    return row[0] if row else None


def restore_math_main(conn, backup: dict):
    """Restore original math_main row from backup."""
    cursor = conn.cursor()
    cursor.execute("""
        INSERT INTO math_main (zid, math_env, data, last_vote_timestamp, math_tick, caching_tick, modified)
        VALUES (%s, %s, %s, %s, %s, %s, %s)
        ON CONFLICT (zid, math_env) DO UPDATE SET
            data = excluded.data,
            last_vote_timestamp = excluded.last_vote_timestamp,
            math_tick = excluded.math_tick,
            caching_tick = excluded.caching_tick,
            modified = excluded.modified
    """, (
        backup['zid'], backup['math_env'],
        json.dumps(backup['data']),  # Convert dict back to JSON
        backup['last_vote_timestamp'], backup['math_tick'],
        backup['caching_tick'], backup['modified']
    ))
    conn.commit()
    cursor.close()


def generate_cold_start_for_dataset(dataset_name: str, no_restore: bool = False) -> bool:
    """
    Generate cold-start math blob for a single dataset.

    Returns True on success, False on failure.
    """
    click.echo(f"\n{'='*70}")
    click.echo(f"Processing dataset: {dataset_name}")
    click.echo(f"{'='*70}\n")

    # Get dataset info
    try:
        dataset_info = get_dataset_info(dataset_name)
    except ValueError as e:
        click.echo(f"Error: {e}", err=True)
        return False

    report_id = dataset_info.report_id
    output_dir = dataset_info.path

    # Connect to database
    try:
        conn = get_db_connection()
    except Exception as e:
        click.echo(f"Error connecting to database: {e}", err=True)
        return False

    try:
        # Look up zid from report_id
        click.echo(f"Looking up zid for report_id: {report_id}")
        zid = get_zid_from_report_id(conn, report_id)
        if not zid:
            click.echo(f"Error: No zid found for report_id {report_id}", err=True)
            return False
        click.echo(f"✓ Found zid: {zid}")

        # Verify zid has votes
        click.echo(f"Verifying zid {zid} has votes...")
        if not verify_zid_has_votes(conn, zid):
            click.echo(f"Error: No votes found for zid {zid}", err=True)
            return False
        click.echo(f"✓ Verified votes exist")

        # Backup existing math_main row
        click.echo(f"\nBacking up existing math_main row (if any)...")
        backup = backup_math_main(conn, zid, MATH_ENV)

        if backup:
            # Save backup to file
            timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
            backup_file = output_dir / f"math_main_backup_{timestamp}.json"
            with open(backup_file, 'w') as f:
                # Convert for JSON serialization (handle timestamps)
                backup_serializable = {
                    k: (str(v) if k == 'modified' else v)
                    for k, v in backup.items()
                }
                json.dump(backup_serializable, f, indent=2)
            click.echo(f"✓ Backed up existing row to: {backup_file}")
        else:
            click.echo(f"✓ No existing row to backup (will be fresh computation)")

        # Delete existing row to force cold-start
        click.echo(f"\nDeleting math_main row to force cold-start...")
        deleted = delete_math_main(conn, zid, MATH_ENV)
        if deleted:
            click.echo(f"✓ Deleted existing row")
        else:
            click.echo(f"✓ No row to delete")

        # Run Clojure computation
        click.echo(f"\nRunning Clojure cold-start computation for zid {zid}...")
        success = run_clojure_computation(zid)

        if not success:
            click.echo(f"✗ Clojure computation failed!", err=True)
            if backup and not no_restore:
                click.echo("Attempting to restore original row...")
                restore_math_main(conn, backup)
                click.echo("✓ Restored original row")
            return False

        click.echo(f"✓ Clojure computation completed")

        # Extract new math blob
        click.echo(f"\nExtracting cold-start math blob...")
        cold_start_blob = extract_math_blob(conn, zid, MATH_ENV)

        if not cold_start_blob:
            click.echo(f"✗ Failed to extract math blob!", err=True)
            if backup and not no_restore:
                click.echo("Attempting to restore original row...")
                restore_math_main(conn, backup)
                click.echo("✓ Restored original row")
            return False

        # Save cold-start blob
        cold_start_file = output_dir / f"{report_id}_math_blob_cold_start.json"
        with open(cold_start_file, 'w') as f:
            json.dump(cold_start_blob, f, indent=2)

        size_kb = len(json.dumps(cold_start_blob)) / 1024
        click.echo(f"✓ Saved cold-start math blob ({size_kb:.1f} KB): {cold_start_file}")

        # Restore original row (if it existed and not --no-restore)
        if backup and not no_restore:
            click.echo(f"\nRestoring original math_main row...")
            restore_math_main(conn, backup)
            click.echo(f"✓ Restored original row")
        elif backup and no_restore:
            click.echo(f"\nSkipping restore (--no-restore flag set)")
        else:
            click.echo(f"\nNo original row to restore")

        click.echo(f"\n✓ Successfully generated cold-start blob for {dataset_name}")
        return True

    finally:
        conn.close()


@click.command()
@click.argument('dataset', required=False)
@click.option('--all', 'process_all', is_flag=True, help='Process all datasets')
@click.option('--include-local', is_flag=True, default=False, help='Include datasets from real_data/.local/')
@click.option('--no-restore', is_flag=True, help='Do not restore original data after extraction')
def main(dataset: str | None, process_all: bool, include_local: bool, no_restore: bool):
    """
    Generate cold-start Clojure math blobs for fair Python comparison.

    Examples:

        # Generate for single dataset
        python scripts/generate_cold_start_clojure.py biodiversity

        # Generate for all committed datasets
        python scripts/generate_cold_start_clojure.py --all

        # Generate for all datasets including .local/
        python scripts/generate_cold_start_clojure.py --all --include-local

        # Generate without restoring original (dangerous!)
        python scripts/generate_cold_start_clojure.py biodiversity --no-restore
    """
    # Check for DATABASE_URL
    if not os.environ.get('DATABASE_URL'):
        click.echo("Error: DATABASE_URL environment variable is required", err=True)
        raise click.Abort()

    # Check if math worker is running
    if check_math_worker_running():
        click.echo("✗ ERROR: Math worker container is running!", err=True)
        click.echo("\nThe math worker must be stopped to prevent conflicts.", err=True)
        click.echo("Please stop it first:", err=True)
        click.echo(f"  cd {POLIS_DIR}", err=True)
        click.echo("  docker compose stop math", err=True)
        raise click.Abort()

    # Determine which datasets to process
    if process_all:
        datasets = discover_datasets(include_local=include_local)
        dataset_names = list(datasets.keys())
        location = "committed + local" if include_local else "committed"
        click.echo(f"Processing all {len(dataset_names)} {location} dataset(s): {', '.join(dataset_names)}\n")
    elif dataset:
        dataset_names = [dataset]
    else:
        click.echo("Error: Please specify a dataset name or use --all", err=True)
        raise click.Abort()

    # Process each dataset
    results = {}
    for name in dataset_names:
        try:
            results[name] = generate_cold_start_for_dataset(name, no_restore=no_restore)
        except Exception as e:
            click.echo(f"\n✗ Error processing {name}: {e}", err=True)
            results[name] = False

    # Summary
    click.echo(f"\n{'='*70}")
    click.echo("SUMMARY")
    click.echo(f"{'='*70}\n")

    successful = [name for name, success in results.items() if success]
    failed = [name for name, success in results.items() if not success]

    click.echo(f"Total: {len(results)} dataset(s)")
    click.echo(f"Successful: {len(successful)}")
    if failed:
        click.echo(f"Failed: {len(failed)}")

    if successful:
        click.echo(f"\n✓ Successful:")
        for name in successful:
            click.echo(f"  {name}")

    if failed:
        click.echo(f"\n✗ Failed:")
        for name in failed:
            click.echo(f"  {name}")
        sys.exit(1)
    else:
        click.echo("\n✓ All datasets processed successfully!")


if __name__ == '__main__':
    main()
