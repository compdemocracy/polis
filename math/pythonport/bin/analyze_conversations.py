import os
import csv
from pathlib import Path
import psycopg2
import click
import polars as pl
from rich.console import Console
from rich.table import Table
from rich.progress import track
from dotenv import load_dotenv

# Get the repository root directory (two levels up from this script)
REPO_ROOT = Path(__file__).resolve().parents[3]

# Load environment variables from .env file in the repository root
load_dotenv(REPO_ROOT / '.env')

# Get database connection parameters from environment variables
DB_USER = os.getenv('POSTGRES_USER')
DB_PASSWORD = os.getenv('POSTGRES_PASSWORD')
DB_NAME = os.getenv('POSTGRES_DB')
DB_PORT = os.getenv('POSTGRES_PORT')
DB_HOST = 'localhost'  # Since we're connecting to the container from host

def determine_pca_type(metrics):
    """Determine PCA type based on conversation metrics."""
    min_participants = 15  # Minimum participants needed for PCA
    large_cutoff = 10000  # Threshold for regular vs batch PCA
    
    # If we don't have enough participants who voted on either all comments
    # or at least 7 comments, no PCA will be performed
    if metrics['participants_min_7_votes'] < min_participants:
        return "none"
    
    # If we have enough participants, determine if it's regular or batch PCA
    # based on the total number of participants
    if metrics['total_participants'] > large_cutoff:
        return "batch"  # Large conversations use batch PCA
    else:
        return "regular"  # Small conversations use regular PCA

def fetch_conversation_data(cursor, zid):
    """Fetch basic conversation data."""
    # Get conversation info
    cursor.execute("""
        SELECT topic, participant_count
        FROM conversations 
        WHERE zid = %s
    """, (zid,))
    conv_data = cursor.fetchone()
    if not conv_data:
        return None
    
    # Get comment counts
    cursor.execute("""
        SELECT 
            COUNT(*) as total_comments,
            COUNT(*) FILTER (WHERE active = true AND mod >= 0) as active_comments
        FROM comments 
        WHERE zid = %s
    """, (zid,))
    comment_data = cursor.fetchone()
    
    # Get participant vote counts
    cursor.execute("""
        SELECT pid, vote_count
        FROM participants
        WHERE zid = %s
    """, (zid,))
    participant_data = cursor.fetchall()
    
    # Convert to Polars DataFrames
    df_participants = pl.DataFrame(
        participant_data,
        schema=['pid', 'vote_count']
    )
    
    # Calculate metrics
    n_participants = len(df_participants)
    n_active_voters = df_participants.filter(pl.col('vote_count') > 0).height
    n_7plus_voters = df_participants.filter(pl.col('vote_count') >= 7).height
    
    metrics = {
        'topic': conv_data[0],
        'total_participants': conv_data[1],
        'total_comments': comment_data[0],
        'active_comments': comment_data[1],
        'participants_with_votes': n_active_voters,
        'participants_min_7_votes': n_7plus_voters
    }
    
    # Add PCA type
    metrics['pca_type'] = determine_pca_type(metrics)
    
    return metrics

def display_metrics_table(metrics_data):
    """Display metrics in a nicely formatted table using rich."""
    console = Console()
    
    # Create and style the table
    table = Table(title="Conversation Metrics", show_header=True, header_style="bold magenta")
    
    # Add columns
    table.add_column("Zinvite", style="cyan")
    table.add_column("CSV Name", style="green")
    table.add_column("DB Topic", style="yellow")
    table.add_column("ZID", style="blue")
    table.add_column("Participants", justify="right")
    table.add_column("Comments", justify="right")
    table.add_column("Active Comments", justify="right")
    table.add_column("With Votes", justify="right")
    table.add_column("7+ Votes", justify="right", style="bold")
    table.add_column("PCA", style="red")
    
    # Add rows
    for row in metrics_data:
        # Style PCA type
        pca_style = {
            "regular": "[green]regular[/green]",
            "batch": "[yellow]batch[/yellow]",
            "none": "[red]none[/red]"
        }.get(row[9], row[9])
        
        table.add_row(
            str(row[0]),  # zinvite
            str(row[1]),  # csv_name
            str(row[2]),  # db_topic
            str(row[3]),  # zid
            str(row[4]),  # total_participants
            str(row[5]),  # total_comments
            str(row[6]),  # active_comments
            str(row[7]),  # participants_with_votes
            str(row[8]),  # participants_min_7_votes
            pca_style    # pca_type with color
        )
    
    # Print the table
    console.print(table)

@click.command()
@click.argument('input_file', type=click.Path(exists=True), default='traces/conversations_zid.csv', required=False)
@click.argument('output_file', type=click.Path(), default=None, required=False)
def main(input_file, output_file):
    """Analyze conversation metrics from a CSV file.
    
    INPUT_FILE: Path to the input CSV file (default: traces/conversations_zid.csv)
    OUTPUT_FILE: Path to the output CSV file (default: derived from input filename)
    """
    # Set default output file if not provided
    if output_file is None:
        input_path = Path(input_file)
        output_file = str(input_path.parent / f"{input_path.stem}_metrics.csv")
    
    # Establish database connection
    conn = psycopg2.connect(
        dbname=DB_NAME,
        user=DB_USER,
        password=DB_PASSWORD,
        host=DB_HOST,
        port=DB_PORT
    )
    cursor = conn.cursor()

    # Store metrics for table display
    metrics_data = []

    # Read input CSV and write output CSV
    with open(input_file, 'r') as infile, open(output_file, 'w', newline='') as outfile:
        reader = csv.DictReader(infile)
        writer = csv.writer(outfile)
        
        # Write header
        writer.writerow([
            'zinvite', 
            'csv_name',
            'db_topic', 
            'zid', 
            'total_participants',
            'total_comments',
            'active_comments',
            'participants_with_votes',
            'participants_min_7_votes',
            'pca_type'
        ])
        
        # Convert reader to list for progress tracking
        rows = list(reader)
        
        # Process each row with progress bar
        for row in track(rows, description="Processing conversations..."):
            zinvite = row['zinvite']
            csv_name = row['name']
            
            # Get zid using to_zid function
            cursor.execute("SELECT to_zid(%s)", (zinvite,))
            result = cursor.fetchone()
            zid = result[0] if result else None
            
            if zid:
                metrics = fetch_conversation_data(cursor, zid)
                if metrics:
                    row_data = [
                        zinvite,
                        csv_name,
                        metrics['topic'],
                        zid,
                        metrics['total_participants'],
                        metrics['total_comments'],
                        metrics['active_comments'],
                        metrics['participants_with_votes'],
                        metrics['participants_min_7_votes'],
                        metrics['pca_type']
                    ]
                    
                    writer.writerow(row_data)
                    metrics_data.append(row_data)
                    click.echo(f"Processed conversation {zinvite} (zid: {zid})")
                else:
                    click.echo(f"No metrics found for conversation {zinvite} (zid: {zid})")
            else:
                click.echo(f"Could not find zid for zinvite {zinvite}")

    # Close database connection
    cursor.close()
    conn.close()

    # Display the metrics table
    display_metrics_table(metrics_data)
    
    click.echo(f"\nResults written to {output_file}")

if __name__ == "__main__":
    main() 