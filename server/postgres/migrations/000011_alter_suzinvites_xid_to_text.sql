-- Migration: Alter suzinvites.xid from VARCHAR(32) to TEXT (NOT NULL)
-- This brings it in line with xid usage elsewhere (e.g., xids, xid_whitelist)

ALTER TABLE suzinvites
    ALTER COLUMN xid TYPE TEXT,
    ALTER COLUMN xid SET NOT NULL; 