ALTER TABLE conversations
  DROP COLUMN priority_type;

ALTER TABLE votes
  DROP COLUMN high_priority;

ALTER TABLE conversations
  ADD priority_type BOOLEAN NOT NULL
    DEFAULT (false);

ALTER TABLE votes 
  ADD high_priority BOOLEAN NOT NULL 
    DEFAULT (false);