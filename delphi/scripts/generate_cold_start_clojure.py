#!/usr/bin/env python3
"""
Generate cold-start Clojure math blobs for fair Python comparison.

This script uses a "fake conversation" approach to generate true cold-start
computations from the Clojure implementation:

1. Creates a temporary conversation with a fresh zid
2. Copies votes from the source conversation with fresh timestamps
3. Runs the Clojure poller which processes the fake conversation
4. Extracts the resulting math blob (true cold-start)
5. Cleans up all temporary data

This approach works with the Clojure poller's design rather than against it.

Usage:
    python scripts/generate_cold_start_clojure.py biodiversity
    python scripts/generate_cold_start_clojure.py --all
    python scripts/generate_cold_start_clojure.py biodiversity --no-cleanup
"""

import json
import os
import subprocess
import sys
import time
from pathlib import Path

import click
import psycopg2
from dotenv import load_dotenv

# Add parent directory to path for imports
sys.path.insert(0, str(Path(__file__).parent.parent))

from polismath.regression import discover_datasets, get_dataset_info

# Load .env from polis-kmeans root directory
load_dotenv(Path(__file__).parent.parent.parent / '.env')

# Derive POLIS_DIR from script location (polis-kmeans is the worktree root)
# scripts/ is at delphi/scripts/, so go up 3 levels: scripts -> delphi -> polis-kmeans
POLIS_DIR = Path(__file__).parent.parent.parent.resolve()
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


def get_conversation_owner(conn, zid: int) -> int | None:
    """Get the owner uid of a conversation."""
    cursor = conn.cursor()
    cursor.execute("SELECT owner FROM conversations WHERE zid = %s", (zid,))
    row = cursor.fetchone()
    cursor.close()
    return row[0] if row else None


def get_vote_count(conn, zid: int) -> int:
    """Get number of votes for a zid."""
    cursor = conn.cursor()
    cursor.execute("SELECT COUNT(*) FROM votes WHERE zid = %s", (zid,))
    count = cursor.fetchone()[0]
    cursor.close()
    return count


def create_fake_conversation(conn, source_zid: int) -> int:
    """
    Create a minimal fake conversation entry.

    Returns the new zid for the fake conversation.
    """
    # Get owner from source conversation
    owner = get_conversation_owner(conn, source_zid)
    if not owner:
        raise ValueError(f"Source conversation {source_zid} not found or has no owner")

    cursor = conn.cursor()

    # Insert minimal conversation row - zid is auto-generated (SERIAL)
    # We use a special topic to identify it as a fake conversation
    cursor.execute("""
        INSERT INTO conversations (owner, topic, description, is_active, is_public)
        VALUES (%s, %s, %s, false, false)
        RETURNING zid
    """, (
        owner,
        f"[TEMP] Cold-start test for zid {source_zid}",
        f"Temporary conversation for generating cold-start math blob. Source: {source_zid}"
    ))

    fake_zid = cursor.fetchone()[0]
    conn.commit()
    cursor.close()

    return fake_zid


def copy_votes_with_fresh_timestamps(conn, source_zid: int, fake_zid: int) -> int:
    """
    Copy votes from source conversation to fake conversation with fresh timestamps.

    Preserves vote ORDER by using sequential timestamps starting from now.
    The poller finds votes by `created > last_poll_timestamp`, so fresh
    timestamps ensure these votes are picked up.

    Returns the number of votes copied.
    """
    cursor = conn.cursor()

    # Get current time in milliseconds (matching Polis schema)
    now_ms = int(time.time() * 1000)

    # Get all votes from source, ordered by original created timestamp
    # This preserves the voting order
    cursor.execute("""
        SELECT pid, tid, vote, weight_x_32767, created
        FROM votes
        WHERE zid = %s
        ORDER BY created ASC
    """, (source_zid,))

    votes = cursor.fetchall()

    if not votes:
        cursor.close()
        return 0

    # Insert votes with sequential fresh timestamps
    # Space them 10ms apart to maintain order
    insert_values = []
    for i, (pid, tid, vote, weight, _original_created) in enumerate(votes):
        fresh_timestamp = now_ms + (i * 10)  # 10ms apart
        insert_values.append((fake_zid, pid, tid, vote, weight, fresh_timestamp))

    # Batch insert
    cursor.executemany("""
        INSERT INTO votes (zid, pid, tid, vote, weight_x_32767, created)
        VALUES (%s, %s, %s, %s, %s, %s)
    """, insert_values)

    conn.commit()
    cursor.close()

    return len(votes)


def cleanup_fake_conversation(conn, fake_zid: int) -> dict:
    """
    Delete all data associated with the fake conversation.

    Returns a dict with counts of deleted rows from each table.
    """
    cursor = conn.cursor()
    cleanup_stats = {}

    # Delete in order to respect FK constraints
    # Must delete from all tables that reference conversations(zid) before deleting conversation

    # Math tables (created by Clojure poller)
    math_tables = [
        'math_main',
        'math_ptptstats',
        'math_ticks',
        'math_bidtopid',
        'math_cache',
        'math_profile',
        'math_exportstatus',
    ]
    for table in math_tables:
        cursor.execute(f"DELETE FROM {table} WHERE zid = %s", (fake_zid,))
        if cursor.rowcount > 0:
            cleanup_stats[table] = cursor.rowcount

    # votes_latest_unique (populated by trigger from votes)
    cursor.execute("DELETE FROM votes_latest_unique WHERE zid = %s", (fake_zid,))
    if cursor.rowcount > 0:
        cleanup_stats['votes_latest_unique'] = cursor.rowcount

    # votes
    cursor.execute("DELETE FROM votes WHERE zid = %s", (fake_zid,))
    cleanup_stats['votes'] = cursor.rowcount

    # participants (if any were auto-created)
    cursor.execute("DELETE FROM participants WHERE zid = %s", (fake_zid,))
    if cursor.rowcount > 0:
        cleanup_stats['participants'] = cursor.rowcount

    # conversations (last, after all referencing tables)
    cursor.execute("DELETE FROM conversations WHERE zid = %s", (fake_zid,))
    cleanup_stats['conversations'] = cursor.rowcount

    conn.commit()
    cursor.close()

    return cleanup_stats


def wait_for_math_computation(conn, zid: int, math_env: str, timeout_seconds: int = 300) -> dict | None:
    """
    Wait for math_main to be populated with valid cluster data.

    Returns the math blob dict, or None if timeout.
    """
    start_time = time.time()
    last_status = ""

    while time.time() - start_time < timeout_seconds:
        cursor = conn.cursor()
        cursor.execute("""
            SELECT data, last_vote_timestamp
            FROM math_main
            WHERE zid = %s AND math_env = %s
        """, (zid, math_env))
        row = cursor.fetchone()
        cursor.close()

        if row:
            data, last_vote_timestamp = row
            if data and isinstance(data, dict):
                base_clusters = data.get('base-clusters', {})
                if base_clusters and len(base_clusters.get('id', [])) > 0:
                    elapsed = time.time() - start_time
                    click.echo(f"  ✓ Math computation completed in {elapsed:.1f}s")
                    click.echo(f"    Base clusters: {len(base_clusters.get('id', []))}")
                    click.echo(f"    Last vote timestamp: {last_vote_timestamp}")
                    return data

                # Row exists but no clusters yet
                status = f"  Waiting... (row exists, last_vote_ts={last_vote_timestamp}, no clusters yet)"
            else:
                status = f"  Waiting... (row exists but data empty)"
        else:
            status = "  Waiting... (no math_main row yet)"

        if status != last_status:
            click.echo(status)
            last_status = status

        time.sleep(2)

    return None


def run_poller_for_zid(fake_zid: int, timeout_seconds: int = 300) -> subprocess.Popen:
    """
    Start the Clojure poller restricted to process only the fake zid.

    Returns the Popen process handle.
    """
    # Use MATH_ZID_ALLOWLIST to only process our fake conversation
    # This speeds things up significantly and avoids touching other conversations
    cmd = [
        'docker', 'compose', 'run', '--rm',
        '-e', 'POLL_FROM_DAYS_AGO=1',  # Only need very recent votes (ours)
        '-e', f'MATH_ZID_ALLOWLIST={fake_zid}',
        '-e', 'LOGGING_LEVEL=info',
        'math',
        'clojure', '-M:run', 'full'
    ]

    click.echo(f"  Starting poller for zid {fake_zid}...")

    process = subprocess.Popen(
        cmd,
        cwd=POLIS_DIR,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
    )

    return process


def generate_cold_start_via_fake_conversation(
    conn,
    source_zid: int,
    timeout_seconds: int = 300
) -> dict | None:
    """
    Generate cold-start math blob using the fake conversation approach.

    1. Create fake conversation entry
    2. Copy votes with fresh timestamps
    3. Run poller to process
    4. Extract math blob
    5. Return math blob (cleanup happens separately)

    Returns the math blob dict, or None on failure.
    """
    fake_zid = None
    poller_process = None

    try:
        # Step 1: Create fake conversation
        click.echo("\n[1/4] Creating temporary conversation...")
        fake_zid = create_fake_conversation(conn, source_zid)
        click.echo(f"  ✓ Created fake conversation with zid {fake_zid}")

        # Step 2: Copy votes with fresh timestamps
        click.echo("\n[2/4] Copying votes with fresh timestamps...")
        vote_count = copy_votes_with_fresh_timestamps(conn, source_zid, fake_zid)
        if vote_count == 0:
            click.echo("  ✗ No votes found in source conversation!", err=True)
            return None
        click.echo(f"  ✓ Copied {vote_count} votes")

        # Step 3: Run poller
        click.echo("\n[3/4] Running Clojure poller...")
        poller_process = run_poller_for_zid(fake_zid, timeout_seconds)

        # Step 4: Wait for math computation
        click.echo("\n[4/4] Waiting for math computation...")
        math_blob = wait_for_math_computation(conn, fake_zid, MATH_ENV, timeout_seconds)

        if math_blob is None:
            click.echo(f"  ✗ Timeout waiting for math computation", err=True)
            # Show last few lines of poller output for debugging
            if poller_process and poller_process.stdout:
                click.echo("\n  Poller output (last lines):")
                try:
                    output = poller_process.stdout.read().decode('utf-8', errors='replace')
                    for line in output.split('\n')[-20:]:
                        if line.strip():
                            click.echo(f"    {line}")
                except Exception:
                    pass
            return None

        return math_blob

    finally:
        # Always kill the poller process if running
        if poller_process and poller_process.poll() is None:
            click.echo("\n  Stopping poller...")
            poller_process.terminate()
            try:
                poller_process.wait(timeout=10)
            except subprocess.TimeoutExpired:
                poller_process.kill()


def generate_cold_start_for_dataset(
    dataset_name: str,
    no_cleanup: bool = False,
    timeout_seconds: int = 300
) -> bool:
    """
    Generate cold-start math blob for a single dataset.

    Returns True on success, False on failure.
    """
    click.echo(f"\n{'='*70}")
    click.echo(f"Processing dataset: {dataset_name}")
    click.echo(f"{'='*70}")

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

    fake_zid = None

    try:
        # Look up zid from report_id
        click.echo(f"\nLooking up zid for report_id: {report_id}")
        source_zid = get_zid_from_report_id(conn, report_id)
        if not source_zid:
            click.echo(f"Error: No zid found for report_id {report_id}", err=True)
            return False
        click.echo(f"✓ Found source zid: {source_zid}")

        # Check vote count
        vote_count = get_vote_count(conn, source_zid)
        if vote_count == 0:
            click.echo(f"Error: No votes found for zid {source_zid}", err=True)
            return False
        click.echo(f"✓ Source has {vote_count} votes")

        # Generate cold-start via fake conversation
        click.echo(f"\n--- Starting cold-start generation ---")

        # Create fake conversation first (so we can track it for cleanup)
        click.echo("\n[1/4] Creating temporary conversation...")
        fake_zid = create_fake_conversation(conn, source_zid)
        click.echo(f"  ✓ Created fake conversation with zid {fake_zid}")

        # Copy votes
        click.echo("\n[2/4] Copying votes with fresh timestamps...")
        copied_votes = copy_votes_with_fresh_timestamps(conn, source_zid, fake_zid)
        click.echo(f"  ✓ Copied {copied_votes} votes")

        # Run poller
        click.echo("\n[3/4] Running Clojure poller...")
        poller_process = run_poller_for_zid(fake_zid, timeout_seconds)

        # Wait for computation
        click.echo("\n[4/4] Waiting for math computation...")
        math_blob = wait_for_math_computation(conn, fake_zid, MATH_ENV, timeout_seconds)

        # Kill poller
        if poller_process and poller_process.poll() is None:
            click.echo("\n  Stopping poller...")
            poller_process.terminate()
            try:
                poller_process.wait(timeout=10)
            except subprocess.TimeoutExpired:
                poller_process.kill()

        if math_blob is None:
            click.echo(f"\n✗ Failed to generate cold-start math blob!", err=True)
            return False

        # Save the cold-start blob
        click.echo(f"\nSaving cold-start math blob...")

        # Replace the fake zid with source zid in the output for consistency
        math_blob['zid'] = source_zid

        cold_start_file = output_dir / f"{report_id}_math_blob_cold_start.json"
        with open(cold_start_file, 'w') as f:
            json.dump(math_blob, f, indent=2)

        size_kb = len(json.dumps(math_blob)) / 1024
        click.echo(f"✓ Saved cold-start math blob ({size_kb:.1f} KB): {cold_start_file}")

        # Report cluster counts
        base_clusters = math_blob.get('base-clusters', {})
        group_clusters = math_blob.get('group-clusters', [])
        n_groups = len(group_clusters) if isinstance(group_clusters, list) else 0
        click.echo(f"\nCluster summary:")
        click.echo(f"  - Base clusters: {len(base_clusters.get('id', []))}")
        click.echo(f"  - Group clusters: {n_groups}")

        click.echo(f"\n✓ Successfully generated cold-start blob for {dataset_name}")
        return True

    finally:
        # Always clean up fake conversation data
        if fake_zid is not None:
            if no_cleanup:
                click.echo(f"\n⚠ Skipping cleanup (--no-cleanup flag). Fake zid: {fake_zid}")
            else:
                click.echo(f"\nCleaning up temporary data for fake zid {fake_zid}...")
                cleanup_stats = cleanup_fake_conversation(conn, fake_zid)
                click.echo(f"  ✓ Cleaned up: {cleanup_stats}")

        conn.close()


@click.command()
@click.argument('dataset', required=False)
@click.option('--all', 'process_all', is_flag=True, help='Process all datasets')
@click.option('--include-local', is_flag=True, default=False, help='Include datasets from real_data/.local/')
@click.option('--no-cleanup', is_flag=True, help='Do not cleanup fake conversation (for debugging)')
@click.option('--timeout', default=300, help='Timeout in seconds for math computation (default: 300)')
def main(dataset: str | None, process_all: bool, include_local: bool, no_cleanup: bool, timeout: int):
    """
    Generate cold-start Clojure math blobs for fair Python comparison.

    This script creates a temporary "fake" conversation in the database,
    copies votes from the source conversation with fresh timestamps, and
    runs the Clojure poller to compute a true cold-start math blob.

    Examples:

        # Generate for single dataset
        python scripts/generate_cold_start_clojure.py biodiversity

        # Generate for all committed datasets
        python scripts/generate_cold_start_clojure.py --all

        # Generate for all datasets including .local/
        python scripts/generate_cold_start_clojure.py --all --include-local

        # Keep fake conversation for debugging
        python scripts/generate_cold_start_clojure.py biodiversity --no-cleanup
    """
    # Check for DATABASE_URL
    if not os.environ.get('DATABASE_URL'):
        click.echo("Error: DATABASE_URL environment variable is required", err=True)
        click.echo("\nMake sure .env file exists with DATABASE_URL set:", err=True)
        click.echo(f"  Looked in: {POLIS_DIR}/.env", err=True)
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
            results[name] = generate_cold_start_for_dataset(
                name,
                no_cleanup=no_cleanup,
                timeout_seconds=timeout
            )
        except Exception as e:
            click.echo(f"\n✗ Error processing {name}: {e}", err=True)
            import traceback
            traceback.print_exc()
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
