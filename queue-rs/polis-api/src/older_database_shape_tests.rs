//! The crate's database tests run twice (ci/local/polis-api.sh): once on test
//! databases as PostgreSQL creates them, where every table has the shape the
//! migrations give it, and once with `tests/older_database_shape.sql`
//! installed on the test server, where the tables it lists take the shape of
//! an installation whose database predates the migrations. These are the
//! tests of that file, and the test that says which of the two a run is.
use postgres::{Client, Config, NoTls};

const SHAPE: &str = include_str!("../tests/older_database_shape.sql");
const WITHOUT: &str = "DROP EVENT TRIGGER IF EXISTS older_database_shape;
                       DROP SCHEMA IF EXISTS older_database_shape CASCADE;";
/// Unset or `migrations`: the test server is as PostgreSQL made it. `older`:
/// the shape file is installed in the test database and in `template1`.
const SETTING: &str = "POLIS_API_TEST_DATABASE_SHAPE";
/// What to do when a migration changes the columns of a table the shape file
/// lists. Said by every assertion such a migration trips.
const A_MIGRATION_CHANGED_A_LISTED_TABLE: &str = "the columns the migrations build for a table that tests/older_database_shape.sql lists are not the columns that file records. If a migration added a column, add it to the file as the last row of that table and mark it 'later' (never 'first', which is for 000000_initial.sql alone), and, for conversations or participants_extended, add it to the list of last columns in this test";
/// What to do when a run finds the other shape than the one it names.
const WRONG_SHAPE: &str = "this run's test databases do not have the shape it names. An interrupted run can leave the older shape installed: remove it with `cargo run --locked -p polis-api --example older_database_shape -- remove`; to run on the older shape, install it and set POLIS_API_TEST_DATABASE_SHAPE=older";

fn config() -> Config {
    std::env::var("POLIS_API_TEST_DATABASE_URL")
        .unwrap()
        .parse()
        .unwrap()
}

/// A database of this test's own, removed when the value is dropped.
struct Database {
    admin: Client,
    name: String,
    client: Client,
}
impl Database {
    fn create(label: &str) -> Self {
        let mut config = config();
        let mut admin = config.connect(NoTls).unwrap();
        let name = format!("older_shape_{label}_{}", std::process::id());
        admin
            .batch_execute(&format!("CREATE DATABASE {name}"))
            .unwrap();
        config.dbname(&name);
        let mut client = config.connect(NoTls).unwrap();
        client
            .batch_execute("SET client_min_messages = warning")
            .unwrap();
        Self {
            admin,
            name,
            client,
        }
    }
}
impl Drop for Database {
    fn drop(&mut self) {
        // The database cannot be dropped while this connection is open.
        if let Ok(closed) = config().connect(NoTls) {
            drop(std::mem::replace(&mut self.client, closed));
        }
        let _ = self
            .admin
            .batch_execute(&format!("DROP DATABASE {} WITH (FORCE)", self.name));
    }
}

/// The type a math document column declared jsonb has once its table exists.
fn declared_jsonb(c: &mut Client, schema: &str) -> String {
    c.batch_execute(&format!(
        "CREATE SCHEMA {schema};
         CREATE TABLE {schema}.math_main(zid integer, data jsonb);"
    ))
    .unwrap();
    let stored = c
        .query_one(
            "SELECT format_type(atttypid, atttypmod) FROM pg_attribute
             WHERE attrelid = ($1 || '.math_main')::regclass AND attname = 'data'",
            &[&schema],
        )
        .unwrap()
        .get(0);
    c.batch_execute(&format!("DROP SCHEMA {schema} CASCADE"))
        .unwrap();
    stored
}

/// A run says which shape its test databases have, and they have it: both the
/// test database, where tests create their schemas, and a database a test
/// creates. A shape file left installed by an interrupted run fails this in
/// the run that expects the migrations' shape, and a run that expects the
/// older shape fails it when nothing is installed.
#[test]
fn test_databases_have_the_shape_this_run_names() {
    let expected = match std::env::var(SETTING).ok().as_deref() {
        None | Some("" | "migrations") => "jsonb",
        Some("older") => "json",
        Some(other) => panic!("{SETTING} must be unset, migrations or older; found {other}"),
    };
    let mut c = config().connect(NoTls).unwrap();
    assert_eq!(
        declared_jsonb(&mut c, &format!("shape_named_{}", std::process::id())),
        expected,
        "a table created in the test database: {WRONG_SHAPE}"
    );
    let mut created = Database::create("named");
    assert_eq!(
        declared_jsonb(&mut created.client, "shape_named"),
        expected,
        "a table created in a database a test creates: {WRONG_SHAPE}"
    );
}

/// Every migration file, in order.
pub(crate) fn migrations() -> Vec<(String, String)> {
    let directory = concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../server/postgres/migrations"
    );
    let mut files: Vec<(String, String)> = std::fs::read_dir(directory)
        .unwrap()
        .map(|entry| entry.unwrap())
        .filter(|entry| {
            let name = entry.file_name().to_string_lossy().into_owned();
            name.starts_with('0') && name.ends_with(".sql")
        })
        .map(|entry| {
            (
                entry.file_name().to_string_lossy().into_owned(),
                std::fs::read_to_string(entry.path()).unwrap(),
            )
        })
        .collect();
    files.sort();
    assert!(files.len() >= 36, "the migrations were not found");
    files
}

/// One migration file. An index built CONCURRENTLY cannot share a
/// transaction with another statement, so a file of those (one statement to
/// a line, as the migration runner requires) is sent a statement at a time.
pub(crate) fn apply(c: &mut Client, sql: &str) -> Result<(), postgres::Error> {
    // Some migrations create roles, which belong to the whole server: two
    // tests applying the migrations to their own databases at once would
    // both find a role missing and both create it. One file at a time.
    static ONE_AT_A_TIME: std::sync::Mutex<()> = std::sync::Mutex::new(());
    let _one = ONE_AT_A_TIME.lock().unwrap_or_else(|e| e.into_inner());
    let statements: Vec<&str> = sql
        .lines()
        .filter(|line| !line.trim().is_empty() && !line.trim_start().starts_with("--"))
        .collect();
    if statements
        .iter()
        .all(|statement| statement.starts_with("CREATE INDEX CONCURRENTLY"))
    {
        statements
            .into_iter()
            .try_for_each(|statement| c.batch_execute(statement))
    } else {
        c.batch_execute(sql)
    }
}

fn lines(c: &mut Client, sql: &str) -> Vec<String> {
    c.query(sql, &[])
        .unwrap()
        .iter()
        .map(|row| row.get(0))
        .collect()
}

/// Every column of the public tables: table, position, name, type, NOT NULL.
const COLUMNS: &str =
    "SELECT c.relname || ' ' || row_number() OVER (PARTITION BY c.oid ORDER BY a.attnum)
           || ' ' || a.attname || ' ' || format_type(a.atttypid, a.atttypmod)
           || CASE WHEN a.attnotnull THEN ' NOT NULL' ELSE '' END
    FROM pg_attribute a JOIN pg_class c ON c.oid = a.attrelid
    WHERE c.relnamespace = 'public'::regnamespace AND c.relkind = 'r'
      AND a.attnum > 0 AND NOT a.attisdropped
    ORDER BY c.relname, a.attnum";

/// Everything else the migrations build on those tables, and the functions.
const OTHER_OBJECTS: &str = "SELECT line FROM (
    SELECT 'constraint ' || conrelid::regclass || ' ' || conname || ' ' || pg_get_constraintdef(oid) AS line
      FROM pg_constraint WHERE connamespace = 'public'::regnamespace AND contype IN ('p','u','f','c','x')
    UNION ALL SELECT 'index ' || tablename || ' ' || indexname || ' ' || indexdef
      FROM pg_indexes WHERE schemaname = 'public'
    UNION ALL SELECT 'default ' || c.relname || ' ' || a.attname || ' ' || pg_get_expr(d.adbin, d.adrelid)
      FROM pg_attrdef d JOIN pg_attribute a ON a.attrelid = d.adrelid AND a.attnum = d.adnum
      JOIN pg_class c ON c.oid = d.adrelid WHERE c.relnamespace = 'public'::regnamespace
    UNION ALL SELECT 'owned sequence ' || s.relname || ' ' || t.relname || ' ' || a.attname
      FROM pg_depend dp JOIN pg_class s ON s.oid = dp.objid AND s.relkind = 'S'
      JOIN pg_class t ON t.oid = dp.refobjid
      JOIN pg_attribute a ON a.attrelid = t.oid AND a.attnum = dp.refobjsubid
      WHERE dp.deptype = 'a' AND t.relnamespace = 'public'::regnamespace
    UNION ALL SELECT 'trigger ' || tgrelid::regclass || ' ' || tgname || ' ' || pg_get_triggerdef(oid)
      FROM pg_trigger WHERE NOT tgisinternal
    UNION ALL SELECT 'rule ' || tablename || ' ' || rulename || ' ' || definition
      FROM pg_rules WHERE schemaname = 'public'
    UNION ALL SELECT 'function ' || p.oid::regprocedure || ' ' || md5(p.prosrc)
      FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace
    ) objects ORDER BY line";

/// The shape file against the migrations themselves: every migration applies
/// with it installed; the thirteen tables come out with the columns, order,
/// types and nullability the file records; and nothing else differs from a
/// database built without it, except what the file says it changes.
#[test]
fn every_migration_applies_and_the_listed_tables_take_the_older_shape() {
    let mut older = Database::create("installed");
    let mut plain = Database::create("plain");
    // Explicit in both, whatever the test server's `template1` holds.
    older.client.batch_execute(SHAPE).unwrap();
    plain.client.batch_execute(WITHOUT).unwrap();
    for (name, sql) in migrations() {
        for database in [&mut older, &mut plain] {
            apply(&mut database.client, &sql)
                .unwrap_or_else(|error| panic!("{name} in {}: {error:?}", database.name));
        }
    }

    // The columns the file records, as the tables now have them.
    let recorded = lines(
        &mut older.client,
        "SELECT table_name || ' ' || row_number() OVER (PARTITION BY table_name ORDER BY position)
                || ' ' || column_name || ' ' || regexp_replace(definition, ' DEFAULT .*', '')
         FROM older_database_shape.columns ORDER BY table_name, position",
    );
    let tables: Vec<String> = lines(
        &mut older.client,
        "SELECT DISTINCT table_name FROM older_database_shape.columns ORDER BY 1",
    );
    assert_eq!(tables.len(), 13);
    let listed = |line: &String| {
        tables
            .iter()
            .any(|table| line.starts_with(&format!("{table} ")))
    };
    let built: Vec<String> = lines(&mut older.client, COLUMNS)
        .into_iter()
        .filter(listed)
        .collect();
    // A column a later migration adds stays where that migration puts it, so
    // two tables end in another order than the file records.
    let later = |table: &str| {
        let differing = |lines: &[String]| -> Vec<String> {
            lines
                .iter()
                .filter(|line| line.starts_with(&format!("{table} ")))
                .cloned()
                .collect()
        };
        (differing(&recorded), differing(&built))
    };
    let names = |lines: &[String]| -> Vec<String> {
        lines
            .iter()
            .map(|line| line.split(' ').nth(2).unwrap().to_owned())
            .collect()
    };
    let (recorded_conversations, built_conversations) = later("conversations");
    assert_eq!(
        names(&built_conversations)[45..],
        ["xid_required", "topics_enabled"],
        "conversations: {A_MIGRATION_CHANGED_A_LISTED_TABLE}"
    );
    assert_eq!(
        names(&recorded_conversations)[45..],
        ["topics_enabled", "xid_required"],
        "conversations: {A_MIGRATION_CHANGED_A_LISTED_TABLE}"
    );
    assert_eq!(
        names(&built_conversations)[..45],
        names(&recorded_conversations)[..45],
        "conversations: {A_MIGRATION_CHANGED_A_LISTED_TABLE}"
    );
    let (recorded_extended, built_extended) = later("participants_extended");
    assert_eq!(
        names(&built_extended),
        [
            "uid",
            "zid",
            "referrer",
            "parent_url",
            "created",
            "encrypted_ip_address",
            "encrypted_x_forwarded_for",
            "country_iso_code",
            "modified",
            "show_translation_activated",
            "subscribe_email",
            "permanent_cookie",
            "origin"
        ],
        "participants_extended: {A_MIGRATION_CHANGED_A_LISTED_TABLE}"
    );
    assert_eq!(
        recorded_extended.len(),
        built_extended.len(),
        "participants_extended: {A_MIGRATION_CHANGED_A_LISTED_TABLE}"
    );
    let elsewhere = |line: &&String| {
        !line.starts_with("conversations ") && !line.starts_with("participants_extended ")
    };
    assert_eq!(
        built.iter().filter(elsewhere).collect::<Vec<_>>(),
        recorded.iter().filter(elsewhere).collect::<Vec<_>>(),
        "the other eleven tables have exactly the recorded columns, in order: {A_MIGRATION_CHANGED_A_LISTED_TABLE}"
    );
    // The type and nullability of every column of the two, wherever it sits.
    let unordered = |lines: &[String]| -> Vec<String> {
        let mut columns: Vec<String> = lines
            .iter()
            .map(|line| line.splitn(3, ' ').nth(2).unwrap().to_owned())
            .collect();
        columns.sort();
        columns
    };
    assert_eq!(
        unordered(&built_conversations),
        unordered(&recorded_conversations)
    );
    assert_eq!(unordered(&built_extended), unordered(&recorded_extended));

    // The tables the file does not list are untouched.
    let unlisted = |c: &mut Client| -> Vec<String> {
        lines(c, COLUMNS)
            .into_iter()
            .filter(|line| !listed(line))
            .collect()
    };
    assert_eq!(unlisted(&mut older.client), unlisted(&mut plain.client));

    // Constraints, indexes, defaults, owned sequences, triggers, rules and
    // functions are the migrations', but for the columns only one side has.
    let other = |c: &mut Client| lines(c, OTHER_OBJECTS);
    let (with, without) = (other(&mut older.client), other(&mut plain.client));
    let only_with: Vec<&String> = with.iter().filter(|line| !without.contains(line)).collect();
    let only_without: Vec<&String> = without.iter().filter(|line| !with.contains(line)).collect();
    assert_eq!(
        only_with,
        [
            "default comments curation 0",
            "default conversations is_curated false",
            "default conversations need_suzinvite false",
            "default users test false"
        ]
    );
    assert_eq!(
        only_without,
        [
            "default conversations branding_type 1",
            "default math_ticks caching_tick 0"
        ]
    );

    // A table a test declares with fewer columns keeps its order; only a
    // jsonb math document becomes json. One declared with every column of
    // the first migration is the migrations' table and is reordered.
    older
        .client
        .batch_execute(
            "CREATE SCHEMA declared; SET search_path = declared;
             CREATE TABLE math_main(zid integer, math_env text, math_tick bigint, data jsonb);
             CREATE TABLE votes(tid integer, zid integer, created bigint, pid integer);
             CREATE TABLE participants(pid integer, uid integer, zid integer, vote_count integer,
                 last_interaction bigint, subscribed integer, last_notified bigint, nsli smallint,
                 mod integer, created bigint, PRIMARY KEY (zid, pid));",
        )
        .unwrap();
    let declared = |c: &mut Client, table: &str| -> Vec<String> {
        lines(
            c,
            &format!(
                "SELECT a.attname || ' ' || format_type(a.atttypid, a.atttypmod)
                 FROM pg_attribute a WHERE a.attrelid = 'declared.{table}'::regclass
                   AND a.attnum > 0 AND NOT a.attisdropped ORDER BY a.attnum"
            ),
        )
    };
    assert_eq!(
        declared(&mut older.client, "math_main"),
        [
            "zid integer",
            "math_env text",
            "math_tick bigint",
            "data json"
        ]
    );
    assert_eq!(
        declared(&mut older.client, "votes"),
        [
            "tid integer",
            "zid integer",
            "created bigint",
            "pid integer"
        ]
    );
    assert_eq!(
        names(
            &declared(&mut older.client, "participants")
                .iter()
                .map(|line| format!("participants 0 {line}"))
                .collect::<Vec<_>>()
        ),
        [
            "pid",
            "uid",
            "zid",
            "created",
            "vote_count",
            "last_interaction",
            "subscribed",
            "last_notified",
            "mod",
            "nsli"
        ]
    );
    assert_eq!(
        lines(
            &mut older.client,
            "SELECT pg_get_constraintdef(oid) FROM pg_constraint
             WHERE conrelid = 'declared.participants'::regclass AND contype = 'p'"
        ),
        ["PRIMARY KEY (zid, pid)"]
    );
}
