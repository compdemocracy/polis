#!/bin/bash

# Script to anonymize the users table in the PostgreSQL database
# This script updates user data to protect privacy in development/testing environments

set -e  # Exit on any error

# Load environment variables from .env file if it exists
if [ -f .env ]; then
    echo "Loading environment variables from .env file..."
    source .env
fi

# Set default values if environment variables are not set
POSTGRES_DB=${POSTGRES_DB:-polis-dev}
POSTGRES_USER=${POSTGRES_USER:-postgres}
POSTGRES_PASSWORD=${POSTGRES_PASSWORD:-oiPorg3Nrz0yqDLE}
POSTGRES_HOST=${POSTGRES_HOST:-localhost}
POSTGRES_PORT=${POSTGRES_PORT:-5432}

echo "Anonymizing users table..."
echo "Database: $POSTGRES_DB"
echo "Host: $POSTGRES_HOST:$POSTGRES_PORT"
echo "User: $POSTGRES_USER"

# SQL query to anonymize users and participants_extended
ANONYMIZE_SQL="
UPDATE users SET 
    hname = 'hname-' || uid::text,
    pwhash = NULL,
    username = 'user-' || uid::text,
    email = 'user-' || uid::text || '@dev.pol.is'
WHERE uid IS NOT NULL;

UPDATE participants_extended SET 
    subscribe_email = NULL
WHERE subscribe_email IS NOT NULL;
"

# SQL query to anonymize xids - update xid_whitelist first, then xids
ANONYMIZE_XIDS_SQL="
-- First, update xid_whitelist by joining with xids to get the new format
UPDATE xid_whitelist 
SET xid = x.owner::text || '-' || x.uid::text
FROM xids x 
WHERE xid_whitelist.owner = x.owner 
  AND xid_whitelist.xid = x.xid;

-- Then update the xids table itself
UPDATE xids 
SET xid = owner::text || '-' || uid::text 
WHERE owner IS NOT NULL AND uid IS NOT NULL;
"

# Check if we're running with Docker
if command -v docker-compose >/dev/null 2>&1 && [ -f docker-compose.yml ]; then
    echo "Docker Compose detected. Attempting to anonymize via Docker container..."
    
    # Try to execute SQL using docker-compose exec
    if docker-compose ps postgres | grep -q "Up"; then
        echo "PostgreSQL container is running. Executing anonymization..."
        
        # Get count before anonymization
        BEFORE_COUNT=$(docker-compose exec -T postgres psql \
            --host=localhost \
            --port=5432 \
            --username="$POSTGRES_USER" \
            --dbname="$POSTGRES_DB" \
            --tuples-only \
            --command="SELECT COUNT(*) FROM users WHERE email NOT LIKE '%@dev.pol.is';")
        
        # Execute user anonymization
        docker-compose exec -T postgres psql \
            --host=localhost \
            --port=5432 \
            --username="$POSTGRES_USER" \
            --dbname="$POSTGRES_DB" \
            --command="$ANONYMIZE_SQL"
        
        # Execute xids anonymization
        echo "Anonymizing xids and xid_whitelist tables..."
        docker-compose exec -T postgres psql \
            --host=localhost \
            --port=5432 \
            --username="$POSTGRES_USER" \
            --dbname="$POSTGRES_DB" \
            --command="$ANONYMIZE_XIDS_SQL"
        
        # Get count after anonymization
        AFTER_COUNT=$(docker-compose exec -T postgres psql \
            --host=localhost \
            --port=5432 \
            --username="$POSTGRES_USER" \
            --dbname="$POSTGRES_DB" \
            --tuples-only \
            --command="SELECT COUNT(*) FROM users WHERE email LIKE '%@dev.pol.is';")
        
        # Get participants_extended count
        SUBSCRIBE_EMAIL_CLEARED=$(docker-compose exec -T postgres psql \
            --host=localhost \
            --port=5432 \
            --username="$POSTGRES_USER" \
            --dbname="$POSTGRES_DB" \
            --tuples-only \
            --command="SELECT COUNT(*) FROM participants_extended WHERE subscribe_email IS NULL;" 2>/dev/null || echo "0")
        
        # Get total xids counts (all will be anonymized)
        XIDS_COUNT=$(docker-compose exec -T postgres psql \
            --host=localhost \
            --port=5432 \
            --username="$POSTGRES_USER" \
            --dbname="$POSTGRES_DB" \
            --tuples-only \
            --command="SELECT COUNT(*) FROM xids WHERE owner IS NOT NULL AND uid IS NOT NULL;" 2>/dev/null || echo "0")
        
        XID_WHITELIST_COUNT=$(docker-compose exec -T postgres psql \
            --host=localhost \
            --port=5432 \
            --username="$POSTGRES_USER" \
            --dbname="$POSTGRES_DB" \
            --tuples-only \
            --command="SELECT COUNT(*) FROM xid_whitelist;" 2>/dev/null || echo "0")
        
            # Get xids counts
    XIDS_COUNT=$(psql \
        --host="$POSTGRES_HOST" \
        --port="$POSTGRES_PORT" \
        --username="$POSTGRES_USER" \
        --dbname="$POSTGRES_DB" \
        --tuples-only \
        --command="SELECT COUNT(*) FROM xids WHERE xid LIKE '%-%';" 2>/dev/null || echo "0")
    
    XID_WHITELIST_COUNT=$(psql \
        --host="$POSTGRES_HOST" \
        --port="$POSTGRES_PORT" \
        --username="$POSTGRES_USER" \
        --dbname="$POSTGRES_DB" \
        --tuples-only \
        --command="SELECT COUNT(*) FROM xid_whitelist WHERE xid LIKE '%-%';" 2>/dev/null || echo "0")
    
            echo "✅ Anonymization completed!"
        echo "Users with non-dev emails before: $(echo $BEFORE_COUNT | tr -d ' ')"
        echo "Users with dev emails after: $(echo $AFTER_COUNT | tr -d ' ')"
        echo "Subscribe emails cleared in participants_extended: $(echo $SUBSCRIBE_EMAIL_CLEARED | tr -d ' ')"
        echo "XIDs processed in xids table: $(echo $XIDS_COUNT | tr -d ' ')"
        echo "XIDs processed in xid_whitelist table: $(echo $XID_WHITELIST_COUNT | tr -d ' ')"
        
    else
        echo "PostgreSQL container is not running. Please start it with:"
        echo "docker-compose --profile postgres up -d"
        exit 1
    fi
else
    # Direct connection to PostgreSQL (not using Docker)
    echo "Connecting directly to PostgreSQL..."
    
    # Export password to avoid prompt
    export PGPASSWORD="$POSTGRES_PASSWORD"
    
    # Get count before anonymization
    BEFORE_COUNT=$(psql \
        --host="$POSTGRES_HOST" \
        --port="$POSTGRES_PORT" \
        --username="$POSTGRES_USER" \
        --dbname="$POSTGRES_DB" \
        --tuples-only \
        --command="SELECT COUNT(*) FROM users WHERE email NOT LIKE '%@dev.pol.is';")
    
    # Execute user anonymization
    psql \
        --host="$POSTGRES_HOST" \
        --port="$POSTGRES_PORT" \
        --username="$POSTGRES_USER" \
        --dbname="$POSTGRES_DB" \
        --command="$ANONYMIZE_SQL"
    
    # Execute xids anonymization
    echo "Anonymizing xids and xid_whitelist tables..."
    psql \
        --host="$POSTGRES_HOST" \
        --port="$POSTGRES_PORT" \
        --username="$POSTGRES_USER" \
        --dbname="$POSTGRES_DB" \
        --command="$ANONYMIZE_XIDS_SQL"
    
    # Get count after anonymization
    AFTER_COUNT=$(psql \
        --host="$POSTGRES_HOST" \
        --port="$POSTGRES_PORT" \
        --username="$POSTGRES_USER" \
        --dbname="$POSTGRES_DB" \
        --tuples-only \
        --command="SELECT COUNT(*) FROM users WHERE email LIKE '%@dev.pol.is';")
    
    # Get participants_extended count
    SUBSCRIBE_EMAIL_CLEARED=$(psql \
        --host="$POSTGRES_HOST" \
        --port="$POSTGRES_PORT" \
        --username="$POSTGRES_USER" \
        --dbname="$POSTGRES_DB" \
        --tuples-only \
        --command="SELECT COUNT(*) FROM participants_extended WHERE subscribe_email IS NULL;" 2>/dev/null || echo "0")
    
    # Get total xids counts (all will be anonymized)
    XIDS_COUNT=$(psql \
        --host="$POSTGRES_HOST" \
        --port="$POSTGRES_PORT" \
        --username="$POSTGRES_USER" \
        --dbname="$POSTGRES_DB" \
        --tuples-only \
        --command="SELECT COUNT(*) FROM xids WHERE owner IS NOT NULL AND uid IS NOT NULL;" 2>/dev/null || echo "0")
    
    XID_WHITELIST_COUNT=$(psql \
        --host="$POSTGRES_HOST" \
        --port="$POSTGRES_PORT" \
        --username="$POSTGRES_USER" \
        --dbname="$POSTGRES_DB" \
        --tuples-only \
        --command="SELECT COUNT(*) FROM xid_whitelist;" 2>/dev/null || echo "0")
    
    # Unset password
    unset PGPASSWORD
    
    echo "✅ Anonymization completed!"
    echo "Users with non-dev emails before: $(echo $BEFORE_COUNT | tr -d ' ')"
    echo "Users with dev emails after: $(echo $AFTER_COUNT | tr -d ' ')"
    echo "Subscribe emails cleared in participants_extended: $(echo $SUBSCRIBE_EMAIL_CLEARED | tr -d ' ')"
    echo "XIDs processed in xids table: $(echo $XIDS_COUNT | tr -d ' ')"
    echo "XIDs processed in xid_whitelist table: $(echo $XID_WHITELIST_COUNT | tr -d ' ')"
fi

# Tables to clear completely
TABLES_TO_CLEAR=(
    "demographic_data"
    "einvites"
    "email_validations"
    "facebook_friends"
    "facebook_users"
    "oinvites"
    "participant_locations"
    "suzinvites"
    "twitter_users"
)

echo ""
echo "Clearing sensitive data tables..."

# Function to get row count and clear table
clear_table() {
    local table_name=$1
    
    if command -v docker-compose >/dev/null 2>&1 && [ -f docker-compose.yml ]; then
        if docker-compose ps postgres | grep -q "Up"; then
            # Get count before clearing
            local before_count=$(docker-compose exec -T postgres psql \
                --host=localhost \
                --port=5432 \
                --username="$POSTGRES_USER" \
                --dbname="$POSTGRES_DB" \
                --tuples-only \
                --command="SELECT COUNT(*) FROM $table_name;" 2>/dev/null || echo "0")
            
            # Clear the table
            docker-compose exec -T postgres psql \
                --host=localhost \
                --port=5432 \
                --username="$POSTGRES_USER" \
                --dbname="$POSTGRES_DB" \
                --command="TRUNCATE TABLE $table_name CASCADE;" 2>/dev/null
            
            echo "  - $table_name: cleared $(echo $before_count | tr -d ' ') rows"
        fi
    else
        export PGPASSWORD="$POSTGRES_PASSWORD"
        
        # Get count before clearing
        local before_count=$(psql \
            --host="$POSTGRES_HOST" \
            --port="$POSTGRES_PORT" \
            --username="$POSTGRES_USER" \
            --dbname="$POSTGRES_DB" \
            --tuples-only \
            --command="SELECT COUNT(*) FROM $table_name;" 2>/dev/null || echo "0")
        
        # Clear the table
        psql \
            --host="$POSTGRES_HOST" \
            --port="$POSTGRES_PORT" \
            --username="$POSTGRES_USER" \
            --dbname="$POSTGRES_DB" \
            --command="TRUNCATE TABLE $table_name CASCADE;" 2>/dev/null
        
        echo "  - $table_name: cleared $(echo $before_count | tr -d ' ') rows"
        
        unset PGPASSWORD
    fi
}

# Clear each table
for table in "${TABLES_TO_CLEAR[@]}"; do
    clear_table "$table"
done

echo "✅ Sensitive data tables cleared!"

echo ""
echo "Sample of anonymized users:"
if command -v docker-compose >/dev/null 2>&1 && [ -f docker-compose.yml ]; then
    if docker-compose ps postgres | grep -q "Up"; then
        docker-compose exec -T postgres psql \
            --host=localhost \
            --port=5432 \
            --username="$POSTGRES_USER" \
            --dbname="$POSTGRES_DB" \
            --command="SELECT uid, hname, username, email FROM users LIMIT 5;"
        
        echo ""
        echo "Sample of anonymized xids:"
        docker-compose exec -T postgres psql \
            --host=localhost \
            --port=5432 \
            --username="$POSTGRES_USER" \
            --dbname="$POSTGRES_DB" \
            --command="SELECT owner, uid, xid FROM xids LIMIT 5;" 2>/dev/null || echo "No xids data to display"
    fi
else
    export PGPASSWORD="$POSTGRES_PASSWORD"
    psql \
        --host="$POSTGRES_HOST" \
        --port="$POSTGRES_PORT" \
        --username="$POSTGRES_USER" \
        --dbname="$POSTGRES_DB" \
        --command="SELECT uid, hname, username, email FROM users LIMIT 5;"
    
    echo ""
    echo "Sample of anonymized xids:"
    psql \
        --host="$POSTGRES_HOST" \
        --port="$POSTGRES_PORT" \
        --username="$POSTGRES_USER" \
        --dbname="$POSTGRES_DB" \
        --command="SELECT owner, uid, xid FROM xids LIMIT 5;" 2>/dev/null || echo "No xids data to display"
    
    unset PGPASSWORD
fi 