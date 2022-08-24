ALTER TABLE xids
  DROP CONSTRAINT IF EXISTS xids_owner_uid_key,
  ADD CONSTRAINT xids_owner_xid_key UNIQUE (owner, xid);
