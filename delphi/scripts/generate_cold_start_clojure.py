#!/usr/bin/env python3
"""
Generate cold-start Clojure math blobs for fair Python comparison.

This script uses a "conversation replay" approach to generate true cold-start
computations from the Clojure implementation:

1. Creates a temporary conversation with a fresh zid
2. Copies votes from the source conversation with fresh timestamps
3. Runs the Clojure poller which processes the replayed conversation
4. Extracts the resulting math blob (true cold-start)
5. Cleans up all temporary data

This approach works with the Clojure poller's design rather than against it.

Usage:
    python scripts/generate_cold_start_clojure.py biodiversity --stop-math
    python scripts/generate_cold_start_clojure.py --all --stop-math
    python scripts/generate_cold_start_clojure.py biodiversity --no-cleanup
"""

import json
import os
import subprocess
import sys
import threading
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


def get_running_math_containers() -> list[str]:
    """Get list of running math worker container names."""
    result = subprocess.run(
        ['docker', 'ps', '--filter', 'name=math', '--format', '{{.Names}}'],
        capture_output=True, text=True
    )
    return [line for line in result.stdout.splitlines() if 'math' in line.lower()]


def check_math_worker_running() -> bool:
    """Check if math worker container is running."""
    return len(get_running_math_containers()) > 0


def pause_math_workers() -> list[str]:
    """Pause all running math worker containers.

    Returns list of container names that were paused.
    """
    containers = get_running_math_containers()
    if not containers:
        return []

    paused = []
    for container in containers:
        click.echo(f"  Pausing {container}...")
        result = subprocess.run(['docker', 'pause', container], capture_output=True)
        if result.returncode == 0:
            paused.append(container)
        else:
            click.echo(f"    Warning: Failed to pause {container}", err=True)

    return paused


def unpause_math_workers(containers: list[str]) -> int:
    """Unpause previously paused math worker containers.

    Args:
        containers: List of container names to unpause

    Returns the number of containers unpaused.
    """
    if not containers:
        return 0

    unpaused = 0
    for container in containers:
        click.echo(f"  Resuming {container}...")
        result = subprocess.run(['docker', 'unpause', container], capture_output=True)
        if result.returncode == 0:
            unpaused += 1
        else:
            click.echo(f"    Warning: Failed to unpause {container}", err=True)

    return unpaused


def stop_math_workers() -> int:
    """Stop all running math worker containers.

    Returns the number of containers stopped.
    """
    containers = get_running_math_containers()
    if not containers:
        return 0

    for container in containers:
        click.echo(f"  Stopping {container}...")
        subprocess.run(['docker', 'stop', container], capture_output=True)

    return len(containers)


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

    Uses a single INSERT ... SELECT for efficiency (no Python roundtrips).

    Returns the number of votes copied.
    """
    cursor = conn.cursor()

    # Get current time in milliseconds (matching Polis schema)
    now_ms = int(time.time() * 1000)

    # Single INSERT ... SELECT with ROW_NUMBER() to generate sequential timestamps
    # This is much faster than executemany for large vote counts
    # Use DISTINCT ON (pid, tid) to handle duplicate votes (keeps the latest)
    cursor.execute("""
        INSERT INTO votes (zid, pid, tid, vote, weight_x_32767, created)
        SELECT
            %s,
            pid,
            tid,
            vote,
            weight_x_32767,
            %s + (ROW_NUMBER() OVER (ORDER BY created ASC) - 1) * 10
        FROM (
            SELECT DISTINCT ON (pid, tid) pid, tid, vote, weight_x_32767, created
            FROM votes
            WHERE zid = %s
            ORDER BY pid, tid, created DESC
        ) AS deduplicated
        ORDER BY created ASC
    """, (fake_zid, now_ms, source_zid))

    copied_count = cursor.rowcount
    conn.commit()
    cursor.close()

    return copied_count


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


class PollerError(Exception):
    """Raised when the Clojure poller encounters a fatal error."""
    pass


def wait_for_math_computation(
    conn,
    zid: int,
    math_env: str,
    timeout_seconds: int = 300,
    monitor: 'PollerMonitor | None' = None
) -> dict | None:
    """
    Wait for math_main to be populated with valid cluster data.

    Returns the math blob dict, or None if timeout.
    Raises PollerError if the Clojure poller encounters a fatal error.
    """
    start_time = time.time()
    last_status = ""

    while time.time() - start_time < timeout_seconds:
        # Check for Clojure errors first
        if monitor and monitor.error_detected.is_set():
            raise PollerError(monitor.error_message or "Unknown Clojure error")

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


# Error patterns that indicate fatal Clojure failures
FATAL_ERROR_PATTERNS = [
    "Failed conversation update",
    "nil has zero dimensionality",
    "Re-queueing messages for failed update",
    "java.lang.OutOfMemoryError",
]


class PollerMonitor:
    """Monitor poller output for errors."""

    def __init__(self, verbose: bool = False):
        self.verbose = verbose
        self.error_detected = threading.Event()
        self.error_message: str | None = None

    def stream_output(self, process: subprocess.Popen, prefix: str = "    [clj] "):
        """Background thread to stream process output and detect errors."""
        try:
            for line in iter(process.stdout.readline, b''):
                if line:
                    text = line.decode('utf-8', errors='replace').rstrip()
                    if text:
                        if self.verbose:
                            click.echo(f"{prefix}{text}")

                        # Check for fatal errors
                        for pattern in FATAL_ERROR_PATTERNS:
                            if pattern in text:
                                self.error_message = f"Clojure error detected: {pattern}"
                                self.error_detected.set()
                                break
        except Exception:
            pass  # Process terminated


def run_poller_for_zid(fake_zid: int, timeout_seconds: int = 300, verbose: bool = False) -> tuple[subprocess.Popen, PollerMonitor]:
    """
    Start the Clojure poller restricted to process only the fake zid.

    Returns tuple of (Popen process handle, PollerMonitor for error detection).
    """
    # Use MATH_ZID_ALLOWLIST to only process our fake conversation
    # This speeds things up significantly and avoids touching other conversations
    log_level = 'debug' if verbose else 'info'
    cmd = [
        'docker', 'compose', 'run', '--rm',
        '-e', 'POLL_FROM_DAYS_AGO=1',  # Only need very recent votes (ours)
        '-e', f'MATH_ZID_ALLOWLIST={fake_zid}',
        '-e', f'LOGGING_LEVEL={log_level}',
        'math',
        'clojure', '-M:run', 'full'
    ]

    click.echo(f"  Starting poller for zid {fake_zid}...")
    if verbose:
        click.echo(f"  Command: {' '.join(cmd)}")

    process = subprocess.Popen(
        cmd,
        cwd=POLIS_DIR,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
    )

    # Always start monitor thread (for error detection), verbose controls output
    monitor = PollerMonitor(verbose=verbose)
    stream_thread = threading.Thread(
        target=monitor.stream_output,
        args=(process,),
        daemon=True
    )
    stream_thread.start()

    return process, monitor


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
        poller_process, poller_monitor = run_poller_for_zid(fake_zid, timeout_seconds)

        # Step 4: Wait for math computation
        click.echo("\n[4/4] Waiting for math computation...")
        try:
            math_blob = wait_for_math_computation(conn, fake_zid, MATH_ENV, timeout_seconds, monitor=poller_monitor)
        except PollerError as e:
            click.echo(f"  ✗ Clojure poller failed: {e}", err=True)
            return None

        if math_blob is None:
            click.echo(f"  ✗ Timeout waiting for math computation", err=True)
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
    timeout_seconds: int = 300,
    verbose: bool = False
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
    poller_process = None

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

        # Generate cold-start via conversation replay
        click.echo(f"\n--- Starting cold-start generation ---")

        # Create temporary conversation (so we can track it for cleanup)
        click.echo("\n[1/4] Creating temporary conversation...")
        fake_zid = create_fake_conversation(conn, source_zid)
        click.echo(f"  ✓ Created temporary conversation with zid {fake_zid}")

        # Copy votes
        click.echo("\n[2/4] Copying votes with fresh timestamps...")
        copied_votes = copy_votes_with_fresh_timestamps(conn, source_zid, fake_zid)
        click.echo(f"  ✓ Copied {copied_votes} votes")

        # Run poller
        click.echo("\n[3/4] Running Clojure poller...")
        poller_process, poller_monitor = run_poller_for_zid(fake_zid, timeout_seconds, verbose=verbose)

        # Wait for computation
        click.echo("\n[4/4] Waiting for math computation...")
        try:
            math_blob = wait_for_math_computation(conn, fake_zid, MATH_ENV, timeout_seconds, monitor=poller_monitor)
        except PollerError as e:
            click.echo(f"\n✗ Clojure poller failed: {e}", err=True)
            click.echo("  The conversation data may not be processable by the Clojure implementation.", err=True)
            return False

        if math_blob is None:
            click.echo(f"\n✗ Failed to generate cold-start math blob (timeout)!", err=True)
            return False

        # Save the cold-start blob
        click.echo(f"\nSaving cold-start math blob...")

        # Replace the temporary zid with source zid in the output for consistency
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
        # Always kill the poller process if running
        if poller_process and poller_process.poll() is None:
            click.echo("\n  Stopping poller...")
            poller_process.terminate()
            try:
                poller_process.wait(timeout=10)
            except subprocess.TimeoutExpired:
                poller_process.kill()

        # Always clean up temporary conversation data
        if fake_zid is not None:
            if no_cleanup:
                click.echo(f"\n⚠ Skipping cleanup (--no-cleanup flag). Temporary zid: {fake_zid}")
            else:
                click.echo(f"\nCleaning up temporary data for zid {fake_zid}...")
                cleanup_stats = cleanup_fake_conversation(conn, fake_zid)
                click.echo(f"  ✓ Cleaned up: {cleanup_stats}")

        conn.close()


@click.command()
@click.argument('datasets', nargs=-1)
@click.option('--all', 'process_all', is_flag=True, help='Process all datasets')
@click.option('--include-local', is_flag=True, default=False, help='Include datasets from real_data/.local/')
@click.option('--no-cleanup', is_flag=True, help='Do not cleanup temporary conversation (for debugging)')
@click.option('--timeout', default=300, help='Timeout in seconds for math computation (default: 300)')
@click.option('--pause-math', is_flag=True, help='Automatically pause running math workers (resumes after completion)')
@click.option('--verbose', '-v', is_flag=True, help='Show detailed output including Clojure poller logs')
def main(datasets: tuple, process_all: bool, include_local: bool, no_cleanup: bool, timeout: int, pause_math: bool, verbose: bool):
    """
    Generate cold-start Clojure math blobs for fair Python comparison.

    This script creates a temporary conversation in the database (replaying
    votes from the source), and runs the Clojure poller to compute a true
    cold-start math blob.

    Examples:

        # Generate for single dataset
        python scripts/generate_cold_start_clojure.py biodiversity

        # Generate for multiple datasets
        python scripts/generate_cold_start_clojure.py biodiversity vw american-assembly

        # Generate for all committed datasets
        python scripts/generate_cold_start_clojure.py --all

        # Generate for all datasets including .local/
        python scripts/generate_cold_start_clojure.py --all --include-local

        # Automatically pause math workers (resumes after completion)
        python scripts/generate_cold_start_clojure.py biodiversity --pause-math

        # Verbose mode: show Clojure poller output in real-time
        python scripts/generate_cold_start_clojure.py biodiversity -v

        # Keep temporary conversation for debugging
        python scripts/generate_cold_start_clojure.py biodiversity --no-cleanup
    """
    # Check for DATABASE_URL
    if not os.environ.get('DATABASE_URL'):
        click.echo("Error: DATABASE_URL environment variable is required", err=True)
        click.echo("\nMake sure .env file exists with DATABASE_URL set:", err=True)
        click.echo(f"  Looked in: {POLIS_DIR}/.env", err=True)
        raise click.Abort()

    # Check if math worker is running
    paused_containers: list[str] = []
    if check_math_worker_running():
        if pause_math:
            click.echo("Pausing running math worker containers...")
            paused_containers = pause_math_workers()
            click.echo(f"  ✓ Paused {len(paused_containers)} container(s)")
        else:
            click.echo("✗ ERROR: Math worker container is running!", err=True)
            click.echo("\nThe math worker must be paused/stopped to prevent conflicts.", err=True)
            click.echo("Either use --pause-math to pause it automatically, or stop it manually:", err=True)
            click.echo(f"  cd {POLIS_DIR}", err=True)
            click.echo("  docker compose stop math", err=True)
            raise click.Abort()

    # Determine which datasets to process
    available_datasets = discover_datasets(include_local=include_local)

    if process_all:
        dataset_names = list(available_datasets.keys())
        location = "committed + local" if include_local else "committed"
        click.echo(f"Processing all {len(dataset_names)} {location} dataset(s): {', '.join(dataset_names)}\n")
    elif datasets:
        # Validate specified datasets exist
        invalid = [d for d in datasets if d not in available_datasets]
        if invalid:
            click.echo(f"Error: Unknown dataset(s): {', '.join(invalid)}", err=True)
            click.echo(f"Available datasets: {', '.join(available_datasets.keys())}", err=True)
            raise click.Abort()
        dataset_names = list(datasets)
        click.echo(f"Processing {len(dataset_names)} dataset(s): {', '.join(dataset_names)}\n")
    else:
        click.echo("Error: Please specify dataset name(s) or use --all", err=True)
        click.echo(f"Available datasets: {', '.join(available_datasets.keys())}", err=True)
        raise click.Abort()

    try:
        # Process each dataset
        results = {}
        for name in dataset_names:
            try:
                results[name] = generate_cold_start_for_dataset(
                    name,
                    no_cleanup=no_cleanup,
                    timeout_seconds=timeout,
                    verbose=verbose
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

    finally:
        # Resume any paused math workers
        if paused_containers:
            click.echo("\nResuming paused math worker containers...")
            n_resumed = unpause_math_workers(paused_containers)
            click.echo(f"  ✓ Resumed {n_resumed} container(s)")


if __name__ == '__main__':
    main()
