ALTER TABLE conversations
  ADD importance_enabled BOOLEAN NOT NULL
    DEFAULT (false);

ALTER TABLE votes
  ADD high_priority BOOLEAN NOT NULL
    DEFAULT (false);
