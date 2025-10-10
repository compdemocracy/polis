#!/bin/bash

# Script to remove PostGIS extension and all spatial data from PostgreSQL database
# This script reverts the database from PostGIS-enabled back to standard PostgreSQL v17

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

echo "Removing PostGIS extension and spatial data..."
echo "Database: $POSTGRES_DB"
echo "Host: $POSTGRES_HOST:$POSTGRES_PORT"
echo "User: $POSTGRES_USER"

# SQL commands to remove PostGIS
REMOVE_POSTGIS_SQL="
-- Step 1: Identify and drop spatial tables (if any exist)
DO \$\$
DECLARE
    table_record RECORD;
BEGIN
    -- Check if geometry_columns view exists (PostGIS metadata)
    IF EXISTS (SELECT 1 FROM information_schema.views WHERE table_name = 'geometry_columns') THEN
        RAISE NOTICE 'Found geometry_columns view - PostGIS is installed';
        
        -- Find and drop tables with geometry columns
        FOR table_record IN 
            SELECT f_table_schema, f_table_name 
            FROM geometry_columns 
            WHERE f_table_schema = 'public'
        LOOP
            RAISE NOTICE 'Dropping spatial table: %.%', table_record.f_table_schema, table_record.f_table_name;
            EXECUTE 'DROP TABLE IF EXISTS ' || quote_ident(table_record.f_table_schema) || '.' || quote_ident(table_record.f_table_name) || ' CASCADE';
        END LOOP;
    ELSE
        RAISE NOTICE 'geometry_columns view not found - no spatial tables detected';
    END IF;
END
\$\$;

-- Step 2: Remove spatial reference system entries (if any custom ones exist)
-- Note: This only removes custom entries, not the default PostGIS ones
DELETE FROM spatial_ref_sys WHERE srid > 100000;

-- Step 3: Drop PostGIS-related extensions
DROP EXTENSION IF EXISTS postgis_topology CASCADE;
DROP EXTENSION IF EXISTS postgis_raster CASCADE;
DROP EXTENSION IF EXISTS postgis CASCADE;

-- Step 4: Verify removal by checking if PostGIS functions exist
DO \$\$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'postgis_full_version') THEN
        RAISE EXCEPTION 'PostGIS removal failed - PostGIS functions still exist';
    ELSE
        RAISE NOTICE 'PostGIS successfully removed - no PostGIS functions found';
    END IF;
END
\$\$;
"

# Check if we're running with Docker
if command -v docker-compose >/dev/null 2>&1 && [ -f docker-compose.yml ]; then
    echo "Docker Compose detected. Attempting to remove PostGIS via Docker container..."
    
    # Try to execute SQL using docker-compose exec
    if docker-compose ps postgres | grep -q "Up"; then
        echo "PostgreSQL container is running. Executing PostGIS removal..."
        
        # Execute PostGIS removal
        docker-compose exec -T postgres psql \
            --host=localhost \
            --port=5432 \
            --username="$POSTGRES_USER" \
            --dbname="$POSTGRES_DB" \
            --command="$REMOVE_POSTGIS_SQL"
        
        echo "✅ PostGIS removal completed via Docker!"
        
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
    
    # Execute PostGIS removal
    psql \
        --host="$POSTGRES_HOST" \
        --port="$POSTGRES_PORT" \
        --username="$POSTGRES_USER" \
        --dbname="$POSTGRES_DB" \
        --command="$REMOVE_POSTGIS_SQL"
    
    # Unset password
    unset PGPASSWORD
    
    echo "✅ PostGIS removal completed!"
fi

echo ""
echo "PostGIS removal summary:"
echo "- PostGIS extension and all related extensions removed"
echo "- Any spatial tables with geometry columns dropped"
echo "- Custom spatial reference system entries removed"
echo "- Database reverted to standard PostgreSQL v17"

echo ""
echo "Verification: Attempting to query PostGIS version (should fail)..."
if command -v docker-compose >/dev/null 2>&1 && [ -f docker-compose.yml ]; then
    if docker-compose ps postgres | grep -q "Up"; then
        # This should fail if PostGIS is properly removed
        docker-compose exec -T postgres psql \
            --host=localhost \
            --port=5432 \
            --username="$POSTGRES_USER" \
            --dbname="$POSTGRES_DB" \
            --command="SELECT PostGIS_full_version();" 2>/dev/null || echo "✅ Confirmed: PostGIS function no longer exists"
    fi
else
    export PGPASSWORD="$POSTGRES_PASSWORD"
    # This should fail if PostGIS is properly removed
    psql \
        --host="$POSTGRES_HOST" \
        --port="$POSTGRES_PORT" \
        --username="$POSTGRES_USER" \
        --dbname="$POSTGRES_DB" \
        --command="SELECT PostGIS_full_version();" 2>/dev/null || echo "✅ Confirmed: PostGIS function no longer exists"
    unset PGPASSWORD
fi
