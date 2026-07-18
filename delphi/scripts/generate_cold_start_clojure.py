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
    python scripts/generate_cold_start_clojure.py biodiversity
    python scripts/generate_cold_start_clojure.py --all --include-local
    python scripts/generate_cold_start_clojure.py biodiversity --no-cleanup
"""

import json
import os
import subprocess
import sys
import tempfile
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


# Marker file used to track whether we (coldstart runs) paused the math worker.
# If the user paused it manually, no marker exists and we won't unpause it.
PAUSE_MARKER = Path(tempfile.gettempdir()) / 'polis-math-coldstart-paused'


def get_running_math_workers() -> list[str]:
    """Get running math worker containers (excluding our coldstart containers)."""
    result = subprocess.run(
        ['docker', 'ps', '--filter', 'name=math', '--format', '{{.Names}}'],
        capture_output=True, text=True,
    )
    return [
        name for name in result.stdout.splitlines()
        if name and 'coldstart' not in name
    ]


def get_running_coldstart_containers(exclude: str = '') -> list[str]:
    """Get running coldstart containers, optionally excluding our own."""
    result = subprocess.run(
        ['docker', 'ps', '--filter', 'name=polis-math-coldstart', '--format', '{{.Names}}'],
        capture_output=True, text=True,
    )
    return [name for name in result.stdout.splitlines() if name and name != exclude]


def ensure_math_workers_paused() -> None:
    """Pause math workers if running, using a marker file for coordination.

    Multiple concurrent coldstart runs coordinate via the marker file:
    - First run to find workers running pauses them and creates the marker.
    - Subsequent runs see workers already paused; they check the marker to
      confirm it was us (not a manual user pause) and proceed.

    The marker is only created if this run actually transitions at least one
    container from running→paused, so a user's manual pause that happens to
    overlap with our startup won't be later unpaused as if we owned it.
    """
    workers = get_running_math_workers()
    if not workers:
        return  # Nothing running (either already paused or not started)

    click.echo(f"Pausing {len(workers)} running math worker(s) to prevent conflicts...")
    for container in workers:
        click.echo(f"  Pausing {container}...")
        result = subprocess.run(
            ['docker', 'pause', container],
            capture_output=True, text=True,
        )
        if result.returncode != 0:
            # Abort rather than leave the system in an inconsistent state
            # (e.g. a marker pointing at a container we didn't actually pause).
            raise click.ClickException(
                f"Failed to pause container {container}: "
                f"{result.stderr.strip() or 'unknown error'}"
            )

    # Re-query to confirm at least one of the workers we listed is now
    # actually paused as a result of this run, and only then create the
    # marker. Without this check, a narrow race (user manually pauses
    # between `docker ps` and `docker pause`) could result in a marker
    # pointing at a user-paused container that we'd later unpause.
    paused_after = subprocess.run(
        ['docker', 'ps', '--filter', 'name=math', '--filter', 'status=paused',
         '--format', '{{.Names}}'],
        capture_output=True, text=True,
    )
    newly_paused = [
        name for name in paused_after.stdout.splitlines()
        if name and 'coldstart' not in name and name in workers
    ]
    if not newly_paused:
        click.echo(
            "  ⚠ No containers transitioned to paused; skipping marker."
        )
        return

    PAUSE_MARKER.touch()
    click.echo(f"  ✓ Paused {len(newly_paused)} container(s)")


def maybe_unpause_math_workers(own_container: str) -> None:
    """Unpause math workers if we're the last coldstart run and we caused the pause.

    Checks two conditions before unpausing:
    1. No other coldstart containers are still running (we're the last one).
    2. The pause marker file exists (we caused the pause, not the user).
    """
    if not PAUSE_MARKER.exists():
        return  # Pause wasn't caused by us

    siblings = get_running_coldstart_containers(exclude=own_container)
    if siblings:
        click.echo(f"\n  Skipping math worker unpause ({len(siblings)} other coldstart run(s) still active)")
        return

    # We're the last one — unpause and clean up marker
    result = subprocess.run(
        ['docker', 'ps', '--filter', 'name=math', '--filter', 'status=paused', '--format', '{{.Names}}'],
        capture_output=True, text=True,
    )
    paused = [name for name in result.stdout.splitlines() if name and 'coldstart' not in name]

    if paused:
        click.echo(f"\nResuming {len(paused)} paused math worker(s)...")
        for container in paused:
            click.echo(f"  Resuming {container}...")
            subprocess.run(['docker', 'unpause', container], capture_output=True)
        click.echo(f"  ✓ Resumed {len(paused)} container(s)")

    PAUSE_MARKER.unlink(missing_ok=True)


def stop_poller_container(process: subprocess.Popen, container_name: str) -> None:
    """Stop a poller process and force-remove its container."""
    if process.poll() is None:
        click.echo("\n  Stopping poller...")
        process.terminate()
        try:
            process.wait(timeout=10)
        except subprocess.TimeoutExpired:
            process.kill()
    # Force-remove the container in case --rm didn't clean it up
    subprocess.run(['docker', 'rm', '-f', container_name], capture_output=True)


def get_db_connection():
    """Create a connection to the Postgres database.

    Uses DATABASE_URL from env / dotenv. When running host-side (not in Docker),
    DATABASE_URL may contain 'host.docker.internal' which needs translating to
    'localhost' for the psycopg2 connection.
    """
    database_url = os.environ.get('DATABASE_URL')
    if not database_url:
        raise ValueError(
            "DATABASE_URL environment variable is not set. "
            "Please set it in the main polis/.env file."
        )
    # When running host-side, translate Docker-internal hostname to localhost
    host_url = database_url.replace('host.docker.internal', 'localhost')
    return psycopg2.connect(host_url)


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


def copy_participants(conn, source_zid: int, fake_zid: int) -> int:
    """Copy participants from source to fake conversation.

    Required because comments have a FK constraint on (zid, pid) -> participants.
    """
    cursor = conn.cursor()
    cursor.execute("""
        INSERT INTO participants (zid, pid, uid, created)
        SELECT %s, pid, uid, created
        FROM participants
        WHERE zid = %s
    """, (fake_zid, source_zid))
    count = cursor.rowcount
    conn.commit()
    cursor.close()
    return count


def copy_comments_with_fresh_timestamps(conn, source_zid: int, fake_zid: int) -> int:
    """Copy comments from source to fake conversation with fresh modified timestamps.

    The Clojure mod-poller queries comments WHERE modified > last_mod_timestamp,
    so fresh timestamps ensure moderation data is picked up. Without comments,
    the poller has no mod-in set, causing all tids to be filtered out and PCA to
    fail with 'nil has zero dimensionality'.

    The tid_auto trigger auto-assigns tids, so we disable triggers for this
    session only (using session_replication_role) to preserve original tids.
    This is safe for concurrent use — only affects the current DB session.
    """
    cursor = conn.cursor()
    now_ms = int(time.time() * 1000)

    # Disable triggers for this session only (safe for concurrent use)
    cursor.execute("SET session_replication_role = 'replica'")

    try:
        cursor.execute("""
            INSERT INTO comments (zid, tid, pid, txt, created, velocity, mod, active,
                                  modified, uid, anon, is_seed, curation, is_meta)
            SELECT %s, tid, pid, txt, created, velocity, mod, active,
                   %s, uid, anon, is_seed, curation, is_meta
            FROM comments
            WHERE zid = %s
        """, (fake_zid, now_ms, source_zid))
        count = cursor.rowcount
        conn.commit()
    finally:
        # Restore normal trigger behavior for this session
        cursor.execute("SET session_replication_role = 'origin'")
        conn.commit()

    cursor.close()
    return count


def copy_votes_with_fresh_timestamps(conn, source_zid: int, fake_zid: int) -> int:
    """
    Copy votes from source conversation to fake conversation with fresh timestamps.

    Copies the FULL vote history, including revotes (multiple rows for the same
    (pid, tid) pair). An earlier version deduplicated with
    ``DISTINCT ON (pid, tid) ... ORDER BY created DESC`` ("keep the latest"),
    which silently dropped superseded revote rows (vw: 128 of 4683). That made
    the Clojure reference consume a DIFFERENT input than the Python side (which
    feeds every CSV row and lets the engine's later-vote-wins merge resolve
    revotes), and it erases the revote dynamics that sequential replay
    specifically needs (see REPLAY_HARNESS_DESIGN.md §5: "Do NOT dedup
    revotes"). Both engines implement later-vote-wins internally, so the dedup
    was never necessary for correctness of the final matrix — only harmful for
    input parity.

    Preserves vote ORDER by using sequential timestamps starting from now
    (10 ms apart, strictly increasing, so Clojure's later-vote-wins resolves
    revotes in source order). Source order is ``created ASC`` with ``ctid`` as
    a tiebreak: for revotes of the same (pid, tid) sharing the same source
    millisecond, physical row order approximates insertion order (the table is
    append-only); the true relative order of same-ms revotes is ambiguous in
    the source data itself.

    The poller finds votes by ``created > last_poll_timestamp``, so fresh
    timestamps ensure these votes are picked up. Uses a single
    INSERT ... SELECT for efficiency (no Python roundtrips).

    Returns the number of votes copied.
    """
    cursor = conn.cursor()

    # Get current time in milliseconds (matching Polis schema)
    now_ms = int(time.time() * 1000)

    # Single INSERT ... SELECT with ROW_NUMBER() to generate sequential timestamps
    # This is much faster than executemany for large vote counts
    cursor.execute("""
        INSERT INTO votes (zid, pid, tid, vote, weight_x_32767, created)
        SELECT
            %s,
            pid,
            tid,
            vote,
            weight_x_32767,
            %s + (ROW_NUMBER() OVER (ORDER BY created ASC, ctid ASC) - 1) * 10
        FROM votes
        WHERE zid = %s
        ORDER BY created ASC, ctid ASC
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

    # comments (before participants due to FK)
    cursor.execute("DELETE FROM comments WHERE zid = %s", (fake_zid,))
    if cursor.rowcount > 0:
        cleanup_stats['comments'] = cursor.rowcount

    # participants
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


def run_poller_for_zid(fake_zid: int, timeout_seconds: int = 300, verbose: bool = False) -> tuple[subprocess.Popen, PollerMonitor, str]:
    """
    Start the Clojure poller restricted to process only the fake zid.

    Returns tuple of (Popen process handle, PollerMonitor, container name).
    """
    # Use MATH_ZID_ALLOWLIST to only process our fake conversation
    # This speeds things up significantly and avoids touching other conversations
    log_level = 'debug' if verbose else 'info'
    container_name = f'polis-math-coldstart-{fake_zid}'
    cmd = [
        'docker', 'compose', 'run', '--rm',
        '--name', container_name,
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

    return process, monitor, container_name


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
    container_name = None

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
        poller_process, poller_monitor, container_name = run_poller_for_zid(fake_zid, timeout_seconds)

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
        if poller_process and container_name:
            stop_poller_container(poller_process, container_name)


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

    # Pause any running math workers to prevent them from processing our
    # fake conversation's votes. Coordinated with other coldstart runs via
    # marker file — only the last run to finish will unpause.
    ensure_math_workers_paused()

    fake_zid = None
    poller_process = None
    container_name = None

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
        click.echo("\n[1/6] Creating temporary conversation...")
        fake_zid = create_fake_conversation(conn, source_zid)
        click.echo(f"  ✓ Created temporary conversation with zid {fake_zid}")

        # Copy participants (required by comments FK constraint)
        click.echo("\n[2/6] Copying participants...")
        copied_participants = copy_participants(conn, source_zid, fake_zid)
        click.echo(f"  ✓ Copied {copied_participants} participants")

        # Copy comments with fresh timestamps (required for moderation data)
        click.echo("\n[3/6] Copying comments with fresh timestamps...")
        copied_comments = copy_comments_with_fresh_timestamps(conn, source_zid, fake_zid)
        click.echo(f"  ✓ Copied {copied_comments} comments")

        # Copy votes
        click.echo("\n[4/6] Copying votes with fresh timestamps...")
        copied_votes = copy_votes_with_fresh_timestamps(conn, source_zid, fake_zid)
        click.echo(f"  ✓ Copied {copied_votes} votes")

        # Run poller
        click.echo("\n[5/6] Running Clojure poller...")
        poller_process, poller_monitor, container_name = run_poller_for_zid(fake_zid, timeout_seconds, verbose=verbose)

        # Wait for computation
        click.echo("\n[6/6] Waiting for math computation...")
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
        # Stop and remove our poller container
        if poller_process and container_name:
            stop_poller_container(poller_process, container_name)

        # Always clean up temporary conversation data
        if fake_zid is not None:
            if no_cleanup:
                click.echo(f"\n⚠ Skipping cleanup (--no-cleanup flag). Temporary zid: {fake_zid}")
            else:
                click.echo(f"\nCleaning up temporary data for zid {fake_zid}...")
                cleanup_stats = cleanup_fake_conversation(conn, fake_zid)
                click.echo(f"  ✓ Cleaned up: {cleanup_stats}")

        conn.close()

        # Unpause math workers if we're the last coldstart run
        maybe_unpause_math_workers(container_name or '')


@click.command()
@click.argument('datasets', nargs=-1)
@click.option('--all', 'process_all', is_flag=True, help='Process all datasets')
@click.option('--include-local', is_flag=True, default=False, help='Include datasets from real_data/.local/')
@click.option('--no-cleanup', is_flag=True, help='Do not cleanup temporary conversation (for debugging)')
@click.option('--timeout', default=300, help='Timeout in seconds for math computation (default: 300)')
@click.option('--verbose', '-v', is_flag=True, help='Show detailed output including Clojure poller logs')
def main(datasets: tuple, process_all: bool, include_local: bool, no_cleanup: bool, timeout: int, verbose: bool):
    """
    Generate cold-start Clojure math blobs for fair Python comparison.

    This script creates a temporary conversation in the database (replaying
    votes from the source), and runs the Clojure poller to compute a true
    cold-start math blob.

    Each dataset gets its own isolated Clojure poller container (restricted
    via MATH_ZID_ALLOWLIST). If a math worker is already running, it is
    automatically paused to prevent it from racing on the temporary
    conversation's votes. Multiple concurrent runs coordinate via a marker
    file — only the last run to finish unpauses the math worker, and only
    if it was paused by us (not manually by the user).

    Examples:

        # Generate for single dataset
        python scripts/generate_cold_start_clojure.py biodiversity

        # Generate for multiple datasets
        python scripts/generate_cold_start_clojure.py biodiversity vw american-assembly

        # Generate for all committed datasets
        python scripts/generate_cold_start_clojure.py --all

        # Generate for all datasets including .local/
        python scripts/generate_cold_start_clojure.py --all --include-local

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
        pass  # Pause/unpause is handled per-dataset in generate_cold_start_for_dataset


if __name__ == '__main__':
    main()
