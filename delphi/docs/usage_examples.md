# Pol.is Math Python Usage Examples

This document provides examples of how to use the Python conversion of the Pol.is math codebase.

## Basic Usage

### Initialize a Conversation Manager

```python
from polismath.conversation import ConversationManager

# Create a conversation manager with data persistence
manager = ConversationManager(data_dir="/path/to/data")

# Or without persistence
manager = ConversationManager()
```

### Create a New Conversation

```python
conversation_id = "my-conversation-123"
conv = manager.create_conversation(conversation_id)
```

### Process Votes

```python
# Process a batch of votes
votes = {
    "votes": [
        {"pid": "participant1", "tid": "comment1", "vote": 1},
        {"pid": "participant1", "tid": "comment2", "vote": -1},
        {"pid": "participant2", "tid": "comment1", "vote": 1},
        {"pid": "participant2", "tid": "comment3", "vote": 1},
        {"pid": "participant3", "tid": "comment2", "vote": -1},
    ],
    "lastVoteTimestamp": 1615293000000  # Optional timestamp
}

updated_conv = manager.process_votes(conversation_id, votes)
```

### Update Moderation

```python
# Apply moderation settings
moderation = {
    "mod_out_tids": ["comment2"],  # Exclude comment2
    "mod_in_tids": ["comment1"],    # Feature comment1
    "meta_tids": [],                # No meta comments
    "mod_out_ptpts": []             # No excluded participants
}

updated_conv = manager.update_moderation(conversation_id, moderation)
```

### Force Recomputation

```python
# Force recomputation of clustering, PCA, etc.
updated_conv = manager.recompute(conversation_id)
```

### Export and Import Conversations

```python
# Export a conversation to a file
manager.export_conversation(conversation_id, "/path/to/export.json")

# Import a conversation from a file
imported_id = manager.import_conversation("/path/to/export.json")
```

## Advanced Usage

### Working with DataFrames

```python
import pandas as pd
import numpy as np

# Create a DataFrame with vote data
data = np.array([
    [1, -1, 0],
    [1, 0, 1],
    [-1, -1, 1]
])
row_names = ["participant1", "participant2", "participant3"]
col_names = ["comment1", "comment2", "comment3"]

df = pd.DataFrame(data, index=row_names, columns=col_names)

# Update a value
df.at["participant1", "comment3"] = 1

# Create a subset
group1_matrix = df.loc[["participant1", "participant2"]]

# Get a row by name
votes = df.loc["participant1"].values
```

### PCA and Clustering

```python
from polismath.pca_kmeans_rep.pca import pca_project_dataframe
from polismath.pca_kmeans_rep.clusters import cluster_dataframe

# Perform PCA
pca_results, projections = pca_project_dataframe(df)

# Cluster the DataFrame
clusters = cluster_dataframe(df, k=3)

# Examine clusters
for cluster in clusters:
    print(f"Cluster {cluster['id']} members: {cluster['members']}")
```

### Representativeness Calculation

```python
from polismath.pca_kmeans_rep.repness import conv_repness

# Calculate representativeness
repness = conv_repness(df, clusters)

# Get representative comments for each group
for group_id, comments in repness["group_repness"].items():
    print(f"Group {group_id} representative comments:")
    for comment in comments:
        direction = "agrees with" if comment["repful"] == "agree" else "disagrees with"
        print(f"  - Group {direction} comment {comment['comment_id']}")
```

### Statistical Functions

```python
from polismath.pca_kmeans_rep.stats import prop_test, two_prop_test

# Test proportion difference
z_score = prop_test(70, 100)  # 70 successes out of 100 trials
print(f"Z-score: {z_score}")

# Compare two proportions
z_score = two_prop_test(70, 100, 50, 100)  # 70/100 vs 50/100
print(f"Comparison Z-score: {z_score}")
```

## Practical Examples

### Setting Up a Demo Conversation

```python
from polismath.conversation import ConversationManager
import random

# Create a manager
manager = ConversationManager()

# Create conversation
conv_id = "demo-conversation"
manager.create_conversation(conv_id)

# Generate synthetic votes
participants = [f"p{i}" for i in range(100)]
comments = [f"c{i}" for i in range(20)]

# Create two distinct opinion groups
votes = {"votes": []}

for p_idx, pid in enumerate(participants):
    # First group tends to agree with first half of comments
    # Second group tends to agree with second half
    group = 0 if p_idx < 50 else 1
    
    for c_idx, cid in enumerate(comments):
        # Determine tendency to agree based on group and comment
        if (group == 0 and c_idx < 10) or (group == 1 and c_idx >= 10):
            agree_prob = 0.8  # High probability of agreement
        else:
            agree_prob = 0.2  # Low probability of agreement
        
        # Randomly determine vote (1=agree, -1=disagree, None=pass)
        r = random.random()
        if r < agree_prob:
            vote = 1
        elif r < agree_prob + 0.15:
            vote = -1
        else:
            continue  # Skip this vote (pass)
        
        # Add vote
        votes["votes"].append({
            "pid": pid,
            "tid": cid,
            "vote": vote
        })

# Process all votes
conv = manager.process_votes(conv_id, votes)

# Get results
print(f"Participant count: {conv.participant_count}")
print(f"Comment count: {conv.comment_count}")
print(f"Group count: {len(conv.group_clusters)}")

# Get top representative comments
for group_id, comments in conv.repness["group_repness"].items():
    print(f"Group {group_id} top comments:")
    for comment in comments[:3]:
        print(f"  - {comment['comment_id']} ({comment['repful']})")
```

### Creating a Simple API

```python
from fastapi import FastAPI, HTTPException
from pydantic import BaseModel
from typing import List, Dict, Any, Optional
from polismath.conversation import ConversationManager

app = FastAPI()
manager = ConversationManager(data_dir="/path/to/data")

class Vote(BaseModel):
    pid: str
    tid: str
    vote: int

class VoteRequest(BaseModel):
    votes: List[Vote]

class ModerationRequest(BaseModel):
    mod_out_tids: Optional[List[str]] = None
    mod_in_tids: Optional[List[str]] = None
    meta_tids: Optional[List[str]] = None
    mod_out_ptpts: Optional[List[str]] = None

@app.post("/api/v3/votes/{conversation_id}")
def process_votes(conversation_id: str, vote_request: VoteRequest):
    # Convert to format expected by conversation manager
    votes = {
        "votes": [
            {"pid": vote.pid, "tid": vote.tid, "vote": vote.vote}
            for vote in vote_request.votes
        ]
    }
    
    # Process votes
    conv = manager.process_votes(conversation_id, votes)
    
    # Return summary
    return conv.get_summary()

@app.post("/api/v3/moderation/{conversation_id}")
def update_moderation(conversation_id: str, mod_request: ModerationRequest):
    # Convert to format expected by conversation manager
    moderation = {
        "mod_out_tids": mod_request.mod_out_tids or [],
        "mod_in_tids": mod_request.mod_in_tids or [],
        "meta_tids": mod_request.meta_tids or [],
        "mod_out_ptpts": mod_request.mod_out_ptpts or []
    }
    
    # Update moderation
    conv = manager.update_moderation(conversation_id, moderation)
    
    if not conv:
        raise HTTPException(status_code=404, detail="Conversation not found")
    
    # Return summary
    return conv.get_summary()

@app.get("/api/v3/conversations/{conversation_id}")
def get_conversation(conversation_id: str):
    # Get conversation
    conv = manager.get_conversation(conversation_id)
    
    if not conv:
        raise HTTPException(status_code=404, detail="Conversation not found")
    
    # Return full data
    return conv.get_full_data()

@app.get("/api/v3/conversations")
def list_conversations():
    # Get summaries of all conversations
    return manager.get_summary()
```
