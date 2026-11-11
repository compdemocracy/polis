-- The shape of an installation whose database predates the migrations.
--
-- A database built from server/postgres/migrations and a database that was
-- already in service before those migrations existed hold the same tables,
-- but not always in the same shape: the older one stores the math documents
-- as json where the migrations build jsonb, keeps some columns in another
-- order, has a few columns the migrations never create and lacks two they do.
-- A statement can depend on any of these without saying so (a function that
-- exists for jsonb only, a `SELECT *` read by position), and no test of this
-- crate would notice, because every test builds its tables the migrations'
-- way.
--
-- Installing this file in a database makes every table created there
-- afterwards, under one of the thirteen names below, come out in the older
-- shape. The crate's database tests then run a second time, unchanged
-- (ci/local/polis-api.sh).
--
-- What is reshaped when a table is created:
--
--   1. In any table with one of these names, a column this file records as
--      json and that was declared jsonb becomes json.
--   2. A table declared with every column the first migration gives it is
--      taken to be the migrations' table. Its columns are put in the older
--      order, the columns only an older installation has are added in their
--      places, the columns it lacks are dropped, and a column that is
--      nullable there loses its NOT NULL. Constraints, defaults and owned
--      sequences are kept.
--
-- What is not:
--
--   * A table a test declares with fewer columns keeps the order the test
--     gave it (its rows are usually inserted by position); only rule 1
--     applies to it.
--   * A column added by a later migration is appended where that migration
--     puts it. Two tables therefore differ from an older installation in
--     their last columns: `conversations` (topics_enabled and xid_required
--     are in the other order there) and `participants_extended`
--     (permanent_cookie and origin come before modified there).
--   * Defaults of existing columns, constraint and index names, triggers and
--     function bodies are the migrations'.
--   * Tables created with CREATE TABLE AS, and tables altered after they are
--     created, are left as they are.
--
-- When a migration adds a column to one of the thirteen tables, add the
-- column below too, as the last row of that table and marked 'later': an
-- installation older than the migrations receives it from the same
-- migration, at the end of the table. 'first' is only for the columns
-- 000000_initial.sql creates: a table a test declares is reordered when it
-- has every 'first' column. The tests of this file fail until the row is
-- there (src/older_database_shape_tests.rs).
--
-- This is for test databases. It needs a superuser (event triggers do).

DROP EVENT TRIGGER IF EXISTS older_database_shape;
DROP SCHEMA IF EXISTS older_database_shape CASCADE;
CREATE SCHEMA older_database_shape;

-- Every column of the thirteen tables as an older installation has it, in its
-- order there. `migration` says where the migrations build the column:
-- 'first' (000000_initial.sql), 'later' (a later migration adds it) or
-- 'never' (only an older installation has it).
CREATE TABLE older_database_shape.columns (
    position integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    table_name text NOT NULL,
    column_name text NOT NULL,
    definition text NOT NULL,
    migration text NOT NULL CHECK (migration IN ('first', 'later', 'never')),
    UNIQUE (table_name, column_name)
);
INSERT INTO older_database_shape.columns (table_name, column_name, definition, migration) VALUES
  -- users
  ('users', 'uid', 'integer NOT NULL', 'first'),
  ('users', 'hname', 'character varying(746)', 'first'),
  ('users', 'pwhash', 'character varying(128)', 'never'),
  ('users', 'username', 'character varying(128)', 'first'),
  ('users', 'email', 'character varying(256)', 'first'),
  ('users', 'is_owner', 'boolean', 'first'),
  ('users', 'zinvite', 'character varying(300)', 'first'),
  ('users', 'oinvite', 'character varying(300)', 'first'),
  ('users', 'created', 'bigint', 'first'),
  ('users', 'tut', 'smallint', 'first'),
  ('users', 'site_id', 'character varying(256) NOT NULL', 'first'),
  ('users', 'site_owner', 'boolean', 'first'),
  ('users', 'test', 'boolean DEFAULT false', 'never'),
  -- conversations
  ('conversations', 'zid', 'integer NOT NULL', 'first'),
  ('conversations', 'topic', 'character varying(1000)', 'first'),
  ('conversations', 'description', 'character varying(50000)', 'first'),
  ('conversations', 'is_anon', 'boolean', 'first'),
  ('conversations', 'is_active', 'boolean', 'first'),
  ('conversations', 'is_draft', 'boolean', 'first'),
  ('conversations', 'is_public', 'boolean', 'first'),
  ('conversations', 'email_domain', 'character varying(200)', 'first'),
  ('conversations', 'owner', 'integer', 'first'),
  ('conversations', 'participant_count', 'integer', 'first'),
  ('conversations', 'created', 'bigint', 'first'),
  ('conversations', 'strict_moderation', 'boolean', 'first'),
  ('conversations', 'profanity_filter', 'boolean', 'first'),
  ('conversations', 'spam_filter', 'boolean', 'first'),
  ('conversations', 'context', 'character varying(1000)', 'first'),
  ('conversations', 'modified', 'bigint', 'first'),
  ('conversations', 'owner_sees_participation_stats', 'boolean', 'first'),
  ('conversations', 'course_id', 'integer', 'first'),
  ('conversations', 'link_url', 'character varying(9999)', 'first'),
  ('conversations', 'upvotes', 'integer NOT NULL', 'first'),
  ('conversations', 'parent_url', 'character varying(9999)', 'first'),
  ('conversations', 'vis_type', 'integer NOT NULL', 'first'),
  ('conversations', 'write_type', 'integer NOT NULL', 'first'),
  ('conversations', 'bgcolor', 'character varying(20)', 'first'),
  ('conversations', 'help_type', 'integer NOT NULL', 'first'),
  ('conversations', 'socialbtn_type', 'integer NOT NULL', 'first'),
  ('conversations', 'style_btn', 'character varying(500)', 'first'),
  ('conversations', 'auth_needed_to_vote', 'boolean', 'first'),
  ('conversations', 'auth_needed_to_write', 'boolean', 'first'),
  ('conversations', 'auth_opt_fb', 'boolean', 'first'),
  ('conversations', 'auth_opt_tw', 'boolean', 'first'),
  ('conversations', 'auth_opt_allow_3rdparty', 'boolean', 'first'),
  ('conversations', 'help_bgcolor', 'character varying(20)', 'first'),
  ('conversations', 'help_color', 'character varying(20)', 'first'),
  ('conversations', 'is_data_open', 'boolean', 'first'),
  ('conversations', 'is_curated', 'boolean DEFAULT false', 'never'),
  ('conversations', 'dataset_explanation', 'character varying(50000)', 'never'),
  ('conversations', 'write_hint_type', 'integer NOT NULL', 'first'),
  ('conversations', 'subscribe_type', 'integer NOT NULL', 'first'),
  ('conversations', 'org_id', 'integer', 'first'),
  ('conversations', 'need_suzinvite', 'boolean DEFAULT false', 'never'),
  ('conversations', 'use_xid_whitelist', 'boolean', 'first'),
  ('conversations', 'prioritize_seed', 'boolean', 'first'),
  ('conversations', 'importance_enabled', 'boolean NOT NULL', 'later'),
  ('conversations', 'treevite_enabled', 'boolean', 'later'),
  ('conversations', 'topics_enabled', 'boolean NOT NULL', 'later'),
  ('conversations', 'xid_required', 'boolean NOT NULL', 'later'),
  -- participants
  ('participants', 'pid', 'integer NOT NULL', 'first'),
  ('participants', 'uid', 'integer NOT NULL', 'first'),
  ('participants', 'zid', 'integer NOT NULL', 'first'),
  ('participants', 'created', 'bigint', 'first'),
  ('participants', 'vote_count', 'integer NOT NULL', 'first'),
  ('participants', 'last_interaction', 'bigint NOT NULL', 'first'),
  ('participants', 'subscribed', 'integer NOT NULL', 'first'),
  ('participants', 'last_notified', 'bigint', 'first'),
  ('participants', 'mod', 'integer NOT NULL', 'first'),
  ('participants', 'nsli', 'smallint NOT NULL', 'first'),
  -- participants_extended
  ('participants_extended', 'uid', 'integer NOT NULL', 'first'),
  ('participants_extended', 'zid', 'integer NOT NULL', 'first'),
  ('participants_extended', 'referrer', 'character varying(9999)', 'first'),
  ('participants_extended', 'parent_url', 'character varying(9999)', 'first'),
  ('participants_extended', 'created', 'bigint', 'first'),
  ('participants_extended', 'permanent_cookie', 'character varying(32)', 'later'),
  ('participants_extended', 'origin', 'character varying(9999)', 'later'),
  ('participants_extended', 'encrypted_ip_address', 'character varying(9999)', 'never'),
  ('participants_extended', 'encrypted_x_forwarded_for', 'character varying(9999)', 'never'),
  ('participants_extended', 'country_iso_code', 'character varying(10)', 'never'),
  ('participants_extended', 'modified', 'bigint NOT NULL', 'first'),
  ('participants_extended', 'show_translation_activated', 'boolean', 'first'),
  ('participants_extended', 'subscribe_email', 'character varying(256)', 'first'),
  -- comments
  ('comments', 'tid', 'integer NOT NULL', 'first'),
  ('comments', 'zid', 'integer NOT NULL', 'first'),
  ('comments', 'pid', 'integer NOT NULL', 'first'),
  ('comments', 'txt', 'character varying(1000) NOT NULL', 'first'),
  ('comments', 'created', 'bigint', 'first'),
  ('comments', 'velocity', 'real', 'first'),
  ('comments', 'mod', 'integer NOT NULL', 'first'),
  ('comments', 'active', 'boolean NOT NULL', 'first'),
  ('comments', 'modified', 'bigint', 'first'),
  ('comments', 'uid', 'integer NOT NULL', 'first'),
  ('comments', 'tweet_id', 'bigint', 'first'),
  ('comments', 'quote_src_url', 'character varying(1000)', 'first'),
  ('comments', 'anon', 'boolean NOT NULL', 'first'),
  ('comments', 'is_seed', 'boolean NOT NULL', 'first'),
  ('comments', 'curation', 'smallint NOT NULL DEFAULT 0', 'never'),
  ('comments', 'is_meta', 'boolean NOT NULL', 'first'),
  ('comments', 'lang_confidence', 'real', 'first'),
  ('comments', 'lang', 'character varying(10)', 'first'),
  ('comments', 'original_id', 'uuid', 'later'),
  -- votes
  ('votes', 'zid', 'integer NOT NULL', 'first'),
  ('votes', 'pid', 'integer NOT NULL', 'first'),
  ('votes', 'tid', 'integer NOT NULL', 'first'),
  ('votes', 'vote', 'smallint', 'first'),
  ('votes', 'created', 'bigint', 'first'),
  ('votes', 'weight_x_32767', 'smallint', 'first'),
  ('votes', 'high_priority', 'boolean NOT NULL', 'later'),
  -- xids
  ('xids', 'uid', 'integer NOT NULL', 'first'),
  ('xids', 'owner', 'integer NOT NULL', 'first'),
  ('xids', 'xid', 'text NOT NULL', 'first'),
  ('xids', 'created', 'bigint', 'first'),
  ('xids', 'x_profile_image_url', 'character varying(3000)', 'first'),
  ('xids', 'x_name', 'character varying(746)', 'first'),
  ('xids', 'modified', 'bigint NOT NULL', 'first'),
  ('xids', 'x_email', 'character varying(256)', 'first'),
  ('xids', 'zid', 'integer', 'later'),
  ('xids', 'pid', 'integer', 'later'),
  -- reports
  ('reports', 'rid', 'bigint NOT NULL', 'first'),
  ('reports', 'report_id', 'character varying(300) NOT NULL', 'first'),
  ('reports', 'zid', 'integer NOT NULL', 'first'),
  ('reports', 'created', 'bigint', 'first'),
  ('reports', 'modified', 'bigint', 'first'),
  ('reports', 'label_x_neg', 'character varying(999)', 'first'),
  ('reports', 'label_y_neg', 'character varying(999)', 'first'),
  ('reports', 'label_y_pos', 'character varying(999)', 'first'),
  ('reports', 'label_x_pos', 'character varying(999)', 'first'),
  ('reports', 'label_group_0', 'character varying(999)', 'first'),
  ('reports', 'label_group_1', 'character varying(999)', 'first'),
  ('reports', 'label_group_2', 'character varying(999)', 'first'),
  ('reports', 'label_group_3', 'character varying(999)', 'first'),
  ('reports', 'label_group_4', 'character varying(999)', 'first'),
  ('reports', 'label_group_5', 'character varying(999)', 'first'),
  ('reports', 'label_group_6', 'character varying(999)', 'first'),
  ('reports', 'label_group_7', 'character varying(999)', 'first'),
  ('reports', 'label_group_8', 'character varying(999)', 'first'),
  ('reports', 'label_group_9', 'character varying(999)', 'first'),
  ('reports', 'report_name', 'character varying(999)', 'first'),
  ('reports', 'mod_level', 'smallint NOT NULL', 'later'),
  -- site_domain_whitelist
  ('site_domain_whitelist', 'site_id', 'character varying(256) NOT NULL', 'first'),
  ('site_domain_whitelist', 'domain_whitelist', 'character varying(999)', 'first'),
  ('site_domain_whitelist', 'modified', 'bigint NOT NULL', 'first'),
  ('site_domain_whitelist', 'created', 'bigint NOT NULL', 'first'),
  ('site_domain_whitelist', 'domain_whitelist_override_key', 'character varying(999)', 'first'),
  -- math_main
  ('math_main', 'zid', 'integer NOT NULL', 'first'),
  ('math_main', 'math_env', 'character varying(999) NOT NULL', 'first'),
  ('math_main', 'data', 'json NOT NULL', 'first'),
  ('math_main', 'last_vote_timestamp', 'bigint NOT NULL', 'first'),
  ('math_main', 'modified', 'bigint', 'first'),
  ('math_main', 'math_tick', 'bigint NOT NULL', 'first'),
  ('math_main', 'caching_tick', 'bigint NOT NULL', 'first'),
  -- math_ticks
  ('math_ticks', 'zid', 'integer', 'first'),
  ('math_ticks', 'math_tick', 'bigint NOT NULL', 'first'),
  ('math_ticks', 'math_env', 'character varying(999) NOT NULL', 'first'),
  ('math_ticks', 'modified', 'bigint NOT NULL', 'first'),
  -- math_bidtopid
  ('math_bidtopid', 'zid', 'integer NOT NULL', 'first'),
  ('math_bidtopid', 'math_env', 'character varying(999) NOT NULL', 'first'),
  ('math_bidtopid', 'data', 'json NOT NULL', 'first'),
  ('math_bidtopid', 'modified', 'bigint', 'first'),
  ('math_bidtopid', 'math_tick', 'bigint NOT NULL', 'first'),
  -- math_ptptstats
  ('math_ptptstats', 'zid', 'integer NOT NULL', 'first'),
  ('math_ptptstats', 'math_env', 'character varying(999) NOT NULL', 'first'),
  ('math_ptptstats', 'data', 'json NOT NULL', 'first'),
  ('math_ptptstats', 'modified', 'bigint', 'first'),
  ('math_ptptstats', 'math_tick', 'bigint NOT NULL', 'first');

-- Columns the migrations build and an older installation does not have.
CREATE TABLE older_database_shape.absent_columns (
    table_name text NOT NULL,
    column_name text NOT NULL,
    PRIMARY KEY (table_name, column_name)
);
INSERT INTO older_database_shape.absent_columns (table_name, column_name) VALUES
  ('conversations', 'branding_type'),
  ('math_ticks', 'caching_tick');

-- Gives one newly created, still empty table the older shape.
CREATE FUNCTION older_database_shape.reshape(target regclass) RETURNS void
LANGUAGE plpgsql AS $function$
DECLARE
    tbl text;
    col record;
    present text[];
    wanted text[];
    first_moved integer;
    moved text;
    constraint_names text[];
    constraint_definitions text[];
    added text;
BEGIN
    SELECT relname INTO tbl FROM pg_class WHERE oid = target;

    -- 1. json where the table was declared with jsonb.
    FOR col IN
        SELECT s.column_name
        FROM older_database_shape.columns s
        JOIN pg_attribute a ON a.attrelid = target AND a.attname = s.column_name
        WHERE s.table_name = tbl AND s.definition ~ '^json( |$)'
          AND a.attnum > 0 AND NOT a.attisdropped
          AND a.atttypid = 'pg_catalog.jsonb'::regtype
    LOOP
        EXECUTE format('ALTER TABLE %s ALTER COLUMN %I TYPE json', target, col.column_name);
    END LOOP;

    -- 2. Only a table with every column the first migration gives it is
    -- reshaped further.
    IF EXISTS (
        SELECT FROM older_database_shape.columns s
        WHERE s.table_name = tbl AND s.migration = 'first'
          AND NOT EXISTS (
              SELECT FROM pg_attribute a
              WHERE a.attrelid = target AND a.attname = s.column_name
                AND a.attnum > 0 AND NOT a.attisdropped)
    ) THEN
        RETURN;
    END IF;

    FOR col IN
        SELECT d.column_name
        FROM older_database_shape.absent_columns d
        JOIN pg_attribute a ON a.attrelid = target AND a.attname = d.column_name
        WHERE d.table_name = tbl AND a.attnum > 0 AND NOT a.attisdropped
    LOOP
        EXECUTE format('ALTER TABLE %s DROP COLUMN %I', target, col.column_name);
    END LOOP;

    FOR col IN
        SELECT s.column_name
        FROM older_database_shape.columns s
        JOIN pg_attribute a ON a.attrelid = target AND a.attname = s.column_name
        WHERE s.table_name = tbl AND s.definition !~ ' NOT NULL'
          AND a.attnum > 0 AND NOT a.attisdropped AND a.attnotnull
          AND NOT EXISTS (
              SELECT FROM pg_index i
              WHERE i.indrelid = target AND i.indisprimary AND a.attnum = ANY (i.indkey))
    LOOP
        EXECUTE format('ALTER TABLE %s ALTER COLUMN %I DROP NOT NULL', target, col.column_name);
    END LOOP;

    -- The order wanted: the older installation's, for the columns the table
    -- has and the ones only an older installation has; then any column this
    -- file does not know, as declared.
    present := ARRAY(
        SELECT a.attname::text FROM pg_attribute a
        WHERE a.attrelid = target AND a.attnum > 0 AND NOT a.attisdropped
        ORDER BY a.attnum);
    wanted := ARRAY(
        SELECT s.column_name FROM older_database_shape.columns s
        WHERE s.table_name = tbl
          AND (s.migration = 'never' OR s.column_name = ANY (present))
        ORDER BY s.position)
        || ARRAY(
        SELECT u.column_name FROM unnest(present) WITH ORDINALITY AS u(column_name, n)
        WHERE NOT EXISTS (
            SELECT FROM older_database_shape.columns s
            WHERE s.table_name = tbl AND s.column_name = u.column_name)
        ORDER BY u.n);
    first_moved := 1;
    WHILE first_moved <= cardinality(present) AND present[first_moved] = wanted[first_moved] LOOP
        first_moved := first_moved + 1;
    END LOOP;
    IF first_moved > cardinality(wanted) THEN
        RETURN;
    END IF;

    -- A column is moved by adding it again at the end and dropping the
    -- original. Its constraints would go with the original, so every
    -- constraint of the table is set aside first and put back afterwards
    -- under its own name.
    SELECT coalesce(array_agg(c.conname::text ORDER BY c.contype = 'f', c.oid), '{}'),
           coalesce(array_agg(pg_get_constraintdef(c.oid) ORDER BY c.contype = 'f', c.oid), '{}')
    INTO constraint_names, constraint_definitions
    FROM pg_constraint c
    WHERE c.conrelid = target AND c.contype IN ('p', 'u', 'f', 'c', 'x');
    FOR i IN REVERSE cardinality(constraint_names) .. 1 LOOP
        EXECUTE format('ALTER TABLE %s DROP CONSTRAINT %I', target, constraint_names[i]);
    END LOOP;

    FOREACH moved IN ARRAY wanted[first_moved:] LOOP
        IF moved = ANY (present) THEN
            SELECT format_type(a.atttypid, a.atttypmod) AS data_type,
                   a.attnotnull AS not_null,
                   pg_get_expr(d.adbin, d.adrelid) AS default_value,
                   pg_get_serial_sequence(target::text, a.attname::text) AS owned_sequence,
                   a.attidentity <> '' OR a.attgenerated <> '' AS computed
            INTO col
            FROM pg_attribute a
            LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
            WHERE a.attrelid = target AND a.attname = moved
              AND a.attnum > 0 AND NOT a.attisdropped;
            IF col.computed THEN
                RAISE EXCEPTION 'older_database_shape: %.% is an identity or generated column and cannot be moved', target, moved;
            END IF;
            IF col.owned_sequence IS NOT NULL THEN
                EXECUTE format('ALTER SEQUENCE %s OWNED BY NONE', col.owned_sequence);
            END IF;
            EXECUTE format('ALTER TABLE %s RENAME COLUMN %I TO older_database_shape_moving', target, moved);
            EXECUTE format('ALTER TABLE %s ADD COLUMN %I %s%s%s', target, moved, col.data_type,
                CASE WHEN col.default_value IS NULL THEN '' ELSE ' DEFAULT ' || col.default_value END,
                CASE WHEN col.not_null THEN ' NOT NULL' ELSE '' END);
            EXECUTE format('ALTER TABLE %s DROP COLUMN older_database_shape_moving', target);
            IF col.owned_sequence IS NOT NULL THEN
                EXECUTE format('ALTER SEQUENCE %s OWNED BY %s.%I', col.owned_sequence, target, moved);
            END IF;
        ELSE
            SELECT s.definition INTO added
            FROM older_database_shape.columns s
            WHERE s.table_name = tbl AND s.column_name = moved;
            EXECUTE format('ALTER TABLE %s ADD COLUMN %I %s', target, moved, added);
        END IF;
    END LOOP;

    FOR i IN 1 .. cardinality(constraint_names) LOOP
        EXECUTE format('ALTER TABLE %s ADD CONSTRAINT %I %s', target, constraint_names[i], constraint_definitions[i]);
    END LOOP;
END
$function$;

CREATE FUNCTION older_database_shape.on_create_table() RETURNS event_trigger
LANGUAGE plpgsql AS $function$
DECLARE
    created record;
BEGIN
    FOR created IN
        SELECT c.objid
        FROM pg_event_trigger_ddl_commands() c
        JOIN pg_class r ON r.oid = c.objid
        WHERE c.classid = 'pg_catalog.pg_class'::regclass
          AND c.command_tag = 'CREATE TABLE' AND c.object_type = 'table'
          AND r.relkind = 'r'
          AND r.relnamespace <> 'older_database_shape'::regnamespace
          AND r.relname IN (SELECT s.table_name FROM older_database_shape.columns s)
    LOOP
        PERFORM older_database_shape.reshape(created.objid::regclass);
    END LOOP;
END
$function$;

-- A migration may create its tables as another role; the trigger runs as that
-- role and has to be able to read the lists above.
GRANT USAGE ON SCHEMA older_database_shape TO PUBLIC;
GRANT SELECT ON ALL TABLES IN SCHEMA older_database_shape TO PUBLIC;

CREATE EVENT TRIGGER older_database_shape ON ddl_command_end
    WHEN TAG IN ('CREATE TABLE', 'CREATE SCHEMA')
    EXECUTE FUNCTION older_database_shape.on_create_table();
