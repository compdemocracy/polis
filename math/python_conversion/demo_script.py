"""
Demo script to showcase the core functionality of the Pol.is math system.
"""

import random
import time
from polismath.conversation import ConversationManager

def main():
    # Create a conversation manager with local data storage
    print("Creating conversation manager...")
    manager = ConversationManager(data_dir="./data")
    
    # Create a new conversation
    conv_id = f"demo-conversation-{int(time.time())}"
    print(f"Creating conversation {conv_id}...")
    manager.create_conversation(conv_id)
    
    # Generate synthetic votes with two distinct opinion groups
    print("Generating synthetic votes with two distinct opinion groups...")
    participants = [f"p{i}" for i in range(100)]
    comments = [f"c{i}" for i in range(20)]
    
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
    print(f"Processing {len(votes['votes'])} votes...")
    conv = manager.process_votes(conv_id, votes)
    
    # Get results
    print("\nRESULTS:")
    print(f"Participant count: {conv.participant_count}")
    print(f"Comment count: {conv.comment_count}")
    print(f"Group count: {len(conv.group_clusters)}")
    
    # Get top representative comments for each group
    print("\nTOP REPRESENTATIVE COMMENTS BY GROUP:")
    for group_id, comments in conv.repness["group_repness"].items():
        print(f"Group {group_id} top comments:")
        for comment in comments[:3]:
            print(f"  - Comment {comment['comment_id']} ({comment['repful']})")
    
    # Print some clustering information
    print("\nCLUSTERING INFORMATION:")
    for cluster in conv.group_clusters:
        print(f"Cluster {cluster['id']} has {len(cluster['members'])} participants")
    
    # Print PCA information
    print("\nPCA INFORMATION:")
    print(f"PCA variance explained: {conv.pca['variance_explained']}")
    
    # Export the conversation data
    export_path = f"./data/{conv_id}_export.json"
    print(f"\nExporting conversation data to {export_path}...")
    manager.export_conversation(conv_id, export_path)
    
    print("\nDemo completed successfully!")

if __name__ == "__main__":
    main()