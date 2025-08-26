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

def main():
    parser = argparse.ArgumentParser(description="Process a Polis conversation with the Delphi analytics pipeline.", add_help=False)
    parser.add_argument("--zid", required=True, help="The Polis conversation ID to process")
    parser.add_argument("--rid", required=False, help="The report ID, if available, for full narrative cleanup.")
    parser.add_argument("--verbose", action="store_true", help="Show detailed logs")
    parser.add_argument("--force", action="store_true", help="Force reprocessing even if data exists")
    parser.add_argument("--validate", action="store_true", help="Run extra validation checks")
    parser.add_argument("--help", action="store_true", help="Show this help message")
    parser.add_argument('--include_moderation', type=bool, default=False, help='Whether or not to include moderated comments in reports. If false, moderated comments will appear.')

    args = parser.parse_args()

    if args.help:
        show_usage()
        sys.exit(0)

    zid = args.zid
    rid = args.rid
    verbose_arg = "--verbose" if args.verbose else ""
    force_arg = "--force" if args.force else ""
    # validate_arg is not used in the python script execution steps, but kept for parity with bash
    # validate_arg = "--validate" if args.validate else ""

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
        sys.exit(reset_process.returncode)
    print(f"{GREEN}Data reset complete.{NC}")

    print(f"{GREEN}Processing conversation {zid}...{NC}")

    # Set model
    model = os.environ.get("OLLAMA_MODEL")
    if not model:
        print(f"{RED}Error: OLLAMA_MODEL environment variable not set.{NC}")
        sys.exit(1)
    print(f"{YELLOW}Using Ollama model: {model}{NC}")

    # Set up environment for the pipeline
    os.environ["PYTHONPATH"] = f"/app:{os.environ.get('PYTHONPATH', '')}"
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
        "python", "/app/polismath/run_math_pipeline.py",
        f"--zid={zid}",
    ]
    if max_votes_arg:
        math_command.append(max_votes_arg)
    if batch_size_arg:
        math_command.append(batch_size_arg)

    math_process = subprocess.run(math_command)
    math_exit_code = math_process.returncode

    if math_exit_code != 0:
        print(f"{RED}Math pipeline failed with exit code {math_exit_code}{NC}")
        sys.exit(math_exit_code)

    # Run the UMAP narrative pipeline
    print(f"{GREEN}Running UMAP narrative pipeline...{NC}")
    umap_command = [
        "python", "/app/umap_narrative/run_pipeline.py",
        f"--zid={zid}",
        f"--include_moderation={args.include_moderation}",
        "--use-ollama"
    ]
    if verbose_arg:
        umap_command.append(verbose_arg)

    pipeline_process = subprocess.run(umap_command)
    pipeline_exit_code = pipeline_process.returncode

    # Calculate and store comment extremity values
    print(f"{GREEN}Calculating comment extremity values...{NC}")
    extremity_command = [
        "python", "/app/umap_narrative/501_calculate_comment_extremity.py",
        f"--zid={zid}",
    ]
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
        "python", "/app/umap_narrative/502_calculate_priorities.py",
        f"--conversation_id={zid}",
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
        output_dir = f"/app/polis_data/{zid}/python_output/comments_enhanced_multilayer"
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
                dynamodb = boto3.resource('dynamodb', region_name='us-east-1')


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
                "python", "/app/umap_narrative/700_datamapplot_for_layer.py",
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

    sys.exit(exit_code)

if __name__ == "__main__":
    main()