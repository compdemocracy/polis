-- add ability for conversation moderators to toggle comment prioritization
-- add ability for conversation participants to prioritize comments

ALTER TABLE conversations
  ADD priority_type INTEGER NOT NULL
    DEFAULT (0)

ALTER TABLE votes 
  ADD high_priority BOOLEAN NOT NULL 
    DEFAULT (0)