-- Migration: Treevite (wave-based invite) core schema

-- 1) Conversation-level configuration
ALTER TABLE conversations
    ADD COLUMN IF NOT EXISTS treevite_enabled BOOLEAN DEFAULT FALSE;

COMMENT ON COLUMN conversations.treevite_enabled IS 'Enable wave-based invite (Treevite) for this conversation';

-- 2) Per-wave tracking
CREATE TABLE IF NOT EXISTS treevite_waves (
    id BIGSERIAL PRIMARY KEY,
    zid INTEGER NOT NULL,
    wave INTEGER NOT NULL,
    parent_wave INTEGER,
    -- Optional summary count (can be derived from treevite_invites)
    size INTEGER,
    invites_per_user INTEGER NOT NULL,
    owner_invites INTEGER NOT NULL DEFAULT 0,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT treevite_waves_zid_fkey
        FOREIGN KEY (zid) REFERENCES conversations(zid) ON DELETE CASCADE,
    CONSTRAINT treevite_waves_zid_wave_key
        UNIQUE (zid, wave),
    CONSTRAINT treevite_waves_wave_check CHECK (wave >= 1),
    CONSTRAINT treevite_waves_size_check CHECK (size IS NULL OR size >= 0),
    CONSTRAINT treevite_waves_invites_per_user_check CHECK (invites_per_user >= 0),
    CONSTRAINT treevite_waves_owner_invites_check CHECK (owner_invites >= 0),
    CONSTRAINT treevite_waves_not_both_zero CHECK (invites_per_user > 0 OR owner_invites > 0),
    CONSTRAINT treevite_waves_parent_wave_check CHECK (parent_wave IS NULL OR parent_wave >= 0)
);

CREATE INDEX IF NOT EXISTS idx_treevite_waves_zid ON treevite_waves(zid);
CREATE INDEX IF NOT EXISTS idx_treevite_waves_wave ON treevite_waves(wave);
CREATE INDEX IF NOT EXISTS idx_treevite_waves_parent ON treevite_waves(zid, parent_wave);

COMMENT ON TABLE treevite_waves IS 'Per-wave configuration and summary for Treevite invites';
COMMENT ON COLUMN treevite_waves.wave IS 'Wave number (1-based); unique per conversation';
COMMENT ON COLUMN treevite_waves.parent_wave IS 'Parent wave number for deriving next wave; 0 for root, NULL means default to greatest existing wave for this zid or 0 if none';
COMMENT ON COLUMN treevite_waves.size IS 'Optional cached size of the wave; derived as (parent_size or 1) * invites_per_user + owner_invites';
COMMENT ON COLUMN treevite_waves.invites_per_user IS 'Number of invites granted to each participant in this wave';
COMMENT ON COLUMN treevite_waves.owner_invites IS 'Number of owner-controlled invites added to this wave';

-- 3) Per-invite tracking and parent-child relationships
CREATE TABLE IF NOT EXISTS treevite_invites (
    id BIGSERIAL PRIMARY KEY,
    zid INTEGER NOT NULL,
    wave_id BIGINT NOT NULL,
    parent_invite_id BIGINT,

    -- Invite lifecycle and ownership
    invite_code VARCHAR(64) NOT NULL,
    status SMALLINT NOT NULL DEFAULT 0, -- 0=unused, 1=used, 2=revoked, 3=expired

    invite_owner_pid INTEGER,           -- owner participant (who can distribute this invite)
    invite_used_by_pid INTEGER,         -- participant who consumed this invite
    invite_used_at TIMESTAMP WITH TIME ZONE,

    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT treevite_invites_zid_fkey
        FOREIGN KEY (zid) REFERENCES conversations(zid) ON DELETE CASCADE,
    CONSTRAINT treevite_invites_wave_id_fkey
        FOREIGN KEY (wave_id) REFERENCES treevite_waves(id) ON DELETE CASCADE,
    CONSTRAINT treevite_invites_parent_invite_id_fkey
        FOREIGN KEY (parent_invite_id) REFERENCES treevite_invites(id) ON DELETE SET NULL,
    CONSTRAINT treevite_invites_owner_fkey
        FOREIGN KEY (zid, invite_owner_pid) REFERENCES participants(zid, pid),
    CONSTRAINT treevite_invites_used_by_fkey
        FOREIGN KEY (zid, invite_used_by_pid) REFERENCES participants(zid, pid),
    CONSTRAINT treevite_invites_code_unique
        UNIQUE (zid, invite_code),
    CONSTRAINT treevite_invites_status_check
        CHECK (status IN (0, 1, 2, 3))
);

CREATE INDEX IF NOT EXISTS idx_treevite_invites_zid ON treevite_invites(zid);
CREATE INDEX IF NOT EXISTS idx_treevite_invites_zid_status ON treevite_invites(zid, status);
CREATE INDEX IF NOT EXISTS idx_treevite_invites_wave_id ON treevite_invites(wave_id);
CREATE INDEX IF NOT EXISTS idx_treevite_invites_parent ON treevite_invites(parent_invite_id);
CREATE INDEX IF NOT EXISTS idx_treevite_invites_owner_pid ON treevite_invites(invite_owner_pid);
CREATE INDEX IF NOT EXISTS idx_treevite_invites_used_by_pid ON treevite_invites(invite_used_by_pid);
CREATE INDEX IF NOT EXISTS idx_treevite_invites_code ON treevite_invites(invite_code);

COMMENT ON TABLE treevite_invites IS 'Per-invite records for Treevite, including ownership, usage, and parent-child edges';
COMMENT ON COLUMN treevite_invites.invite_code IS 'Code shared by participants to grant access; unique per conversation';
COMMENT ON COLUMN treevite_invites.status IS '0=unused, 1=used, 2=revoked, 3=expired';
COMMENT ON COLUMN treevite_invites.invite_owner_pid IS 'PID of participant who owns/distributes this invite (NULL for root invites)';
COMMENT ON COLUMN treevite_invites.invite_used_by_pid IS 'PID of participant who consumed the invite (NULL until used)';

-- 4) Per-participant login codes (distinct from invite codes)
--    Enables code-based logins for anonymous/XID-like participants across devices
CREATE TABLE IF NOT EXISTS treevite_login_codes (
    id BIGSERIAL PRIMARY KEY,
    zid INTEGER NOT NULL,
    pid INTEGER NOT NULL,

    -- Store only a slow salted hash of the login code (e.g., argon2/bcrypt)
    login_code_hash TEXT NOT NULL,

    -- Indexable deterministic fingerprint (e.g., HMAC with server secret) for lookup
    login_code_fingerprint VARCHAR(128) NOT NULL,
    -- Peppered SHA-256 lookup hash for O(1) lookups
    login_code_lookup VARCHAR(128),
    fp_kid SMALLINT NOT NULL DEFAULT 1, -- key id for fingerprint secret rotation

    revoked BOOLEAN NOT NULL DEFAULT FALSE,
    expires_at TIMESTAMP WITH TIME ZONE,
    last_used_at TIMESTAMP WITH TIME ZONE,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT treevite_login_codes_participant_fkey
        FOREIGN KEY (zid, pid) REFERENCES participants(zid, pid) ON DELETE CASCADE,
    CONSTRAINT treevite_login_codes_pid_unique
        UNIQUE (zid, pid),
    CONSTRAINT treevite_login_codes_fp_unique
        UNIQUE (zid, login_code_fingerprint),
    CONSTRAINT treevite_login_codes_lookup_unique
        UNIQUE (zid, login_code_lookup)
);

CREATE INDEX IF NOT EXISTS idx_treevite_login_codes_zid ON treevite_login_codes(zid);
CREATE INDEX IF NOT EXISTS idx_treevite_login_codes_pid ON treevite_login_codes(pid);
CREATE INDEX IF NOT EXISTS idx_treevite_login_codes_fp ON treevite_login_codes(login_code_fingerprint);
CREATE INDEX IF NOT EXISTS idx_treevite_login_codes_lookup ON treevite_login_codes(zid, login_code_lookup);

COMMENT ON TABLE treevite_login_codes IS 'Per-participant Treevite login codes: salted hash for verification plus HMAC fingerprint for lookup';
COMMENT ON COLUMN treevite_login_codes.login_code_hash IS 'Slow salted hash (argon2/bcrypt) of the participant login code; the raw code is never stored';
COMMENT ON COLUMN treevite_login_codes.login_code_fingerprint IS 'Indexable HMAC-derived fingerprint scoped by conversation for fast lookup';
COMMENT ON COLUMN treevite_login_codes.login_code_lookup IS 'Peppered SHA-256 of login_code for O(1) lookup; verify with bcrypt hash after lookup';
