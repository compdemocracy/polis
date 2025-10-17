#!/bin/bash
#
# Reset all Delphi data for a conversation
# Usage: ./reset_conversation.sh <zid> [rid]
#

if [ $# -eq 0 ]; then
    echo "Usage: $0 <zid> [rid]"
    echo "  zid: Numeric conversation ID (required)"
    echo "  rid: Report ID starting with 'r' (optional)"
    echo "Examples:"
    echo "  $0 19548"
    echo "  $0 19548 r4tykwac8thvzv35jrn53"
    exit 1
fi

# Validate zid (first argument must be numeric)
if ! [[ $1 =~ ^[0-9]+$ ]]; then
    echo "Error: First argument must be a numeric conversation ID (zid)"
    echo "Usage: $0 <zid> [rid]"
    exit 1
fi

# Build the command
cmd="docker exec polis-dev-delphi-1 python /app/umap_narrative/reset_conversation.py --zid $1"

# Add rid if provided
if [ $# -eq 2 ]; then
    if [[ $2 =~ ^r[0-9a-z]+$ ]]; then
        cmd="$cmd --rid $2"
    else
        echo "Error: Second argument must be a report ID starting with 'r'"
        exit 1
    fi
fi

# Run the command
eval $cmd
