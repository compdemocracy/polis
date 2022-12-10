ALTER TABLE conversations
  ADD priority_type BOOLEAN NOT NULL
    DEFAULT (false);

ALTER TABLE votes 
  ADD high_priority BOOLEAN NOT NULL 
    DEFAULT (null);