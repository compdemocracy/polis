ALTER TABLE xids
￼  DROP CONSTRAINT xids_owner_uid_key,
￼  ADD CONSTRAINT xids_owner_xid_key UNIQUE (owner, xid);

/*https://github.com/compdemocracy/polis/pull/970*/