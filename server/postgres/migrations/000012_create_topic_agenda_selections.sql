-- Migration: Create topic_agenda_selections table for storing user topic selections
-- This table stores archetypal comment selections that persist across Delphi runs

CREATE TABLE IF NOT EXISTS topic_agenda_selections (
    -- Primary key
    zid INTEGER NOT NULL,
    pid INTEGER NOT NULL,
    
    -- Selection data stored as JSONB for flexibility
    archetypal_selections JSONB NOT NULL DEFAULT '[]'::jsonb,
    
    -- Dedicated columns for metadata
    delphi_job_id TEXT,
    total_selections INTEGER NOT NULL DEFAULT 0,
    
    -- Timestamps
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    
    -- Composite primary key on conversation and participant
    PRIMARY KEY (zid, pid),
    
    -- Foreign key constraints
    CONSTRAINT fk_conversation
        FOREIGN KEY (zid) 
        REFERENCES conversations(zid) 
        ON DELETE CASCADE,
    
    CONSTRAINT fk_participant
        FOREIGN KEY (zid, pid) 
        REFERENCES participants(zid, pid) 
        ON DELETE CASCADE
);

-- Create indexes for better query performance
CREATE INDEX idx_topic_agenda_selections_zid ON topic_agenda_selections(zid);
CREATE INDEX idx_topic_agenda_selections_pid ON topic_agenda_selections(pid);
CREATE INDEX idx_topic_agenda_selections_delphi_job_id ON topic_agenda_selections(delphi_job_id);
CREATE INDEX idx_topic_agenda_selections_created_at ON topic_agenda_selections(created_at);

-- Add comments for documentation
COMMENT ON TABLE topic_agenda_selections IS 'Stores user topic agenda selections as archetypal comments that persist across Delphi runs';
COMMENT ON COLUMN topic_agenda_selections.zid IS 'Conversation ID (foreign key to conversations)';
COMMENT ON COLUMN topic_agenda_selections.pid IS 'Participant ID (foreign key to participants)';
COMMENT ON COLUMN topic_agenda_selections.archetypal_selections IS 'JSON array of selected topics with their archetypal comments';
COMMENT ON COLUMN topic_agenda_selections.delphi_job_id IS 'ID of the Delphi job that generated the topics';
COMMENT ON COLUMN topic_agenda_selections.total_selections IS 'Total number of topics selected by the user';
