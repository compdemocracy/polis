ALTER TABLE xids
  DROP CONSTRAINT IF EXISTS xids_owner_uid_key;

DO $$
BEGIN
    IF NOT EXISTS ( SELECT  constraint_schema
                ,       constraint_name
                FROM    information_schema.constraint_column_usage
                WHERE   constraint_name = 'xids_owner_xid_key'
              )
    THEN
        ALTER TABLE xids ADD CONSTRAINT xids_owner_xid_key UNIQUE (owner, xid);
    END IF;
END$$;
