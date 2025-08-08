#!/bin/bash
#
# Reset all Delphi data for a conversation
# Usage: ./reset_conversation.sh <conversation_id_or_report_id>
#

if [ $# -eq 0 ]; then
    echo "Usage: $0 <conversation_id_or_report_id>"
    echo "Example: $0 19548"
    echo "Example: $0 r4tykwac8thvzv35jrn53"
    exit 1
fi

# Run the Python script inside the Docker container
docker exec polis-dev-delphi-1 python /app/scripts/reset_conversation.py "$1"