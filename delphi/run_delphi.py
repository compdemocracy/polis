#!/usr/bin/env python3
import argparse
import os
import subprocess
import sys

# Define colors for output
GREEN = '\033[0;32m'
YELLOW = '\033[0;33m'
RED = '\033[0;31m'
NC = '\033[0m' # No Color

def show_usage():
    print("Process a Polis conversation with the Delphi analytics pipeline.")
    print()
    print("Usage: ./run_delphi.py --zid=CONVERSATION_ID [options]")
    print()
    print("Required arguments:")
    print("  --zid=CONVERSATION_ID     The Polis conversation ID to process")
    print()
    print("Optional arguments:")
    print("  --rid=REPORT_ID           (Optional) The report ID for full narrative cleanup")
    print("  --verbose                 Show detailed logs")
    print("  --force                   Force reprocessing even if data exists")
    print("  --validate                Run extra validation checks")
    print("  --help                    Show this help message")

def _v2_mark_run_started(job_id, zid, rid):
    """Create/mark the v2 run manifest (module-level so tests can stub it)."""
    from delphi_storage import get_store
    from delphi_storage.manifest import ensure_run, mark_running

    store = get_store()
    # rid is the ALPHANUMERIC public report id (r...) in this pipeline —
    # recorded verbatim; numeric rid resolution belongs to P7d.
    ensure_run(
        store,
        job_id=job_id,
        job_type="FULL_PIPELINE",
        zid=int(zid),
        config_requested={"report_id": str(rid)} if rid else None,
    )
    mark_running(store, job_id)


def _v2_mark_run_finished(job_id, success):
    from delphi_storage import get_store
    from delphi_storage.manifest import mark_completed, mark_failed

    store = get_store()
    if success:
        mark_completed(store, job_id)
    else:
        mark_failed(store, job_id, error="run_delphi pipeline failed")


def _capture_run_inputs(job_id, zid, rid):
    """Snapshot inputs into the V2 store (module-level so tests can stub it)."""
    from delphi_storage import get_store
    from delphi_storage.inputs import capture_run_inputs

    store = get_store()
    fingerprints = capture_run_inputs(store, job_id, zid, rid=rid)
    for kind, fingerprint in fingerprints.items():
        print(f"{YELLOW}Snapshotted {kind}: {fingerprint}{NC}")
    try:
        from delphi_storage.manifest import record_input_fingerprints

        record_input_fingerprints(store, job_id, fingerprints)
    except Exception as e:
        # No manifest exists for a bare --snapshot-inputs run in old mode.
        print(f"{YELLOW}Fingerprints not recorded on a manifest: {e}{NC}")


def main():
    parser = argparse.ArgumentParser(description="Process a Polis conversation with the Delphi analytics pipeline.", add_help=False)
    parser.add_argument("--zid", required=True, help="The Polis conversation ID to process")
    parser.add_argument("--rid", required=False, help="The report ID, if available, for full narrative cleanup.")
    parser.add_argument("--verbose", action="store_true", help="Show detailed logs")
    parser.add_argument("--force", action="store_true", help="Force reprocessing even if data exists")
    parser.add_argument("--validate", action="store_true", help="Run extra validation checks")
    parser.add_argument("--help", action="store_true", help="Show this help message")
    parser.add_argument('--include_moderation', type=bool, default=False, help='Whether or not to include moderated comments in reports. If false, moderated comments will appear.')
    parser.add_argument('--exclude_comment_selections', type=bool, default=True, help='Whether to exclude comments with selection=-1 in report_comment_selections table.')
    parser.add_argument('--region', type=str, default='us-east-1', help='AWS region')
    parser.add_argument('--input-source', dest='input_source', default=None,
                        help='Read pipeline inputs from a recorded snapshot instead of live PG: '
                             'store://<job_id> (Storage V2 P6b seam; forwarded to the PG-reading stages)')
    parser.add_argument('--snapshot-inputs', dest='snapshot_inputs', action='store_true',
                        help='Snapshot all pipeline inputs into Delphi Storage V2 at job start '
                             '(also enabled by DELPHI_SNAPSHOT_INPUTS=1; design §4.4/P6)')
    parser.add_argument('--job-id', dest='job_id', default=None,
                        help='Pipeline job id (auto local-<uuid4> when omitted; '
                             'threaded to every stage, see docs/STORAGE_V2_DESIGN.md §4.4)')

    args = parser.parse_args()

    if args.help:
        show_usage()
        sys.exit(0)

    zid = args.zid
    rid = args.rid
    from delphi_storage.job_id import resolve_job_id
    job_id = resolve_job_id(args.job_id)
    # Transition (design §4.4): un-migrated readers still inherit the env var;
    # exporting here keeps them on the SAME id as the command lines below.
    os.environ["DELPHI_JOB_ID"] = job_id
    print(f"{YELLOW}Pipeline job id: {job_id}{NC}")
    verbose_arg = "--verbose" if args.verbose else ""
    force_arg = "--force" if args.force else ""
    # validate_arg is not used in the python script execution steps, but kept for parity with bash
    # validate_arg = "--validate" if args.validate else ""

    explicit_snapshot = args.snapshot_inputs or os.environ.get(
        "DELPHI_SNAPSHOT_INPUTS", ""
    ).lower() in ("1", "true", "yes")
    if explicit_snapshot and args.input_source:
        print(f"{RED}--snapshot-inputs and --input-source are mutually exclusive: "
              f"a run cannot both record fresh inputs and replay recorded ones.{NC}")
        sys.exit(2)

    # Migration write mode (design §4.3): explicit tri-state, fail-loud when
    # unset. old = today's behavior; both/v2 = v2 manifest + input snapshot.
    from delphi_storage.interface import Invalid as _StorageInvalid
    from delphi_storage.write_mode import WriteMode, resolve_write_mode, v2_writes_enabled
    try:
        write_mode = resolve_write_mode()
    except _StorageInvalid as e:
        print(f"{RED}{e}{NC}")
        sys.exit(2)

    # Replays (--input-source) never write manifests/snapshots here — the
    # replay harness (P12) creates its own fresh run.
    v2_active = v2_writes_enabled(write_mode) and not args.input_source
    v2_failures_abort = write_mode is WriteMode.V2

    def _v2_finish(success):
        if not v2_active:
            return
        try:
            _v2_mark_run_finished(job_id, success)
        except Exception as e:
            print(f"{RED}v2 run-finish mirror failed: {e}{NC}")
            if v2_failures_abort and success:
                sys.exit(1)

    if v2_active:
        try:
            _v2_mark_run_started(job_id, zid, rid)
        except Exception as e:
            print(f"{RED}v2 run manifest creation failed: {e}{NC}")
            if v2_failures_abort:
                sys.exit(1)

    if explicit_snapshot or v2_active:
        print(f"{YELLOW}Snapshotting pipeline inputs for job {job_id}...{NC}")
        try:
            _capture_run_inputs(job_id, zid, rid)
            print(f"{GREEN}Input snapshot complete.{NC}")
        except Exception as e:
            if explicit_snapshot or v2_failures_abort:
                # A run without recorded inputs defeats the point when
                # explicitly requested, and v2-only has no old copy to lean on.
                print(f"{RED}Input snapshot failed: {e}. Aborting pipeline.{NC}")
                _v2_finish(False)
                sys.exit(1)
            # both-mode: the old path must keep serving (design §6.1 M1);
            # the divergence is caught by the coverage/verify tooling.
            print(f"{RED}Input snapshot failed: {e}. Continuing (write mode 'both': "
                  f"old path keeps serving; run is marked unreplayable by absence "
                  f"of fingerprints).{NC}")

    # --- Reset all data before processing ---
    print(f"{YELLOW}Resetting all existing data for conversation {zid} before processing...{NC}")
    reset_command = [
        "python",
        "umap_narrative/reset_conversation.py",
        f"--zid={zid}",
        f"--job-id={job_id}",
    ]
    # If a report ID is provided, pass it to the reset script for full cleanup
    if rid:
        reset_command.append(f"--rid={rid}")
        print(f"{YELLOW}Using report ID {rid} for full narrative report cleanup.{NC}")
    
    reset_process = subprocess.run(reset_command)
    if reset_process.returncode != 0:
        print(f"{RED}Data reset failed with exit code {reset_process.returncode}. Aborting pipeline.{NC}")
        _v2_finish(False)
        sys.exit(reset_process.returncode)
    print(f"{GREEN}Data reset complete.{NC}")

    print(f"{GREEN}Processing conversation {zid}...{NC}")

    # Set model
    model = os.environ.get("OLLAMA_MODEL")
    if not model:
        print(f"{RED}Error: OLLAMA_MODEL environment variable not set.{NC}")
        _v2_finish(False)
        sys.exit(1)
    print(f"{YELLOW}Using Ollama model: {model}{NC}")

    # Set up environment for the pipeline
    app_path = os.environ.get('DELPHI_APP_PATH', '/app')
    os.environ["PYTHONPATH"] = f"{app_path}:{os.environ.get('PYTHONPATH', '')}"
    os.environ["OLLAMA_HOST"] = os.environ.get("OLLAMA_HOST", "http://ollama:11434")
    # OLLAMA_MODEL is already set and checked
    max_votes = os.environ.get("MAX_VOTES")
    max_votes_arg = f"--max-votes={max_votes}" if max_votes else ""
    if max_votes:
        print(f"{YELLOW}Limiting to {max_votes} votes for testing{NC}")

    batch_size = os.environ.get("BATCH_SIZE")
    batch_size_arg = f"--batch-size={batch_size}" if batch_size else "--batch-size=50000" # Default batch size
    if batch_size:
        print(f"{YELLOW}Using batch size of {batch_size}{NC}")
    else:
        print(f"{YELLOW}Using batch size of 50000 (default){NC}")


    # Run the math pipeline
    print(f"{GREEN}Running math pipeline...{NC}")
    math_command = [
        "python", f"{app_path}/polismath/run_math_pipeline.py",
        f"--zid={zid}",
        f"--job-id={job_id}",
    ]
    if args.input_source:
        math_command.append(f"--input-source={args.input_source}")
    if max_votes_arg:
        math_command.append(max_votes_arg)
    if batch_size_arg:
        math_command.append(batch_size_arg)

    math_process = subprocess.run(math_command)
    math_exit_code = math_process.returncode

    if math_exit_code != 0:
        print(f"{RED}Math pipeline failed with exit code {math_exit_code}{NC}")
        _v2_finish(False)
        sys.exit(math_exit_code)

    # Run the UMAP narrative pipeline
    print(f"{GREEN}Running UMAP narrative pipeline...{NC}")
    umap_command = [
        "python", f"{app_path}/umap_narrative/run_pipeline.py",
        f"--zid={zid}",
        f"--include_moderation={args.include_moderation}",
        f"--exclude_comment_selections={args.exclude_comment_selections}",
        f"--job-id={job_id}",
        "--use-ollama"
    ]
    if args.input_source:
        umap_command.append(f"--input-source={args.input_source}")
    if verbose_arg:
        umap_command.append(verbose_arg)

    pipeline_process = subprocess.run(umap_command)
    pipeline_exit_code = pipeline_process.returncode

    # Calculate and store comment extremity values
    print(f"{GREEN}Calculating comment extremity values...{NC}")
    extremity_command = [
        "python", f"{app_path}/umap_narrative/501_calculate_comment_extremity.py",
        f"--zid={zid}",
        f"--include_moderation={args.include_moderation}",
        f"--exclude_comment_selections={args.exclude_comment_selections}",
        f"--job-id={job_id}"
    ]
    if args.input_source:
        extremity_command.append(f"--input-source={args.input_source}")
    if verbose_arg:
        extremity_command.append(verbose_arg)
    if force_arg:
        extremity_command.append(force_arg)
    
    extremity_process = subprocess.run(extremity_command)
    extremity_exit_code = extremity_process.returncode

    if extremity_exit_code != 0:
        print(f"{RED}Warning: Extremity calculation failed with exit code {extremity_exit_code}{NC}")
        print("Continuing with priority calculation...")

    # Calculate comment priorities using group-based extremity
    print(f"{GREEN}Calculating comment priorities with group-based extremity...{NC}")
    priority_command = [
        "python", f"{app_path}/umap_narrative/502_calculate_priorities.py",
        f"--conversation_id={zid}",
        f"--job-id={job_id}",
    ]
    if verbose_arg:
        priority_command.append(verbose_arg)
    
    priority_process = subprocess.run(priority_command)
    priority_exit_code = priority_process.returncode

    if priority_exit_code != 0:
        print(f"{RED}Warning: Priority calculation failed with exit code {priority_exit_code}{NC}")
        print("Continuing with visualization...")

    if pipeline_exit_code == 0:
        print(f"{YELLOW}Creating visualizations with datamapplot...{NC}")

        # Create output directory
        output_dir = f"{app_path}/polis_data/{zid}/python_output/comments_enhanced_multilayer"
        os.makedirs(output_dir, exist_ok=True)

        # Generate visualizations for all available layers
        # First, determine available layers from DynamoDB
        try:
            import boto3
            from boto3.dynamodb.conditions import Key
            
            raw_endpoint = os.environ.get('DYNAMODB_ENDPOINT')
            endpoint_url = raw_endpoint if raw_endpoint and raw_endpoint.strip() else None
            
            # Using dummy credentials for local, IAM role for AWS
            if endpoint_url:
                dynamodb = boto3.resource('dynamodb', 
                                         endpoint_url=endpoint_url, 
                                         region_name='us-east-1',
                                         aws_access_key_id='dummy',
                                         aws_secret_access_key='dummy')
            else:
                dynamodb = boto3.resource('dynamodb', region_name=args.region)


            table = dynamodb.Table('Delphi_CommentHierarchicalClusterAssignments')
            
            available_layers = set()
            last_key = None

            print(f"{YELLOW}Querying all items to discover available layers...{NC}")
            while True:
                query_kwargs = {
                    'KeyConditionExpression': Key('conversation_id').eq(str(zid))
                }
                if last_key:
                    query_kwargs['ExclusiveStartKey'] = last_key
                
                response = table.query(**query_kwargs)

                for item in response.get('Items', []):
                    for key, value in item.items():
                        if key.startswith('layer') and key.endswith('_cluster_id') and value is not None:
                            try:
                                layer_num = int(key.replace('layer', '').replace('_cluster_id', ''))
                                available_layers.add(layer_num)
                            except ValueError:
                                continue 
                
                last_key = response.get('LastEvaluatedKey')
                if not last_key:
                    break
            
            available_layers = sorted(list(available_layers))
            if not available_layers:
                 raise ValueError("No valid layers found for this conversation.")
                 
            print(f"{YELLOW}Discovered layers: {available_layers}{NC}")
            
        except Exception as e:
            print(f"{RED}Warning: Could not determine layers from DynamoDB: {e}{NC}")
            print(f"{YELLOW}Falling back to layer 0 only{NC}")
            available_layers = [0]
        
        # Generate visualization for each available layer
        for layer_id in available_layers:
            print(f"{YELLOW}Generating visualization for layer {layer_id}...{NC}")
            datamap_command = [
                "python", f"{app_path}/umap_narrative/700_datamapplot_for_layer.py",
                f"--conversation_id={zid}",
                f"--layer={layer_id}",
                f"--output_dir={output_dir}",
                f"--job-id={job_id}"
            ]
            if verbose_arg:
                datamap_command.append(verbose_arg)
            
            result = subprocess.run(datamap_command)
            if result.returncode == 0:
                print(f"{GREEN}Layer {layer_id} visualization completed{NC}")
            else:
                print(f"{RED}Warning: Layer {layer_id} visualization failed{NC}")

        print(f"{GREEN}UMAP Narrative pipeline completed successfully!{NC}")
        print(f"Results stored in DynamoDB and visualizations for conversation {zid}")
    else:
        print(f"{RED}Warning: UMAP Narrative pipeline returned non-zero exit code: {pipeline_exit_code}{NC}")
        print("The pipeline may have encountered errors but might still have produced partial results.")
        # Don't fail the overall script, just warn
        pipeline_exit_code = 0


    exit_code = pipeline_exit_code # Based on the logic, this will be 0 unless math pipeline failed earlier

    if exit_code == 0: # This condition relies on math_exit_code check above.
        print(f"{GREEN}Pipeline completed successfully!{NC}")
        print(f"Results stored in DynamoDB for conversation {zid}")
    else:
        # This part of the logic seems unreachable given the sys.exit() after math_pipeline failure
        # and resetting pipeline_exit_code to 0 in the warning case.
        # However, keeping it for structural parity.
        print(f"{RED}Pipeline failed with exit code {exit_code}{NC}")
        print("Please check logs for more details")

    _v2_finish(exit_code == 0)
    sys.exit(exit_code)

if __name__ == "__main__":
    main()