-- Migration: Create auth0_user_mappings table
-- This table maps Auth0 user IDs (sub) to local user IDs (uid)
-- Used during the transition from cookie-based auth to Auth0 JWT auth

CREATE TABLE IF NOT EXISTS auth0_user_mappings (
    auth0_sub VARCHAR(255) PRIMARY KEY,
    uid INTEGER NOT NULL REFERENCES users(uid) ON DELETE CASCADE,
    created BIGINT DEFAULT now_as_millis(),
    
    -- Index for reverse lookups (find Auth0 user by local uid)
    UNIQUE(uid)
);

-- Create index for performance
CREATE INDEX IF NOT EXISTS idx_auth0_mappings_uid ON auth0_user_mappings(uid);

-- Comment on table and columns for documentation
COMMENT ON TABLE auth0_user_mappings IS 'Maps Auth0 user IDs to local Polis user IDs during auth migration';
COMMENT ON COLUMN auth0_user_mappings.auth0_sub IS 'Auth0 subject (sub) claim from JWT';
COMMENT ON COLUMN auth0_user_mappings.uid IS 'Local Polis user ID';
COMMENT ON COLUMN auth0_user_mappings.created IS 'Timestamp when mapping was created'; 