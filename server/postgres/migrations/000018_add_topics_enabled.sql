-- ============================================================================
-- Migration: Add topics feature flag to conversations
-- ============================================================================
-- This migration adds support for enabling/disabling the topics feature
-- on a per-conversation basis.
-- ============================================================================

-- Add boolean flag to enable topics feature for a conversation
ALTER TABLE conversations
ADD COLUMN topics_enabled BOOLEAN NOT NULL DEFAULT false;

COMMENT ON COLUMN conversations.topics_enabled IS 'Enable topics feature (topic agenda) for this conversation';

