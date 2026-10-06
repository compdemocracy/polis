#!/usr/bin/env python3
import argparse
import os
import subprocess
import sys

from polismath.utils.cli_flags import parse_bool_flag

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

# Exit code run_math_pipeline.py uses when the math was computed but its
# DynamoDB export failed. Before this code existed that case exited 0, so the
# later stages still run exactly as they did; only the job's status changes.
MATH_EXPORT_FAILED_EXIT_CODE = 4


# --- run by the polis-jobs daemon (P-077 P1) --------------------------------
# Active only when DELPHI_OUTPUT_MANIFEST is set. The legacy DynamoDB poller
# never sets it, so on that path none of these functions is called and nothing
# new is imported or printed.

def _start_daemon_job(zid):
    """Check the daemon's environment and frame, and observe the run's inputs, before any stage runs."""
    from polismath import job_child
    from polismath.job_child import census

    try:
        job = job_child.JobContext.from_env(
            expected_stage=job_child.STAGE_FULL_PIPELINE, zid=zid,
            allowed_phases={job_child.PHASE_RUN}, default_phase=job_child.PHASE_RUN,
        )
    except job_child.JobEnvError as e:
        job_child.refuse(str(e))
    try:
        job.inputs = census.observe_inputs(zid, job_child.effective_math_env(), census.default_pg_query())
    except census.CensusError as e:
        print(f"polis-jobs child: {e}", file=sys.stderr, flush=True)
        sys.exit(job_child.EXIT_MANIFEST_UNBUILDABLE)
    return job


def _topic_model_name():
    if os.environ.get("LLM_PROVIDER", "anthropic").lower() == "ollama":
        return os.environ.get("OLLAMA_MODEL") or None
    return (os.environ.get("ANTHROPIC_TOPIC_MODEL") or os.environ.get("ANTHROPIC_MODEL")
            or "claude-haiku-4-5-20251001")


def _finish_daemon_job(job, zid, region):
    """Count what the run wrote and write the output manifest; exit 5 if that cannot be done."""
    from polismath import job_child
    from polismath.job_child import census

    try:
        outputs = census.count_full_pipeline_outputs(zid, census.default_dynamodb(region))
        manifest = job_child.build_manifest(
            job, outcome="succeeded", inputs=job.inputs, outputs=outputs,
            models={
                "embed": os.environ.get("SENTENCE_TRANSFORMER_MODEL", "all-MiniLM-L6-v2"),
                "topic": _topic_model_name(),
                "narrative": None,
            },
            # Topic naming's provider batches are submitted and awaited inside
            # the UMAP stage; P1 does not observe them, so cost stays unknown.
            cost={"llm_tokens_in": None, "llm_tokens_out": None, "provider_batches": None},
        )
        job_child.write_manifest(job, manifest)
    except (census.CensusError, job_child.ManifestError, OSError) as e:
        print(f"polis-jobs child: the stages succeeded but the manifest could not be written: {e}",
              file=sys.stderr, flush=True)
        sys.exit(job_child.EXIT_MANIFEST_UNBUILDABLE)


def main():
    parser = argparse.ArgumentParser(description="Process a Polis conversation with the Delphi analytics pipeline.", add_help=False)
    parser.add_argument("--zid", required=True, help="The Polis conversation ID to process")
    parser.add_argument("--rid", required=False, help="The report ID, if available, for full narrative cleanup.")
    parser.add_argument("--verbose", action="store_true", help="Show detailed logs")
    parser.add_argument("--force", action="store_true", help="Force reprocessing even if data exists")
    parser.add_argument("--validate", action="store_true", help="Run extra validation checks")
    parser.add_argument("--help", action="store_true", help="Show this help message")
    parser.add_argument('--include_moderation', type=parse_bool_flag, default=False, help='Whether or not to include moderated comments in reports. If false, moderated comments will appear.')
    parser.add_argument('--exclude_comment_selections', type=parse_bool_flag, default=True, help='Whether to exclude comments with selection=-1 in report_comment_selections table.')
    parser.add_argument('--region', type=str, default='us-east-1', help='AWS region')

    args = parser.parse_args()

    if args.help:
        show_usage()
        sys.exit(0)

    zid = args.zid
    rid = args.rid
    job = _start_daemon_job(zid) if os.environ.get("DELPHI_OUTPUT_MANIFEST", "").strip() else None
    verbose_arg = "--verbose" if args.verbose else ""
    force_arg = "--force" if args.force else ""
    # validate_arg is not used in the python script execution steps, but kept for parity with bash
    # validate_arg = "--validate" if args.validate else ""

    app_path = os.environ.get('DELPHI_APP_PATH', '/app')
    os.environ["PYTHONPATH"] = f"{app_path}:{os.environ.get('PYTHONPATH', '')}"

    # --- The database must declare its stored vote sign (P-078) ---
    # Checked here, before the reset below removes anything: a job launched
    # directly, or by an older poller that never checked at boot, refuses
    # with nothing changed. The check script exits 1 with the operator message.
    convention_check = subprocess.run(["python", f"{app_path}/polismath/check_vote_convention.py"])
    if convention_check.returncode != 0:
        print(f"{RED}Vote convention check failed with exit code {convention_check.returncode}. "
              f"Nothing has been reset or changed. Aborting pipeline.{NC}")
        sys.exit(1 if job is not None else convention_check.returncode)

    # --- Reset all data before processing ---
    print(f"{YELLOW}Resetting all existing data for conversation {zid} before processing...{NC}")
    reset_command = [
        "python",
        "umap_narrative/reset_conversation.py",
        f"--zid={zid}",
    ]
    # If a report ID is provided, pass it to the reset script for full cleanup
    if rid:
        reset_command.append(f"--rid={rid}")
        print(f"{YELLOW}Using report ID {rid} for full narrative report cleanup.{NC}")
    
    reset_process = subprocess.run(reset_command)
    if reset_process.returncode != 0:
        print(f"{RED}Data reset failed with exit code {reset_process.returncode}. Aborting pipeline.{NC}")
        # Under the daemon the exit-code set is closed (0/1/2/4/5/6): any other failure is 1.
        sys.exit(1 if job is not None else reset_process.returncode)
    print(f"{GREEN}Data reset complete.{NC}")

    print(f"{GREEN}Processing conversation {zid}...{NC}")

    # Select the topic-naming provider. Default is Anthropic (via the Batch API);
    # OLLAMA_MODEL / OLLAMA_HOST are only required for a self-hosted Ollama setup.
    llm_provider = os.environ.get("LLM_PROVIDER", "anthropic").lower()
    if llm_provider == "ollama":
        model = os.environ.get("OLLAMA_MODEL")
        if not model:
            print(f"{RED}Error: LLM_PROVIDER=ollama but OLLAMA_MODEL is not set.{NC}")
            sys.exit(1)
        os.environ["OLLAMA_HOST"] = os.environ.get("OLLAMA_HOST", "http://ollama:11434")
        print(f"{YELLOW}Using Ollama model: {model} at {os.environ['OLLAMA_HOST']}{NC}")
    else:
        topic_model = (
            os.environ.get("ANTHROPIC_TOPIC_MODEL")
            or os.environ.get("ANTHROPIC_MODEL")
            or "claude-haiku-4-5-20251001"
        )
        print(f"{YELLOW}Using {llm_provider} topic model: {topic_model}{NC}")

    # Set up environment for the pipeline
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
    ]
    if max_votes_arg:
        math_command.append(max_votes_arg)
    if batch_size_arg:
        math_command.append(batch_size_arg)

    # Every stage that fails is recorded here. Stages after a failure still run
    # as before, but the run exits non-zero so the job is marked FAILED rather
    # than COMPLETED.
    failed_stages = []

    math_process = subprocess.run(math_command)
    math_exit_code = math_process.returncode

    if math_exit_code == MATH_EXPORT_FAILED_EXIT_CODE:
        print(f"{RED}Math pipeline computed but its DynamoDB export failed (exit code {math_exit_code}){NC}")
        failed_stages.append(("math export", math_exit_code))
    elif math_exit_code != 0:
        print(f"{RED}Math pipeline failed with exit code {math_exit_code}{NC}")
        sys.exit(1 if job is not None else math_exit_code)

    # Run the UMAP narrative pipeline
    print(f"{GREEN}Running UMAP narrative pipeline...{NC}")
    umap_command = [
        "python", f"{app_path}/umap_narrative/run_pipeline.py",
        f"--zid={zid}",
        f"--include_moderation={args.include_moderation}",
        f"--exclude_comment_selections={args.exclude_comment_selections}",
        "--name-topics"
    ]
    if verbose_arg:
        umap_command.append(verbose_arg)

    pipeline_process = subprocess.run(umap_command)
    pipeline_exit_code = pipeline_process.returncode
    if pipeline_exit_code != 0:
        failed_stages.append(("UMAP narrative pipeline", pipeline_exit_code))

    # Calculate and store comment extremity values
    print(f"{GREEN}Calculating comment extremity values...{NC}")
    extremity_command = [
        "python", f"{app_path}/umap_narrative/501_calculate_comment_extremity.py",
        f"--zid={zid}",
        f"--include_moderation={args.include_moderation}",
        f"--exclude_comment_selections={args.exclude_comment_selections}"
    ]
    if verbose_arg:
        extremity_command.append(verbose_arg)
    if force_arg:
        extremity_command.append(force_arg)
    
    extremity_process = subprocess.run(extremity_command)
    extremity_exit_code = extremity_process.returncode

    if extremity_exit_code != 0:
        print(f"{RED}Extremity calculation failed with exit code {extremity_exit_code}{NC}")
        print("Continuing with priority calculation...")
        failed_stages.append(("comment extremity", extremity_exit_code))

    # Calculate comment priorities using group-based extremity
    print(f"{GREEN}Calculating comment priorities with group-based extremity...{NC}")
    priority_command = [
        "python", f"{app_path}/umap_narrative/502_calculate_priorities.py",
        f"--conversation_id={zid}",
    ]
    if verbose_arg:
        priority_command.append(verbose_arg)
    
    priority_process = subprocess.run(priority_command)
    priority_exit_code = priority_process.returncode

    if priority_exit_code != 0:
        print(f"{RED}Priority calculation failed with exit code {priority_exit_code}{NC}")
        print("Continuing with visualization...")
        failed_stages.append(("comment priorities", priority_exit_code))

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
                f"--output_dir={output_dir}"
            ]
            if verbose_arg:
                datamap_command.append(verbose_arg)
            
            result = subprocess.run(datamap_command)
            if result.returncode == 0:
                print(f"{GREEN}Layer {layer_id} visualization completed{NC}")
            else:
                print(f"{RED}Layer {layer_id} visualization failed with exit code {result.returncode}{NC}")
                failed_stages.append((f"layer {layer_id} visualization", result.returncode))

        print(f"{GREEN}UMAP Narrative pipeline stage finished.{NC}")
    else:
        print(f"{RED}UMAP Narrative pipeline failed with exit code {pipeline_exit_code}; skipping visualizations.{NC}")

    if not failed_stages:
        print(f"{GREEN}Pipeline completed successfully!{NC}")
        print(f"Results stored in DynamoDB for conversation {zid}")
        if job is not None:
            _finish_daemon_job(job, zid, args.region)
        sys.exit(0)

    summary = ", ".join(f"{name} (exit code {code})" for name, code in failed_stages)
    print(f"{RED}Pipeline failed: {len(failed_stages)} stage(s) failed: {summary}{NC}")
    print("Please check logs for more details")
    if job is not None and any(name == "math export" for name, _ in failed_stages):
        # The daemon records this as stage_failed:math_export (P-077 P1 spec 1.3).
        sys.exit(MATH_EXPORT_FAILED_EXIT_CODE)
    sys.exit(1)

if __name__ == "__main__":
    main()