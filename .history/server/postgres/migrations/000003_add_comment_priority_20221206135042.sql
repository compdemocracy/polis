ALTER TABLE conversations
  ADD priority_type INTEGER NOT NULL
    DEFAULT (0);

ALTER TABLE votes 
  ADD high_priority BOOLEAN NOT NULL 
    DEFAULT (null);