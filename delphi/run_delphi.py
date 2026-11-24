#!/usr/bin/env python3
import argparse
import os
import shutil
import signal
import subprocess
import sys
import tempfile
import uuid

from polismath import step_log
from polismath.utils.cli_flags import parse_bool_flag

# Two switches, both off unless set to exactly "1"; off, a run is what it was.
#
# DELPHI_SKIP_DATAMAPPLOT=1: the run writes no visualization page. The
# per-layer datamapplot step (700_datamapplot_for_layer.py, which uploads each
# page, comment text included, to the S3 bucket) is not started, and the UMAP
# stage writes none of its local layer pages either. Every result family is
# still written; only the pages are left out.
SKIP_DATAMAPPLOT = "DELPHI_SKIP_DATAMAPPLOT"
# DELPHI_LOCAL_OUTPUT_CLEANUP=1: when the run ends, however it ends, the files
# the stages wrote for this conversation under polis_data/<zid> and
# visualizations/<zid> (below the app directory and the working directory) are
# removed, so repeated runs leave nothing behind on the container's disk.
LOCAL_OUTPUT_CLEANUP = "DELPHI_LOCAL_OUTPUT_CLEANUP"


def switch_on(name):
    """True exactly when the environment variable is the string "1"."""
    return os.environ.get(name, "").strip() == "1"


def local_output_dirs(zid, app_path):
    """The directories a run writes for one conversation on the local disk."""
    z = str(int(zid))  # a conversation id is an integer; nothing else names a path here
    roots = []
    for base in (app_path, os.getcwd()):
        real = os.path.realpath(base)
        if real not in roots:
            roots.append(real)
    return [os.path.join(root, sub, z) for root in roots for sub in ("polis_data", "visualizations")]


def remove_local_outputs(zid, app_path):
    for path in local_output_dirs(zid, app_path):
        shutil.rmtree(path, ignore_errors=True)

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

# The stages, in order: the reset, the UMAP narrative pipeline (embeddings with
# granite-embedding-311m-multilingual-r2 at 384 dimensions, UMAP, EVoC
# clustering, keywords, topic names), then one datamapplot visualisation per
# layer.
#
# A run does not compute its own math. The PCA, k-means, representativeness,
# participant projections and comment routing of polismath/run_math_pipeline.py,
# the group extremity of 501 and the priorities of 502 are not stages: the math
# engine's math_main is the one source of that math, the narrative filters read
# the engine's pca.comment-extremity themselves (801_narrative_report_batch.py),
# and nothing read the families those stages wrote. So a run reads no votes and
# no math_main beyond the input census taken before the first stage.


# --- run by the polis-jobs daemon (P-077 P1) --------------------------------
# Active only when DELPHI_OUTPUT_MANIFEST is set. The legacy DynamoDB poller
# never sets it, so on that path none of these functions is called and nothing
# new is imported or printed.

def _start_daemon_job(zid):
    """Check the daemon's environment and frame, and observe the run's inputs, before any stage runs."""
    from polismath import job_child
    from polismath.job_child import census, input_bundle

    try:
        job = job_child.JobContext.from_env(
            expected_stage=job_child.STAGE_FULL_PIPELINE, zid=zid,
            allowed_phases={job_child.PHASE_RUN}, default_phase=job_child.PHASE_RUN,
        )
        # The input bundle, when the frame names one: the stages read its files
        # instead of Postgres. A bundle that fails its checks refuses the run.
        bundle = input_bundle.load(zid)
    except (job_child.JobEnvError, input_bundle.BundleError) as e:
        job_child.refuse(str(e))
    try:
        if bundle is not None:
            job.inputs = census.observe_inputs_from_bundle(bundle, job_child.effective_math_env())
        else:
            job.inputs = census.observe_inputs(zid, job_child.effective_math_env(), census.default_pg_query())
    except census.CensusError as e:
        print(f"polis-jobs child: {e}", file=sys.stderr, flush=True)
        sys.exit(job_child.EXIT_MANIFEST_UNBUILDABLE)
    return job


def _finish_daemon_job(job, zid, region, naming=None):
    """Count what the run wrote and write the output manifest; exit 5 if that cannot be done.
    ``naming`` is how the naming of a run given --namer ended (None for every
    other run, whose manifest is what it was)."""
    from polismath import embedding_model, job_child
    from polismath.job_child import census

    try:
        outputs = census.count_full_pipeline_outputs(zid, census.default_dynamodb(region))
        manifest = job_child.build_manifest(
            job, outcome="succeeded", inputs=job.inputs, outputs=outputs,
            # The embedding model run_pipeline.py loaded (repo@revision:384),
            # the topic model, and the clustering (UMAP and EVoC, default seed).
            models=job_child.full_pipeline_models() if naming is None else job_child.full_pipeline_models(naming),
            # Topic naming's provider batches are submitted and awaited inside
            # the UMAP stage; P1 does not observe them, so cost stays unknown.
            # A run given --namer counts the tokens of its one naming call.
            cost=({"llm_tokens_in": None, "llm_tokens_out": None, "provider_batches": None}
                  if naming is None else job_child.naming_cost(naming)),
        )
        job_child.write_manifest(job, manifest)
    except (census.CensusError, job_child.ManifestError, embedding_model.ModelMismatch, OSError) as e:
        print(f"polis-jobs child: the stages succeeded but the manifest could not be written: {e}",
              file=sys.stderr, flush=True)
        sys.exit(job_child.EXIT_MANIFEST_UNBUILDABLE)


def namer_scratch_path():
    """Where a run given --namer keeps its naming's scratch files (not yet
    made). Under the job daemon it is inside the attempt directory that holds
    DELPHI_OUTPUT_MANIFEST: the daemon removes that directory once it has
    reaped this process group, however the run ended (a timeout, a fence,
    SIGKILL), so nothing is left behind even where no finally runs. Otherwise
    a new name in the temporary directory, removed by this run."""
    manifest = os.environ.get("DELPHI_OUTPUT_MANIFEST", "").strip()
    parent = os.path.dirname(os.path.abspath(manifest)) if manifest else tempfile.gettempdir()
    return os.path.join(parent, f"delphi-topic-names-{uuid.uuid4().hex}")


def _exit_on_sigterm(signum, frame):
    # A terminated run still runs its finally (the naming's scratch is removed).
    raise SystemExit(128 + signum)


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
    from polismath.selection import SELECTIONS
    parser.add_argument('--selection', choices=SELECTIONS, default=None, help='Embed every comment and lay out, cluster and name only those this selection keeps (the Delphi shadow passes participant_visible/1). Absent, the run is what it was.')

    parser.add_argument('--namer', default=None, help='Name the topics with a model (umap_narrative/topic_namer.py): a JSON object of model, prompt and thinking. Only with --selection=participant_visible/1. Absent, the run is what it was.')

    args = parser.parse_args()

    if args.help:
        show_usage()
        sys.exit(0)

    args.namer_dir = None
    if args.namer is not None:
        from umap_narrative import topic_namer
        try:
            args.namer = topic_namer.parse_namer(args.namer)
            topic_namer.check_selection(args.namer, args.selection)
        except topic_namer.NamerRefused as e:
            parser.error(f"--namer refused: {e}")
        # This attempt's directory for the naming's files. The naming step
        # makes it (a failure to is a naming outcome, never a failed run);
        # this run removes it when it ends, and on SIGTERM too.
        args.namer_dir = namer_scratch_path()
        signal.signal(signal.SIGTERM, _exit_on_sigterm)

    try:
        with step_log.step("run"):
            run(args)
    finally:
        if args.namer_dir is not None:
            shutil.rmtree(args.namer_dir, ignore_errors=True)
        if switch_on(LOCAL_OUTPUT_CLEANUP):
            remove_local_outputs(args.zid, os.environ.get('DELPHI_APP_PATH', '/app'))


def run(args):
    zid = args.zid
    rid = args.rid
    job = None
    if os.environ.get("DELPHI_OUTPUT_MANIFEST", "").strip():
        with step_log.step("census"):
            job = _start_daemon_job(zid)
    verbose_arg = "--verbose" if args.verbose else ""
    # --force and --validate are accepted for compatibility; no stage reads them.

    if os.environ.get("DELPHI_RESULT_BACKEND") == "postgres":
        if job is None:
            raise RuntimeError("Postgres pipelines must be admitted through polis-jobs")
        # The embeddings-table switch (migration 000038) arrives in the frame the
        # daemon writes. Propagate it to this pipeline's subprocesses (the embedding
        # producer and the datamap reader read it from the environment). Default off.
        import json as _json
        _frame = _json.loads(open(os.environ["DELPHI_FRAME"]).read()) if os.environ.get("DELPHI_FRAME") else {}
        if _frame.get("embeddings_table") or _frame.get("config", {}).get("embeddings_table"):
            os.environ["DELPHI_EMBEDDINGS_TABLE"] = "1"
        from polismath.delphi_storage.writer import WriterResource
        # Clear only this attempt's private working copy; previous publications survive.
        WriterResource().reset()
    else:
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
    app_path = os.environ.get('DELPHI_APP_PATH', '/app')
    os.environ["PYTHONPATH"] = f"{app_path}:{os.environ.get('PYTHONPATH', '')}"

    # Every stage that fails is recorded here. Stages after a failure still run
    # as before, but the run exits non-zero so the job is marked FAILED rather
    # than COMPLETED.
    failed_stages = []

    # Run the UMAP narrative pipeline
    print(f"{GREEN}Running UMAP narrative pipeline...{NC}")
    umap_command = [
        "python", f"{app_path}/umap_narrative/run_pipeline.py",
        f"--zid={zid}",
        f"--include_moderation={args.include_moderation}",
        f"--exclude_comment_selections={args.exclude_comment_selections}",
        "--name-topics"
    ]
    # Only a run that names a selection passes one: every other run's
    # arguments are byte for byte what they were.
    if args.selection is not None:
        umap_command.append(f"--selection={args.selection}")
    # Likewise a run given a namer: every other run's arguments are unchanged.
    namer = getattr(args, "namer", None)
    record_read = record_write = None
    if namer is not None:
        from umap_narrative import topic_namer
        # The naming's record (outcome, token counts) comes back on a pipe,
        # not a file: nothing the manifest needs lives in the scratch directory.
        record_read, record_write = os.pipe()
        umap_command.append(f"--namer={topic_namer.namer_argument(namer)}")
        umap_command.append(f"--namer-dir={args.namer_dir}")
        umap_command.append(f"--naming-record-fd={record_write}")
    if verbose_arg:
        umap_command.append(verbose_arg)

    if record_write is None:
        pipeline_exit_code = step_log.run_child("pipeline", umap_command)
    else:
        try:
            pipeline_exit_code = step_log.run_child("pipeline", umap_command, pass_fds=(record_write,))
        finally:
            os.close(record_write)
        naming = topic_namer.receive_record(record_read) or {}
        os.close(record_read)
    if pipeline_exit_code != 0:
        failed_stages.append(("UMAP narrative pipeline", pipeline_exit_code))

    if pipeline_exit_code == 0 and switch_on(SKIP_DATAMAPPLOT):
        print(f"{YELLOW}Skipping the datamapplot visualizations ({SKIP_DATAMAPPLOT}=1): no page is written or uploaded.{NC}")
        step_log.emit("datamapplot", status="skipped")
    elif pipeline_exit_code == 0:
        print(f"{YELLOW}Creating visualizations with datamapplot...{NC}")

        # Create output directory
        output_dir = f"{app_path}/polis_data/{zid}/python_output/comments_enhanced_multilayer"
        os.makedirs(output_dir, exist_ok=True)

        # Generate visualizations for all available layers
        # First, determine available layers from DynamoDB
        try:
            import boto3
            from polismath.delphi_storage.resource import result_resource
            from boto3.dynamodb.conditions import Key
            
            raw_endpoint = os.environ.get('DYNAMODB_ENDPOINT')
            endpoint_url = raw_endpoint if raw_endpoint and raw_endpoint.strip() else None
            
            # Credentials come from the SDK default chain in every environment.
            if endpoint_url:
                dynamodb = result_resource('dynamodb', 
                                         endpoint_url=endpoint_url, 
                                         region_name='us-east-1')
            else:
                dynamodb = result_resource('dynamodb', region_name=args.region)


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
            
            returncode = step_log.run_child("datamapplot", datamap_command, layer=layer_id)
            if returncode == 0:
                print(f"{GREEN}Layer {layer_id} visualization completed{NC}")
            else:
                print(f"{RED}Layer {layer_id} visualization failed with exit code {returncode}{NC}")
                failed_stages.append((f"layer {layer_id} visualization", returncode))

        print(f"{GREEN}UMAP Narrative pipeline stage finished.{NC}")
    else:
        print(f"{RED}UMAP Narrative pipeline failed with exit code {pipeline_exit_code}; skipping visualizations.{NC}")

    if not failed_stages:
        print(f"{GREEN}Pipeline completed successfully!{NC}")
        print(f"Results stored in DynamoDB for conversation {zid}")
        if job is not None:
            with step_log.step("manifest"):
                if namer is None:
                    _finish_daemon_job(job, zid, args.region)
                else:
                    # How the naming ended, as the pipeline sent it; none
                    # sent reads as the keyword labels kept.
                    _finish_daemon_job(job, zid, args.region, naming=naming)
        sys.exit(0)

    summary = ", ".join(f"{name} (exit code {code})" for name, code in failed_stages)
    print(f"{RED}Pipeline failed: {len(failed_stages)} stage(s) failed: {summary}{NC}")
    print("Please check logs for more details")
    sys.exit(1)

if __name__ == "__main__":
    main()