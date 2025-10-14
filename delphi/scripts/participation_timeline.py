#!/usr/bin/env python3
"""
Generate participation timeline visualizations for Polis conversations.

Usage:
    python participation_timeline.py <zinvite1> [zinvite2 ...]
"""

import sys
import os
import psycopg2
import pandas as pd
import numpy as np
import matplotlib.pyplot as plt
import seaborn as sns
from datetime import datetime, timedelta
from matplotlib.colors import ListedColormap

try:
    import plotly.graph_objects as go
    PLOTLY_AVAILABLE = True
except ImportError:
    PLOTLY_AVAILABLE = False
    print("Warning: plotly not installed. Interactive HTML plots will be skipped.")

# Set style
sns.set_style("whitegrid")

# Configuration
USE_DATES_ON_XAXIS = True  # Set to False to use day numbers instead


def get_db_connection():
    """Establish database connection."""
    db_params = {
        'host': 'localhost',
        'port': os.getenv('POSTGRES_PORT', '5432'),
        'database': os.getenv('POSTGRES_DB', 'polis'),
        'user': os.getenv('POSTGRES_USER', 'postgres'),
        'password': os.getenv('POSTGRES_PASSWORD')
    }
    return psycopg2.connect(**db_params)


def get_zid_from_zinvite(conn, zinvite):
    """Get zid from zinvite code."""
    query = "SELECT zid FROM zinvites WHERE zinvite = %s LIMIT 1;"
    cursor = conn.cursor()
    cursor.execute(query, (zinvite,))
    result = cursor.fetchone()
    cursor.close()

    if result is None:
        raise ValueError(f"No conversation found for zinvite: {zinvite}")

    return result[0]


def get_conversation_info(conn, zid):
    """Get conversation metadata."""
    query = """
    SELECT c.zid, c.topic, c.created,
           COUNT(DISTINCT v.pid) as participant_count,
           COUNT(*) as vote_count,
           MIN(v.created) as first_vote,
           MAX(v.created) as last_vote
    FROM conversations c
    LEFT JOIN votes v ON c.zid = v.zid
    WHERE c.zid = %s AND v.zid IS NOT NULL
    GROUP BY c.zid, c.topic, c.created;
    """
    df = pd.read_sql(query, conn, params=(zid,))

    if df.empty:
        raise ValueError(f"No data found for conversation zid: {zid}")

    df['created'] = pd.to_datetime(df['created'], unit='ms')
    df['first_vote'] = pd.to_datetime(df['first_vote'], unit='ms')
    df['last_vote'] = pd.to_datetime(df['last_vote'], unit='ms')

    return df.iloc[0]


def load_votes(conn, zid):
    """Load all votes for a conversation."""
    query = """
    SELECT v.zid, v.pid, v.tid, v.vote, v.created
    FROM votes v
    WHERE v.zid = %s
    ORDER BY v.created;
    """
    df = pd.read_sql(query, conn, params=(zid,))
    df['created'] = pd.to_datetime(df['created'], unit='ms')
    return df


def compute_participation_matrix(votes_df):
    """Compute the participation matrix."""
    start_date = votes_df['created'].min().date()
    end_date = votes_df['created'].max().date()

    num_days = (end_date - start_date).days + 1
    all_days = [start_date + timedelta(days=i) for i in range(num_days)]

    votes_df['vote_date'] = votes_df['created'].dt.date
    votes_df['day_index'] = (votes_df['vote_date'] - start_date).apply(lambda x: x.days)

    participants = sorted(votes_df['pid'].unique())
    num_participants = len(participants)

    participation_matrix = np.zeros((num_participants, num_days), dtype=int)
    pid_to_row = {pid: i for i, pid in enumerate(participants)}

    for _, vote in votes_df.iterrows():
        row = pid_to_row[vote['pid']]
        col = vote['day_index']
        participation_matrix[row, col] = 1

    return participation_matrix, participants, all_days, start_date


def sort_participants(participation_matrix, participants):
    """Sort participants by join time and exit time."""
    num_days = participation_matrix.shape[1]
    participant_info = []

    for i, pid in enumerate(participants):
        row = participation_matrix[i]
        active_days = np.where(row > 0)[0]

        if len(active_days) > 0:
            first_day = active_days[0]
            last_day = active_days[-1]
            total_days = len(active_days)
        else:
            first_day = num_days
            last_day = num_days
            total_days = 0

        participant_info.append({
            'pid': pid,
            'row_index': i,
            'first_day': first_day,
            'last_day': last_day,
            'total_days_active': total_days
        })

    participant_df = pd.DataFrame(participant_info)
    participant_df = participant_df.sort_values(
        by=['first_day', 'last_day'],
        ascending=[True, True]
    )

    sorted_indices = participant_df['row_index'].values
    sorted_matrix = participation_matrix[sorted_indices, :].copy()
    sorted_pids = participant_df['pid'].values

    # Fill inactive days between first and last vote with "2"
    for i in range(sorted_matrix.shape[0]):
        active_days = np.where(sorted_matrix[i] > 0)[0]
        if len(active_days) > 0:
            first_day = active_days[0]
            last_day = active_days[-1]
            # Mark all days between first and last as 2 where there was no vote (value 0)
            for day in range(first_day, last_day + 1):
                if sorted_matrix[i, day] == 0:
                    sorted_matrix[i, day] = 2

    return sorted_matrix, sorted_pids, participant_df


def create_timeline_visualization(sorted_matrix, all_days, conversation_info, zinvite, output_dir):
    """Create the main timeline visualization."""
    num_participants, num_days = sorted_matrix.shape

    # Colormap: white for 0 (never participated), black for 1 (voted), pale pink for 2 (inactive between first/last)
    colors = ['white', 'black', '#FFE0E0']  # white, black, pale pink
    cmap = ListedColormap(colors)

    # Calculate figure size for square pixels
    # Make figure much wider to accommodate labels and give more space to the plot
    pixel_size = 0.01
    fig_width = max(20, min(40, num_days * pixel_size * 2))  # Make it at least 2x wider
    fig_height = max(6, min(30, num_participants * pixel_size))

    fig, ax = plt.subplots(figsize=(fig_width, fig_height))

    # Display matrix with square pixels
    im = ax.imshow(sorted_matrix, aspect='equal', cmap=cmap, interpolation='nearest', vmin=0, vmax=2)

    # Configure X-axis
    if USE_DATES_ON_XAXIS:
        if num_days <= 60:
            tick_interval = 5
        elif num_days <= 365:
            tick_interval = 30
        else:
            tick_interval = 60

        x_ticks = range(0, num_days, tick_interval)
        x_labels = [all_days[i].strftime('%Y-%m-%d') for i in x_ticks]
        ax.set_xticks(x_ticks)
        ax.set_xticklabels(x_labels, rotation=45, ha='right')
        ax.set_xlabel('Date', fontsize=11)
    else:
        ax.set_xlabel('Days since first vote', fontsize=11)

    # Y-axis: no tick labels
    ax.set_ylabel('Participants (sorted by join time)', fontsize=11)
    ax.set_yticks([])

    # Title
    topic = conversation_info['topic'] or 'Untitled'
    ax.set_title(f'Participation Timeline - {topic}\nzinvite: {zinvite}, {num_participants} participants × {num_days} days',
                 fontsize=12)

    # Colorbar
    cbar = plt.colorbar(im, ax=ax, label='Activity', ticks=[0, 1, 2], fraction=0.02, pad=0.02)
    cbar.ax.set_yticklabels(['Never participated', 'Voted', 'Inactive'])

    plt.tight_layout()

    # Save figure
    output_file = os.path.join(output_dir, f'{zinvite}_TimelineEngagement.png')
    plt.savefig(output_file, dpi=300, bbox_inches='tight')
    plt.close()

    print(f"  ✓ Saved timeline: {output_file}")
    return output_file


def create_plotly_timeline(sorted_matrix, all_days, conversation_info, zinvite, output_dir):
    """Create interactive Plotly timeline visualization."""
    if not PLOTLY_AVAILABLE:
        return None

    num_participants, num_days = sorted_matrix.shape

    # Create date labels
    date_labels = [day.strftime('%Y-%m-%d') for day in all_days]

    # Create participant labels (just indices, since we don't show IDs)
    participant_labels = list(range(num_participants))

    # Create custom hover text
    hover_text = []
    for i in range(num_participants):
        row_text = []
        for j in range(num_days):
            val = sorted_matrix[i, j]
            if val == 0:
                status = "Never participated"
            elif val == 1:
                status = "Voted"
            else:  # val == 2
                status = "Inactive (between first and last vote)"
            row_text.append(f'Date: {date_labels[j]}<br>Participant: {i}<br>Status: {status}')
        hover_text.append(row_text)

    # Create figure with custom colorscale: white (0), black (1), pale pink (2)
    fig = go.Figure(data=go.Heatmap(
        z=sorted_matrix,
        x=date_labels,
        y=participant_labels,
        colorscale=[
            [0.0, 'white'],      # 0 = never participated
            [0.5, 'black'],      # 1 = voted
            [1.0, '#FFE0E0']     # 2 = inactive between first/last
        ],
        zmin=0,
        zmax=2,
        showscale=False,  # Hide the colorbar
        hovertext=hover_text,
        hoverinfo='text'
    ))

    # Update layout for full-page display
    topic = conversation_info['topic'] or 'Untitled'
    fig.update_layout(
        title=dict(
            text=f'Participation Timeline - {topic}<br>zinvite: {zinvite}, {num_participants} participants × {num_days} days',
            x=0.5,
            xanchor='center',
            font=dict(size=16)
        ),
        xaxis_title='Date',
        yaxis_title='Participants (sorted by join time)',
        # Full page sizing
        autosize=True,
        margin=dict(l=80, r=20, t=100, b=80),
        yaxis=dict(
            showticklabels=False,  # Hide participant IDs
            fixedrange=False  # Allow zoom
        ),
        xaxis=dict(
            fixedrange=False,  # Allow zoom
            rangeslider=dict(visible=True, thickness=0.05),  # Add range slider
        ),
        hovermode='closest',
        paper_bgcolor='white',
        plot_bgcolor='white'
    )

    # Save as HTML
    output_file = os.path.join(output_dir, f'{zinvite}_TimelineEngagement_interactive.html')
    fig.write_html(output_file, include_plotlyjs='cdn')  # Use CDN to reduce file size

    print(f"  ✓ Saved interactive timeline: {output_file}")
    return output_file


def create_analysis_plots(sorted_matrix, all_days, participant_df, conversation_info, zinvite, output_dir):
    """Create supplementary analysis plots."""
    num_participants, num_days = sorted_matrix.shape

    fig, axes = plt.subplots(2, 2, figsize=(16, 10))

    # Overall figure title
    topic = conversation_info['topic'] or 'Untitled'
    fig.suptitle(f'Analysis Plots - {topic}\nzinvite: {zinvite}', fontsize=14, fontweight='bold', y=0.995)

    # Plot 1: Daily participant count
    ax1 = axes[0, 0]
    daily_participants = sorted_matrix.sum(axis=0)

    if USE_DATES_ON_XAXIS:
        dates = [all_days[i] for i in range(num_days)]
        ax1.plot(dates, daily_participants, linewidth=2, color='steelblue')
        ax1.fill_between(dates, daily_participants, alpha=0.3, color='steelblue')
        ax1.set_xlabel('Date', fontsize=11, fontweight='bold')
        for label in ax1.get_xticklabels():
            label.set_rotation(45)
            label.set_ha('right')
    else:
        ax1.plot(range(num_days), daily_participants, linewidth=2, color='steelblue')
        ax1.fill_between(range(num_days), daily_participants, alpha=0.3, color='steelblue')
        ax1.set_xlabel('Days since first vote', fontsize=11, fontweight='bold')

    ax1.set_ylabel('Number of active participants', fontsize=11, fontweight='bold')
    ax1.set_title('Daily Participation Over Time', fontsize=12, fontweight='bold')
    ax1.grid(True, alpha=0.3)

    # Plot 2: Cumulative participants joining
    ax2 = axes[0, 1]
    join_days = participant_df['first_day'].values
    unique_days, counts = np.unique(join_days, return_counts=True)
    cumulative_joins = np.cumsum(counts)

    if USE_DATES_ON_XAXIS:
        dates = [all_days[i] for i in unique_days]
        ax2.plot(dates, cumulative_joins, linewidth=2, color='darkgreen')
        ax2.fill_between(dates, cumulative_joins, alpha=0.3, color='darkgreen')
        ax2.set_xlabel('Date', fontsize=11, fontweight='bold')
        for label in ax2.get_xticklabels():
            label.set_rotation(45)
            label.set_ha('right')
    else:
        ax2.plot(unique_days, cumulative_joins, linewidth=2, color='darkgreen')
        ax2.fill_between(unique_days, cumulative_joins, alpha=0.3, color='darkgreen')
        ax2.set_xlabel('Days since first vote', fontsize=11, fontweight='bold')

    ax2.set_ylabel('Cumulative participants', fontsize=11, fontweight='bold')
    ax2.set_title('Participant Acquisition Over Time', fontsize=12, fontweight='bold')
    ax2.grid(True, alpha=0.3)

    # Plot 3: Distribution of participation duration
    ax3 = axes[1, 0]
    ax3.hist(participant_df['total_days_active'], bins=min(50, participant_df['total_days_active'].max()),
             color='coral', edgecolor='black', alpha=0.7)
    ax3.set_xlabel('Number of days active', fontsize=11, fontweight='bold')
    ax3.set_ylabel('Number of participants', fontsize=11, fontweight='bold')
    ax3.set_title('Distribution of Participation Duration', fontsize=12, fontweight='bold')
    ax3.grid(True, alpha=0.3, axis='y')

    # Plot 4: Distribution of join day
    ax4 = axes[1, 1]

    if USE_DATES_ON_XAXIS:
        join_dates = [all_days[day] for day in participant_df['first_day'].values]
        ax4.hist(join_dates, bins=min(50, num_days),
                 color='mediumpurple', edgecolor='black', alpha=0.7)
        ax4.set_xlabel('Date of first vote', fontsize=11, fontweight='bold')
        for label in ax4.get_xticklabels():
            label.set_rotation(45)
            label.set_ha('right')
    else:
        ax4.hist(participant_df['first_day'], bins=min(50, num_days),
                 color='mediumpurple', edgecolor='black', alpha=0.7)
        ax4.set_xlabel('Day of first vote', fontsize=11, fontweight='bold')

    ax4.set_ylabel('Number of participants', fontsize=11, fontweight='bold')
    ax4.set_title('Distribution of Participant Join Times', fontsize=12, fontweight='bold')
    ax4.grid(True, alpha=0.3, axis='y')

    plt.tight_layout()

    # Save figure
    output_file = os.path.join(output_dir, f'{zinvite}_analysis_plots.png')
    plt.savefig(output_file, dpi=300, bbox_inches='tight')
    plt.close()

    print(f"  ✓ Saved analysis: {output_file}")
    return output_file


def print_statistics(sorted_matrix, participant_df, all_days):
    """Print participation statistics."""
    num_participants, num_days = sorted_matrix.shape

    participant_df['span_days'] = participant_df['last_day'] - participant_df['first_day'] + 1
    participant_df['participation_rate'] = participant_df['total_days_active'] / participant_df['span_days']

    print("\n  PARTICIPATION STATISTICS:")
    print(f"    Matrix: {num_participants} participants × {num_days} days")
    print(f"    Sparsity: {(1 - sorted_matrix.sum() / sorted_matrix.size) * 100:.1f}% zeros")
    print(f"    One-day participants: {(participant_df['total_days_active'] == 1).sum()} ({(participant_df['total_days_active'] == 1).sum()/num_participants*100:.1f}%)")

    daily_participants = sorted_matrix.sum(axis=0)
    peak_day = daily_participants.argmax()
    print(f"    Peak participation: {daily_participants.max()} people on {all_days[peak_day]}")


def process_zinvite(conn, zinvite, output_dir):
    """Process a single zinvite."""
    print(f"\n{'='*60}")
    print(f"Processing zinvite: {zinvite}")
    print(f"{'='*60}")

    try:
        # Get conversation info
        zid = get_zid_from_zinvite(conn, zinvite)
        print(f"  Found zid: {zid}")

        conversation_info = get_conversation_info(conn, zid)
        print(f"  Topic: {conversation_info['topic'] or 'Untitled'}")
        print(f"  Participants: {conversation_info['participant_count']}")
        print(f"  Votes: {conversation_info['vote_count']}")

        # Load and process data
        print(f"  Loading votes...")
        votes_df = load_votes(conn, zid)

        print(f"  Computing participation matrix...")
        participation_matrix, participants, all_days, start_date = compute_participation_matrix(votes_df)

        print(f"  Sorting participants...")
        sorted_matrix, sorted_pids, participant_df = sort_participants(participation_matrix, participants)

        # Generate visualizations
        print(f"  Generating visualizations...")
        create_timeline_visualization(sorted_matrix, all_days, conversation_info, zinvite, output_dir)
        create_plotly_timeline(sorted_matrix, all_days, conversation_info, zinvite, output_dir)
        create_analysis_plots(sorted_matrix, all_days, participant_df, conversation_info, zinvite, output_dir)

        # Print statistics
        print_statistics(sorted_matrix, participant_df, all_days)

        print(f"\n  ✓ Successfully processed {zinvite}")
        return True

    except Exception as e:
        print(f"\n  ✗ Error processing {zinvite}: {str(e)}")
        return False


def main():
    """Main entry point."""
    if len(sys.argv) < 2:
        print("Usage: python participation_timeline.py <zinvite1> [zinvite2 ...]")
        print("\nExample:")
        print("  python participation_timeline.py 3yjmwkrw4c 69hm3zfanb")
        sys.exit(1)

    zinvites = sys.argv[1:]

    print(f"Participation Timeline Generator")
    print(f"Processing {len(zinvites)} zinvite(s)")

    # Create output directory
    output_dir = './timeline_output'
    os.makedirs(output_dir, exist_ok=True)
    print(f"Output directory: {output_dir}")

    # Connect to database
    print("\nConnecting to database...")
    conn = get_db_connection()
    print("✓ Connected")

    # Process each zinvite
    successful = 0
    failed = 0

    for zinvite in zinvites:
        if process_zinvite(conn, zinvite, output_dir):
            successful += 1
        else:
            failed += 1

    # Close connection
    conn.close()

    # Summary
    print(f"\n{'='*60}")
    print(f"SUMMARY")
    print(f"{'='*60}")
    print(f"  Total: {len(zinvites)}")
    print(f"  Successful: {successful}")
    print(f"  Failed: {failed}")
    print(f"  Output: {output_dir}/")
    print()


if __name__ == '__main__':
    main()
