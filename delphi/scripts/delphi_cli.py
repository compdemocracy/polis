#!/usr/bin/env python3
"""
Delphi CLI - A beautiful, elegant command-line interface for Delphi
A love letter to the history of computing.

This tool provides a simple way to interact with the Delphi job system.
"""

import argparse
import json
import os
import sys
import uuid
from datetime import datetime
from typing import Any, cast

import boto3

# Use flexible typing for boto3 resources
DynamoDBResource = Any

try:
    from rich.console import Console
    from rich.panel import Panel
    from rich.progress import Progress, SpinnerColumn, TextColumn
    from rich.prompt import Confirm, Prompt
    from rich.table import Table

    RICH_AVAILABLE = True
except ImportError:
    RICH_AVAILABLE = False
    print("For the best experience, install rich: pip install rich")

# Check if we're running in a terminal that supports rich features
IS_TERMINAL = sys.stdout.isatty()

# Initialize rich console if available
if RICH_AVAILABLE:
    console = Console()


def create_elegant_header() -> None:
    """Create an elegant header for the CLI."""
    if not RICH_AVAILABLE or not IS_TERMINAL:
        print("\nDelphi - Polis Analytics System\n")
        print("=" * 40)
        return

    header = Panel.fit(
        "[bold blue]Delphi[/bold blue] [italic]- Polis Analytics System[/italic]",
        border_style="blue",
        padding=(1, 2),
    )
    console.print(header)
    console.print()


def setup_dynamodb(endpoint_url: str | None = None, region: str = "us-east-1") -> DynamoDBResource:
    if endpoint_url is None:
        endpoint_url = os.environ.get("DYNAMODB_ENDPOINT")

    if endpoint_url == "":
        endpoint_url = None

    if endpoint_url:
        local_patterns = ["localhost", "host.docker.internal", "dynamodb:"]
        if any(pattern in endpoint_url for pattern in local_patterns):
            os.environ.setdefault("AWS_ACCESS_KEY_ID", "fakeMyKeyId")
            os.environ.setdefault("AWS_SECRET_ACCESS_KEY", "fakeSecretAccessKey")

    return boto3.resource("dynamodb", endpoint_url=endpoint_url, region_name=region)


def submit_job(
    dynamodb: DynamoDBResource,
    zid: str,
    job_type: str = "FULL_PIPELINE",
    priority: int = 50,
    max_votes: str | None = None,
    batch_size: str | None = None,  # For FULL_PIPELINE/PCA
    model: str | None = None,  # For FULL_PIPELINE's REPORT stage & CREATE_NARRATIVE_BATCH
    # Parameters for CREATE_NARRATIVE_BATCH stage config
    report_id_for_stage: str | None = None,
    max_batch_size_stage: int | None = None,  # Renamed to avoid conflict with general batch_size
    no_cache_stage: bool = False,
    # Parameters for AWAITING_NARRATIVE_BATCH jobs
    batch_id: str | None = None,
    batch_job_id: str | None = None,
) -> str:
    """Submit a job to the Delphi job queue."""
    table = dynamodb.Table("Delphi_JobQueue")

    # Generate a unique job ID
    job_id = str(uuid.uuid4())

    # Current timestamp in ISO format
    now = datetime.now().isoformat()

    # Build job configuration
    job_config: dict[str, Any] = {}

    if job_type == "FULL_PIPELINE":
        # Full pipeline configs
        stages = []

        # PCA stage
        pca_config = {}
        if max_votes:
            pca_config["max_votes"] = int(max_votes)
        if batch_size:  # This is the general batch_size for PCA
            pca_config["batch_size"] = int(batch_size)
        stages.append({"stage": "PCA", "config": pca_config})

        # UMAP stage
        stages.append({"stage": "UMAP", "config": {"n_neighbors": 15, "min_dist": 0.1}})

        # Report stage
        stages.append(
            {
                "stage": "REPORT",
                "config": {
                    "model": (model if model else os.environ.get("ANTHROPIC_MODEL")),  # Use provided model or env var
                    "include_topics": True,
                },
            }
        )

        # Visualization
        job_config["stages"] = stages
        job_config["visualizations"] = ["basic", "enhanced", "multilayer"]

    elif job_type == "CREATE_NARRATIVE_BATCH":
        if not report_id_for_stage:
            raise ValueError("report_id_for_stage is required for CREATE_NARRATIVE_BATCH job type.")

        # Default values if not provided, matching typical expectations or server defaults if known
        current_model = model if model else os.environ.get("ANTHROPIC_MODEL")  # Must be set via arg or env var
        if not current_model:
            raise ValueError("Model must be specified via --model or ANTHROPIC_MODEL environment variable")
        current_max_batch_size = (
            int(max_batch_size_stage) if max_batch_size_stage is not None else 100
        )  # Default batch size for stage

        job_config = {
            "job_type": "CREATE_NARRATIVE_BATCH",  # As per the TS snippet
            "stages": [
                {
                    "stage": "CREATE_NARRATIVE_BATCH_CONFIG_STAGE",
                    "config": {
                        "model": current_model,
                        "max_batch_size": current_max_batch_size,
                        "no_cache": no_cache_stage,  # boolean
                        "report_id": report_id_for_stage,
                    },
                },
            ],
        }
    elif job_type == "AWAITING_NARRATIVE_BATCH":
        if not batch_id:
            raise ValueError("batch_id is required for AWAITING_NARRATIVE_BATCH job type.")
        if not batch_job_id:
            raise ValueError("batch_job_id is required for AWAITING_NARRATIVE_BATCH job type.")

        job_config = {
            "job_type": "AWAITING_NARRATIVE_BATCH",
            "stages": [{"stage": "NARRATIVE_BATCH_STATUS_CHECK", "config": {}}],
        }

    # Create job item with version number for optimistic locking
    # Use empty strings instead of None for DynamoDB compatibility
    job_item = {
        "job_id": job_id,  # Primary key
        "status": "PENDING",  # Secondary index key
        "created_at": now,  # Secondary index key
        "updated_at": now,
        "version": 1,  # Version for optimistic locking
        "started_at": "",  # Using empty strings for nullable fields
        "completed_at": "",
        "worker_id": "none",  # Non-empty placeholder for index
        "job_type": job_type,
        "priority": priority,
        "conversation_id": str(zid),  # Using conversation_id (but still accept zid as input)
        "retry_count": 0,
        "max_retries": 3,
        "timeout_seconds": 7200,  # 2 hours default timeout
        "job_config": json.dumps(job_config),
        "job_results": json.dumps({}),
        "logs": json.dumps(
            {
                "entries": [
                    {
                        "timestamp": now,
                        "level": "INFO",
                        "message": f"Job created for conversation {zid}",
                    }
                ],
                "log_location": "",
            }
        ),
        "created_by": "delphi_cli",
    }

    # Add batch_id and batch_job_id for AWAITING_NARRATIVE_BATCH jobs
    if job_type == "AWAITING_NARRATIVE_BATCH":
        job_item["batch_id"] = batch_id
        job_item["batch_job_id"] = batch_job_id

    # Put item in DynamoDB
    table.put_item(Item=job_item)

    return job_id


def list_jobs(dynamodb: DynamoDBResource, status: str | None = None, limit: int = 10) -> list[dict[str, Any]]:
    """List jobs in the Delphi job queue."""
    table = dynamodb.Table("Delphi_JobQueue")

    if status:
        # Query for jobs with specific status using the StatusCreatedIndex
        response = table.query(
            IndexName="StatusCreatedIndex",
            KeyConditionExpression="#s = :status",
            ExpressionAttributeNames={"#s": "status"},
            ExpressionAttributeValues={":status": status},
            Limit=limit,
            ScanIndexForward=False,  # Sort in descending order by created_at
        )
    else:
        # Scan for all jobs and sort manually by created_at
        # THIS CODE WILL EVENTUALLY CRASH EVERYTHING
        # response = table.scan(
        #     ConsistentRead=True,  # Use consistent reads to immediately see new jobs
        #     Limit=limit * 2       # Get more items since we'll sort and trim
        # )

        # # Sort items by created_at in descending order
        # items = response.get('Items', [])
        # items.sort(key=lambda x: x.get('created_at', ''), reverse=True)

        # # Trim to requested limit
        # return items[:limit]
        return []

    items = response.get("Items", [])
    return cast(list[dict[str, Any]], items)


def display_jobs(jobs: list[dict[str, Any]]) -> None:
    """Display jobs in a nice format."""
    if not RICH_AVAILABLE or not IS_TERMINAL:
        print("\nJobs:")
        print("=" * 40)
        for job in jobs:
            print(f"Job ID: {job.get('job_id')}")
            print(f"Status: {job.get('status')}")
            print(f"ZID: {job.get('conversation_id')}")
            print(f"Created: {job.get('created_at')}")
            print("-" * 40)
        return

    table = Table(title="Delphi Jobs")

    table.add_column("Job ID", style="cyan", no_wrap=True)
    table.add_column("ZID", style="green")
    table.add_column("Status", style="magenta")
    table.add_column("Type", style="blue")
    table.add_column("Created", style="yellow")

    for job in jobs:
        job_id = job.get("job_id", "")
        if len(job_id) > 8:
            job_id = job_id[:8] + "..."

        table.add_row(
            job_id,
            job.get("conversation_id", ""),
            job.get("status", ""),
            job.get("job_type", ""),
            job.get("created_at", ""),
        )

    console.print(table)


def get_job_details(dynamodb: DynamoDBResource, job_id: str) -> dict[str, Any] | None:
    """Get detailed information about a specific job."""
    table = dynamodb.Table("Delphi_JobQueue")

    # Direct lookup by job_id (now the primary key)
    response = table.get_item(
        Key={"job_id": job_id},
        ConsistentRead=True,  # Use strong consistency for reading
    )

    if "Item" in response:
        item = response["Item"]
        return cast(dict[str, Any], item)
    return None


def display_job_details(job: dict[str, Any] | None) -> None:
    """Display detailed information about a job."""
    if not job:
        print("Job not found.")
        return

    if not RICH_AVAILABLE or not IS_TERMINAL:
        print("\nJob Details:")
        print("=" * 40)
        for key, value in job.items():
            print(f"{key}: {value}")
        return

    console.print(
        Panel(
            f"[bold]Job ID:[/bold] {job.get('job_id')}\n"
            f"[bold]Conversation:[/bold] {job.get('conversation_id')}\n"
            f"[bold]Status:[/bold] [{'green' if job.get('status') == 'COMPLETED' else 'yellow' if job.get('status') == 'PENDING' else 'red'}]{job.get('status')}[/]\n"
            f"[bold]Type:[/bold] {job.get('job_type')}\n"
            f"[bold]Priority:[/bold] {job.get('priority')}\n"
            f"[bold]Created:[/bold] {job.get('created_at')}\n"
            f"[bold]Updated:[/bold] {job.get('updated_at')}\n"
            f"[bold]Started:[/bold] {job.get('started_at') or 'Not started'}\n"
            f"[bold]Completed:[/bold] {job.get('completed_at') or 'Not completed'}\n",
            title="Job Details",
            border_style="blue",
        )
    )

    # Display configuration
    try:
        config = json.loads(job.get("job_config", "{}"))
        if config:
            console.print(
                Panel(
                    json.dumps(config, indent=2),
                    title="Job Configuration",
                    border_style="green",
                )
            )
    except Exception:
        pass

    # Display logs
    try:
        logs = json.loads(job.get("logs", "{}"))
        if logs and "entries" in logs:
            log_table = Table(title="Job Logs")
            log_table.add_column("Timestamp", style="yellow")
            log_table.add_column("Level", style="blue")
            log_table.add_column("Message", style="white")

            for entry in logs["entries"]:
                log_table.add_row(
                    entry.get("timestamp", ""),
                    entry.get("level", ""),
                    entry.get("message", ""),
                )

            console.print(log_table)
    except Exception:
        pass


def interactive_mode() -> None:
    """Run the CLI in interactive mode."""
    if not RICH_AVAILABLE:
        print("Interactive mode requires rich library.")
        print("Please install with: pip install rich")
        return

    create_elegant_header()

    dynamodb = setup_dynamodb()

    # Main menu
    while True:
        console.print("\n[bold blue]What would you like to do?[/bold blue]")
        console.print("1. [green]Submit a new job[/green]")
        console.print("2. [yellow]List existing jobs[/yellow]")
        console.print("3. [cyan]View job details[/cyan]")
        console.print("4. [magenta]Check conversation status[/magenta]")
        console.print("5. [red]Exit[/red]")

        choice = Prompt.ask("Enter your choice", choices=["1", "2", "3", "4", "5"])

        if choice == "1":
            # Submit a new job
            zid = Prompt.ask("[bold]Enter conversation ID (zid)[/bold]")
            job_type = Prompt.ask(
                "[bold]Job type[/bold]",
                choices=[
                    "FULL_PIPELINE",
                    "CREATE_NARRATIVE_BATCH",
                    "AWAITING_NARRATIVE_BATCH",
                ],
                default="FULL_PIPELINE",
            )
            priority = int(Prompt.ask("[bold]Priority[/bold] (0-100)", default="50"))

            # Optional parameters
            max_votes = None
            batch_size = None
            model_param = None
            # CREATE_NARRATIVE_BATCH specific stage params
            report_id_stage_param = None
            max_batch_size_stage_param = None
            no_cache_stage_param = False
            # AWAITING_NARRATIVE_BATCH specific params
            batch_id_param = None
            batch_job_id_param = None

            if job_type == "FULL_PIPELINE":
                if Confirm.ask("Set parameters for FULL_PIPELINE (max_votes, batch_size, model)?"):
                    max_votes_input = Prompt.ask("Max votes (optional)", default="")
                    if max_votes_input:
                        max_votes = max_votes_input

                    batch_size_input = Prompt.ask("Batch size (optional)", default="")
                    if batch_size_input:
                        batch_size = batch_size_input

                    model_input = Prompt.ask(
                        "Model for REPORT stage (optional, defaults to ANTHROPIC_MODEL env var)",
                        default="",
                    )
                    if model_input:
                        model_param = model_input

            elif job_type == "CREATE_NARRATIVE_BATCH":
                report_id_stage_param = Prompt.ask("[bold]Report ID (for stage config)[/bold]")
                default_model = os.environ.get("ANTHROPIC_MODEL", "")
                if default_model:
                    model_param = Prompt.ask(
                        f"[bold]Model[/bold] (defaults to {default_model})",
                        default=default_model,
                    )
                else:
                    model_param = Prompt.ask(
                        "[bold]Model[/bold] (REQUIRED - set ANTHROPIC_MODEL env var to avoid this prompt)"
                    )
                max_batch_size_input = Prompt.ask(
                    "Max batch size (for stage config, optional, default 100)",
                    default="",
                )
                if max_batch_size_input:
                    max_batch_size_stage_param = int(max_batch_size_input)
                no_cache_stage_param = Confirm.ask("Enable no-cache for stage?", default=False)

            elif job_type == "AWAITING_NARRATIVE_BATCH":
                batch_id_param = Prompt.ask("[bold]Batch ID[/bold]")
                batch_job_id_param = Prompt.ask("[bold]Batch Job ID[/bold]")

            # Confirm submission
            if Confirm.ask(f"Submit job for conversation {zid}?"):
                with Progress(
                    SpinnerColumn(),
                    TextColumn("[progress.description]{task.description}"),
                    transient=True,
                ) as progress:
                    progress.add_task(description="Submitting job...", total=None)
                    job_id = submit_job(
                        dynamodb=dynamodb,
                        zid=zid,
                        job_type=job_type,
                        priority=priority,
                        max_votes=max_votes,
                        batch_size=batch_size,
                        model=model_param,  # Pass the collected model
                        # CREATE_NARRATIVE_BATCH specific stage params
                        report_id_for_stage=report_id_stage_param,
                        max_batch_size_stage=max_batch_size_stage_param,
                        no_cache_stage=no_cache_stage_param,
                        # AWAITING_NARRATIVE_BATCH specific params
                        batch_id=batch_id_param,
                        batch_job_id=batch_job_id_param,
                    )

                console.print(f"[bold green]Job submitted with ID: {job_id}[/bold green]")

        elif choice == "2":
            # List jobs
            status = Prompt.ask(
                "[bold]Filter by status[/bold]",
                choices=["ALL", "PENDING", "PROCESSING", "COMPLETED", "FAILED"],
                default="ALL",
            )

            with Progress(
                SpinnerColumn(),
                TextColumn("[progress.description]{task.description}"),
                transient=True,
            ) as progress:
                progress.add_task(description="Fetching jobs...", total=None)
                jobs = list_jobs(
                    dynamodb=dynamodb,
                    status=None if status == "ALL" else status,
                    limit=25 if status == "ALL" else 10,
                )

            display_jobs(jobs)

        elif choice == "3":
            # View job details
            job_id = Prompt.ask("[bold]Enter job ID[/bold]")

            with Progress(
                SpinnerColumn(),
                TextColumn("[progress.description]{task.description}"),
                transient=True,
            ) as progress:
                progress.add_task(description="Fetching job details...", total=None)
                job = get_job_details(dynamodb=dynamodb, job_id=job_id)

            display_job_details(job)

        elif choice == "4":
            # Check conversation status
            zid = Prompt.ask("[bold]Enter conversation ID (zid)[/bold]")

            with Progress(
                SpinnerColumn(),
                TextColumn("[progress.description]{task.description}"),
                transient=True,
            ) as progress:
                progress.add_task(description="Fetching conversation status...", total=None)
                status_data, error = get_conversation_status(dynamodb=dynamodb, zid=zid)

            if error:
                console.print(f"[bold red]Error: {error}[/bold red]")
            else:
                display_conversation_status(status_data)

        elif choice == "5":
            # Exit
            console.print("[bold green]Goodbye![/bold green]")
            break


def get_conversation_status(dynamodb: DynamoDBResource, zid: str) -> tuple[dict[str, Any] | None, str]:
    """Get detailed information about a conversation run."""
    conversation_meta_table = dynamodb.Table("Delphi_UMAPConversationConfig")
    topic_names_table = dynamodb.Table("Delphi_CommentClustersLLMTopicNames")
    job_table = dynamodb.Table("Delphi_JobQueue")

    try:
        meta_response = conversation_meta_table.get_item(Key={"conversation_id": str(zid)})
        if "Item" not in meta_response:
            return (
                None,
                f"Conversation {zid} not found in Delphi_UMAPConversationConfig table.",
            )
        meta_data = meta_response["Item"]

        topics_response = topic_names_table.query(
            KeyConditionExpression="conversation_id = :cid",
            ExpressionAttributeValues={":cid": str(zid)},
        )
        topics_items = topics_response.get("Items", [])

        job_response = job_table.query(
            IndexName="ConversationIndex",
            KeyConditionExpression="conversation_id = :cid",
            ExpressionAttributeValues={":cid": str(zid)},
            # Query in reverse order to get the newest jobs first
            ScanIndexForward=False,
        )

        jobs = job_response.get("Items", [])

        last_job = jobs[0] if jobs else None

        return {"meta": meta_data, "topics": topics_items, "last_job": last_job}, ""

    except Exception as e:
        error_message = str(e)
        return None, f"Error retrieving conversation status: {error_message}"


def display_conversation_status(status_data: dict[str, Any] | None) -> None:
    """Display detailed information about a conversation run."""
    if not status_data:
        print("Conversation not found or error occurred.")
        return

    meta = status_data.get("meta", {})
    topics = status_data.get("topics", [])
    last_job = status_data.get("last_job", {})

    # Group topics by layer
    topics_by_layer: dict[str, list[dict[str, Any]]] = {}
    for topic in topics:
        # Handle both dictionary and direct value formats
        if isinstance(topic.get("layer_id"), dict):
            layer_id = topic.get("layer_id", {}).get("N", "0")
        else:
            layer_id = str(topic.get("layer_id", "0"))

        if layer_id not in topics_by_layer:
            topics_by_layer[layer_id] = []
        topics_by_layer[layer_id].append(topic)

    # Sort topics by cluster_id within each layer
    for topics in topics_by_layer.values():
        # Handle both dictionary and direct value formats for sorting
        def get_cluster_id(x: dict[str, Any]) -> int:
            if isinstance(x.get("cluster_id"), dict):
                return int(x.get("cluster_id", {}).get("N", "0"))
            else:
                return int(str(x.get("cluster_id", "0")))

        topics.sort(key=get_cluster_id)

    if not RICH_AVAILABLE or not IS_TERMINAL:
        print("\nConversation Status:")
        print("=" * 40)
        print(f"ZID: {meta.get('conversation_id', '')}")

        # Handle both DynamoDB and direct object formats for metadata
        if isinstance(meta.get("metadata"), dict) and "M" in meta.get("metadata", {}):
            metadata = meta.get("metadata", {}).get("M", {})
            if isinstance(metadata.get("conversation_name"), dict):
                conv_name = metadata.get("conversation_name", {}).get("S", "Unknown")
            else:
                conv_name = str(metadata.get("conversation_name", "Unknown"))
        else:
            metadata = meta.get("metadata", {})
            conv_name = str(metadata.get("conversation_name", "Unknown"))

        # Handle various number formats
        if isinstance(meta.get("num_comments"), dict):
            num_comments = meta.get("num_comments", {}).get("N", "0")
        else:
            num_comments = str(meta.get("num_comments", "0"))

        if isinstance(meta.get("processed_date"), dict):
            processed_date = meta.get("processed_date", {}).get("S", "Unknown")
        else:
            processed_date = str(meta.get("processed_date", "Unknown"))

        print(f"Name: {conv_name}")
        print(f"Comments: {num_comments}")
        print(f"Processed on: {processed_date}")

        # Display layers and clusters
        print("\nClustering Layers:")
        # Get cluster layers, handling both formats
        if isinstance(meta.get("cluster_layers"), dict):
            cluster_layers = meta.get("cluster_layers", {}).get("L", [])
        else:
            cluster_layers = meta.get("cluster_layers", [])

        for layer in cluster_layers:
            # Handle dictionary format
            if isinstance(layer, dict) and "M" in layer:
                layer_data = layer.get("M", {})
                if isinstance(layer_data.get("layer_id"), dict):
                    layer_id = layer_data.get("layer_id", {}).get("N", "0")
                else:
                    layer_id = str(layer_data.get("layer_id", "0"))

                if isinstance(layer_data.get("description"), dict):
                    description = layer_data.get("description", {}).get("S", "")
                else:
                    description = str(layer_data.get("description", ""))

                if isinstance(layer_data.get("num_clusters"), dict):
                    num_clusters = layer_data.get("num_clusters", {}).get("N", "0")
                else:
                    num_clusters = str(layer_data.get("num_clusters", "0"))
            # Handle direct object format
            else:
                if isinstance(layer.get("layer_id"), dict):
                    layer_id = layer.get("layer_id", {}).get("N", "0")
                else:
                    layer_id = str(layer.get("layer_id", "0"))

                if isinstance(layer.get("description"), dict):
                    description = layer.get("description", {}).get("S", "")
                else:
                    description = str(layer.get("description", ""))

                if isinstance(layer.get("num_clusters"), dict):
                    num_clusters = layer.get("num_clusters", {}).get("N", "0")
                else:
                    num_clusters = str(layer.get("num_clusters", "0"))

            print(f"- Layer {layer_id}: {description} - {num_clusters} clusters")

        # Display topic names for each layer (up to 5 per layer)
        print("\nTopic Names (sample):")
        for layer_id, layer_topics in topics_by_layer.items():
            print(f"Layer {layer_id}:")
            for topic in layer_topics[:5]:
                # Handle both dictionary and direct value formats
                if isinstance(topic.get("topic_name"), dict):
                    topic_name = topic.get("topic_name", {}).get("S", "Unknown")
                else:
                    topic_name = str(topic.get("topic_name", "Unknown"))

                if isinstance(topic.get("cluster_id"), dict):
                    cluster_id = topic.get("cluster_id", {}).get("N", "0")
                else:
                    cluster_id = str(topic.get("cluster_id", "0"))

                print(f"  - Cluster {cluster_id}: {topic_name}")
            if len(layer_topics) > 5:
                print(f"  ... and {len(layer_topics) - 5} more topics")

        # Display most recent job status
        if last_job:
            print("\nMost Recent Job:")
            print(f"Status: {last_job.get('status', '')}")
            print(f"Submitted: {last_job.get('created_at', '')}")
            if last_job.get("completed_at"):
                print(f"Completed: {last_job.get('completed_at', '')}")

        return

    # Rich formatting for terminal output
    # Handle both DynamoDB and direct object formats for metadata
    if isinstance(meta.get("metadata"), dict) and "M" in meta.get("metadata", {}):
        metadata = meta.get("metadata", {}).get("M", {})
        if isinstance(metadata.get("conversation_name"), dict):
            meta_name = metadata.get("conversation_name", {}).get("S", "Unknown")
        else:
            meta_name = str(metadata.get("conversation_name", "Unknown"))
    else:
        metadata = meta.get("metadata", {})
        meta_name = str(metadata.get("conversation_name", "Unknown"))

    zid_display = meta.get("conversation_id", "")

    # Handle various number and field formats
    if isinstance(meta.get("num_comments"), dict):
        num_comments = meta.get("num_comments", {}).get("N", "0")
    else:
        num_comments = str(meta.get("num_comments", "0"))

    if isinstance(meta.get("embedding_model"), dict):
        embedding_model = meta.get("embedding_model", {}).get("S", "Unknown")
    else:
        embedding_model = str(meta.get("embedding_model", "Unknown"))

    if isinstance(meta.get("processed_date"), dict):
        processed_date = meta.get("processed_date", {}).get("S", "Unknown")
    else:
        processed_date = str(meta.get("processed_date", "Unknown"))

    # Main panel with conversation info
    console.print(
        Panel(
            f"[bold]ZID:[/bold] {zid_display}\n"
            f"[bold]Name:[/bold] {meta_name}\n"
            f"[bold]Comments:[/bold] {num_comments}\n"
            f"[bold]Model:[/bold] {embedding_model}\n"
            f"[bold]Processed:[/bold] {processed_date}\n",
            title="Conversation Status",
            border_style="blue",
        )
    )

    # Layers and clusters information
    layers_table = Table(title="Clustering Layers")
    layers_table.add_column("Layer", style="cyan")
    layers_table.add_column("Description", style="green")
    layers_table.add_column("Clusters", style="magenta")

    # Get cluster layers, handling both formats
    if isinstance(meta.get("cluster_layers"), dict):
        cluster_layers = meta.get("cluster_layers", {}).get("L", [])
    else:
        cluster_layers = meta.get("cluster_layers", [])

    for layer in cluster_layers:
        # Handle dictionary format
        if isinstance(layer, dict) and "M" in layer:
            layer_data = layer.get("M", {})
            if isinstance(layer_data.get("layer_id"), dict):
                layer_id = layer_data.get("layer_id", {}).get("N", "0")
            else:
                layer_id = str(layer_data.get("layer_id", "0"))

            if isinstance(layer_data.get("description"), dict):
                description = layer_data.get("description", {}).get("S", "")
            else:
                description = str(layer_data.get("description", ""))

            if isinstance(layer_data.get("num_clusters"), dict):
                num_clusters = layer_data.get("num_clusters", {}).get("N", "0")
            else:
                num_clusters = str(layer_data.get("num_clusters", "0"))
        # Handle direct object format
        else:
            if isinstance(layer.get("layer_id"), dict):
                layer_id = layer.get("layer_id", {}).get("N", "0")
            else:
                layer_id = str(layer.get("layer_id", "0"))

            if isinstance(layer.get("description"), dict):
                description = layer.get("description", {}).get("S", "")
            else:
                description = str(layer.get("description", ""))

            if isinstance(layer.get("num_clusters"), dict):
                num_clusters = layer.get("num_clusters", {}).get("N", "0")
            else:
                num_clusters = str(layer.get("num_clusters", "0"))

        layers_table.add_row(layer_id, description, num_clusters)

    console.print(layers_table)

    # Sample topic names for each layer
    for layer_id, layer_topics in topics_by_layer.items():
        topic_table = Table(title=f"Layer {layer_id} Topics (Sample)")
        topic_table.add_column("Cluster", style="cyan")
        topic_table.add_column("Topic Name", style="yellow")

        for topic in layer_topics[:5]:  # Show up to 5 topics per layer
            # Handle both dictionary and direct value formats
            if isinstance(topic.get("topic_name"), dict):
                topic_name = topic.get("topic_name", {}).get("S", "Unknown")
            else:
                topic_name = str(topic.get("topic_name", "Unknown"))

            if isinstance(topic.get("cluster_id"), dict):
                cluster_id = topic.get("cluster_id", {}).get("N", "0")
            else:
                cluster_id = str(topic.get("cluster_id", "0"))

            topic_table.add_row(cluster_id, topic_name)

        if len(layer_topics) > 5:
            topic_table.add_row("...", f"... and {len(layer_topics) - 5} more topics")

        console.print(topic_table)

    # Most recent job information
    if last_job:
        job_status = last_job.get("status", "")
        status_color = "green" if job_status == "COMPLETED" else "yellow" if job_status == "PENDING" else "red"

        console.print(
            Panel(
                f"[bold]Status:[/bold] [{status_color}]{job_status}[/]\n"
                f"[bold]Submitted:[/bold] {last_job.get('created_at', '')}\n"
                f"[bold]Completed:[/bold] {last_job.get('completed_at', '') or 'Not completed'}\n",
                title="Most Recent Job",
                border_style="green",
            )
        )


def main() -> None:
    """Main entry point for the Delphi CLI."""
    # Parse command line arguments
    parser = argparse.ArgumentParser(description="Delphi CLI - Polis Analytics System")

    # Command subparsers
    subparsers = parser.add_subparsers(dest="command", help="Command to execute")

    # Submit command
    submit_parser = subparsers.add_parser("submit", help="Submit a new job")
    submit_parser.add_argument("--zid", required=True, help="Conversation ID (zid)")
    submit_parser.add_argument(
        "--job-type",
        default="FULL_PIPELINE",
        choices=["FULL_PIPELINE", "CREATE_NARRATIVE_BATCH", "AWAITING_NARRATIVE_BATCH"],
        help="Type of job to submit",
    )
    submit_parser.add_argument("--priority", type=int, default=50, help="Job priority (0-100)")
    submit_parser.add_argument("--max-votes", help="Maximum votes to process (for FULL_PIPELINE/PCA)")
    submit_parser.add_argument("--batch-size", help="Batch size for processing (for FULL_PIPELINE/PCA)")
    # General model argument, used by FULL_PIPELINE's REPORT stage and CREATE_NARRATIVE_BATCH
    submit_parser.add_argument("--model", help="Model to use (defaults to ANTHROPIC_MODEL env var)")

    # Arguments for CREATE_NARRATIVE_BATCH stage config
    submit_parser.add_argument(
        "--report-id-stage",
        help="Report ID for the CREATE_NARRATIVE_BATCH stage config",
    )
    submit_parser.add_argument(
        "--max-batch-size-stage",
        type=int,
        help="Max batch size for the CREATE_NARRATIVE_BATCH stage config",
    )
    submit_parser.add_argument(
        "--no-cache-stage",
        action="store_true",
        help="Enable no-cache for the CREATE_NARRATIVE_BATCH stage (default: False)",
    )

    # Arguments for AWAITING_NARRATIVE_BATCH jobs
    submit_parser.add_argument("--batch-id", help="Batch ID for AWAITING_NARRATIVE_BATCH jobs")
    submit_parser.add_argument(
        "--batch-job-id",
        help="Original job ID that created the batch for AWAITING_NARRATIVE_BATCH jobs",
    )

    # List command
    list_parser = subparsers.add_parser("list", help="List jobs")
    list_parser.add_argument(
        "--status",
        choices=["PENDING", "PROCESSING", "COMPLETED", "FAILED"],
        help="Filter by status",
    )
    list_parser.add_argument("--limit", type=int, default=25, help="Maximum number of jobs to list")

    # Details command
    details_parser = subparsers.add_parser("details", help="View job details")
    details_parser.add_argument("job_id", help="Job ID to view details for")

    # Status command - NEW
    status_parser = subparsers.add_parser("status", help="Check conversation status and results")
    status_parser.add_argument("zid", help="Conversation ID (zid) to check status for")

    # Common options
    parser.add_argument("--endpoint-url", help="DynamoDB endpoint URL")
    parser.add_argument("--region", default="us-east-1", help="AWS region")

    # Interactive mode is the default when no arguments are provided
    parser.add_argument("--interactive", action="store_true", help="Run in interactive mode")

    args = parser.parse_args()

    # Set up DynamoDB connection
    dynamodb = setup_dynamodb(endpoint_url=args.endpoint_url, region=args.region)

    # Create header
    create_elegant_header()

    # No arguments or interactive flag - go to interactive mode
    if len(sys.argv) == 1 or args.interactive:
        interactive_mode()
        return

    # Handle commands
    if args.command == "submit":
        # Validate arguments for CREATE_NARRATIVE_BATCH
        if args.job_type == "CREATE_NARRATIVE_BATCH":
            if not args.report_id_stage:
                parser.error("--report-id-stage is required when --job-type is CREATE_NARRATIVE_BATCH")
            # model, max_batch_size_stage, no_cache_stage have defaults or are optional in submit_job if not provided here

        # Validate arguments for AWAITING_NARRATIVE_BATCH
        if args.job_type == "AWAITING_NARRATIVE_BATCH":
            if not args.batch_id:
                parser.error("--batch-id is required when --job-type is AWAITING_NARRATIVE_BATCH")
            if not args.batch_job_id:
                parser.error("--batch-job-id is required when --job-type is AWAITING_NARRATIVE_BATCH")

        job_id = submit_job(
            dynamodb=dynamodb,
            zid=args.zid,
            job_type=args.job_type,
            priority=args.priority,
            max_votes=args.max_votes,
            batch_size=args.batch_size,
            model=args.model,  # General model
            # CREATE_NARRATIVE_BATCH specific stage params
            report_id_for_stage=args.report_id_stage,
            max_batch_size_stage=args.max_batch_size_stage,
            no_cache_stage=args.no_cache_stage,
            # AWAITING_NARRATIVE_BATCH specific params
            batch_id=args.batch_id,
            batch_job_id=args.batch_job_id,
        )

        if RICH_AVAILABLE and IS_TERMINAL:
            console.print(f"[bold green]Job submitted with ID: {job_id}[/bold green]")
        else:
            print(f"Job submitted with ID: {job_id}")

    elif args.command == "list":
        jobs = list_jobs(dynamodb=dynamodb, status=args.status, limit=args.limit)
        display_jobs(jobs)

    elif args.command == "details":
        job = get_job_details(dynamodb=dynamodb, job_id=args.job_id)
        display_job_details(job)

    elif args.command == "status":
        status_data, error = get_conversation_status(dynamodb=dynamodb, zid=args.zid)

        if error:
            if RICH_AVAILABLE and IS_TERMINAL:
                console.print(f"[bold red]Error: {error}[/bold red]")
            else:
                print(f"Error: {error}")
        else:
            display_conversation_status(status_data)


if __name__ == "__main__":
    main()
