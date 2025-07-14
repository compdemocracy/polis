-- Migration: Create oidc_user_mappings table
-- This table maps OIDC user IDs (sub) to local user IDs (uid)

CREATE TABLE IF NOT EXISTS oidc_user_mappings (
    oidc_sub VARCHAR(255) PRIMARY KEY,
    uid INTEGER NOT NULL REFERENCES users(uid) ON DELETE CASCADE,
    created BIGINT DEFAULT now_as_millis(),
    
    -- Index for reverse lookups (find OIDC user by local uid)
    UNIQUE(uid)
);

-- Create index for performance
CREATE INDEX IF NOT EXISTS idx_oidc_mappings_uid ON oidc_user_mappings(uid);

-- Comment on table and columns for documentation
COMMENT ON COLUMN oidc_user_mappings.oidc_sub IS 'OIDC subject (sub) claim from JWT';
COMMENT ON COLUMN oidc_user_mappings.uid IS 'Local Polis user ID';
COMMENT ON COLUMN oidc_user_mappings.created IS 'Timestamp when mapping was created'; 