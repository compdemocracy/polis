-- ============================================================================
-- Migration: Add XID requirements and participant tracking
-- ============================================================================
-- This migration adds support for XID requirements on conversations,
-- conversation-scoped XID whitelisting, and participant tracking in xids table.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- conversations table
-- ----------------------------------------------------------------------------
-- Add flag to require XID authentication for participants

ALTER TABLE conversations
ADD COLUMN xid_required BOOLEAN NOT NULL DEFAULT false;

-- ----------------------------------------------------------------------------
-- xid_whitelist table
-- ----------------------------------------------------------------------------
-- Add conversation-scoped whitelisting support (zid column)
-- Allows whitelisting at both conversation level (zid) and legacy owner level

ALTER TABLE xid_whitelist
ADD COLUMN zid INTEGER;

ALTER TABLE xid_whitelist
ADD CONSTRAINT xid_whitelist_zid_fkey
    FOREIGN KEY (zid) REFERENCES conversations(zid) ON DELETE CASCADE;

CREATE INDEX idx_xid_whitelist_zid ON xid_whitelist(zid);

-- Performance index for efficient xid lookups
CREATE INDEX idx_xid_whitelist_xid ON xid_whitelist(xid);

-- ----------------------------------------------------------------------------
-- xids table
-- ----------------------------------------------------------------------------
-- Add conversation association (zid) and participant tracking (pid)
-- zid allows conversation-scoped XID records
-- pid links XID records to specific participants for tracking

-- Add conversation association column
ALTER TABLE xids
ADD COLUMN zid INTEGER;

ALTER TABLE xids
ADD CONSTRAINT xids_zid_fkey
    FOREIGN KEY (zid) REFERENCES conversations(zid) ON DELETE CASCADE;

-- Add participant tracking column
ALTER TABLE xids
ADD COLUMN pid INTEGER;

ALTER TABLE xids
ADD CONSTRAINT xids_pid_fkey
    FOREIGN KEY (pid) REFERENCES participants(pid) ON DELETE SET NULL;

-- Performance indexes for efficient xid lookups
CREATE INDEX idx_xids_zid ON xids(zid);
CREATE INDEX idx_xids_xid ON xids(xid);
CREATE INDEX idx_xids_pid ON xids(pid);

-- Composite indexes for optimized query performance
-- Helps with xids join condition: (x.zid = zid) OR (x.zid IS NULL AND x.owner = owner)
CREATE INDEX idx_xids_zid_xid ON xids(zid, xid);
-- Helps with participants join: p.uid = x.uid AND p.zid = zid
CREATE INDEX idx_xids_uid_zid ON xids(uid, zid);
