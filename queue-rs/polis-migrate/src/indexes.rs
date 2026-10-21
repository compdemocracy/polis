//! Resumable, autocommit execution for the concurrent index migrations.
//! The caller holds the database-wide migration lock across every statement.
use anyhow::{Context, Result, ensure};
use postgres::Client;

const INDEXES: [(&str, &str, &str); 2] = [
    ("votes_created_idx", "votes", "created"),
    ("comments_modified_idx", "comments", "modified"),
];

fn state(
    client: &mut impl postgres::GenericClient,
    name: &str,
    table: &str,
    column: &str,
) -> Result<Option<bool>> {
    let rows = client.query(
        "SELECT x.indisvalid AND x.indisready AND x.indislive AS usable,
                pg_get_indexdef(c.oid), c.relkind
         FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
         LEFT JOIN pg_index x ON x.indexrelid=c.oid
         WHERE n.nspname='public' AND c.relname=$1",
        &[&name],
    )?;
    let Some(row) = rows.first() else {
        return Ok(None);
    };
    let definition: Option<String> = row.get(1);
    let expected = format!("CREATE INDEX {name} ON public.{table} USING btree ({column})");
    ensure!(
        definition.as_deref() == Some(expected.as_str()),
        "conflicting object public.{name}; preserve it and resolve its definition before retrying"
    );
    let usable: Option<bool> = row.get(0);
    Ok(Some(usable == Some(true)))
}

pub fn prepare(client: &mut Client) -> Result<()> {
    prepare_named(client, "000022", &INDEXES)
}

fn prepare_named(
    client: &mut Client,
    migration: &str,
    indexes: &[(&str, &str, &str)],
) -> Result<()> {
    // Preflight all identities before changing any one. A conflicting or
    // invalid preexisting index is never dropped or replaced automatically.
    for &(name, table, column) in indexes {
        if let Some(usable) = state(client, name, table, column)? {
            ensure!(
                usable,
                "{migration}: public.{name} is invalid/not ready; inspect the interrupted build, then explicitly DROP INDEX CONCURRENTLY public.{name} before retrying apply; history has not recorded {migration}"
            );
        }
    }
    for &(name, table, column) in indexes {
        // Recheck after the preceding build. Uncoordinated external DDL is not
        // serialized by the runner's advisory lock; any collision fails closed.
        if state(client, name, table, column)? == Some(true) {
            continue;
        }
        ensure!(
            state(client, name, table, column)?.is_none(),
            "{migration}: concurrent catalog change for public.{name}; inspect before retrying"
        );
        println!("BUILDING CONCURRENTLY public.{name}");
        client.batch_execute(&format!(
            "CREATE INDEX CONCURRENTLY {name} ON public.{table} USING btree ({column})"
        )).with_context(|| format!(
            "{migration}: concurrent build interrupted for public.{name}; inspect validity before retrying; valid earlier indexes are retained and no {migration} history row was committed"
        ))?;
        ensure!(
            state(client, name, table, column)? == Some(true),
            "{migration}: index public.{name} did not reach the expected valid state"
        );
    }
    Ok(())
}

/// Deliberately narrow opt-out: only plain public btree indexes, no arbitrary SQL.
#[derive(Debug)]
pub struct ConcurrentIndexes(Vec<(String, String, String)>);

impl ConcurrentIndexes {
    pub fn parse(source: &str) -> Result<Option<Self>> {
        const MARKER: &str = "-- polis-migrate: concurrent-indexes";
        let header = source
            .lines()
            .take_while(|line| line.trim().is_empty() || line.trim_start().starts_with("--"));
        if !header.into_iter().any(|line| line.trim() == MARKER) {
            return Ok(None);
        }
        let mut indexes = Vec::new();
        let mut names = std::collections::BTreeSet::new();
        for statement in crate::sql::statements(source)? {
            let normalized = statement
                .replace('(', " ( ")
                .replace(')', " ) ")
                .replace(',', " , ");
            let words: Vec<_> = normalized.split_whitespace().collect();
            ensure!(
                words.len() >= 11
                    && words[..6]
                        .iter()
                        .zip(["CREATE", "INDEX", "CONCURRENTLY", "IF", "NOT", "EXISTS"])
                        .all(|(a, b)| a.eq_ignore_ascii_case(b))
                    && words[7].eq_ignore_ascii_case("ON")
                    && words[9] == "("
                    && words.last() == Some(&")"),
                "concurrent-indexes accepts only CREATE INDEX CONCURRENTLY IF NOT EXISTS name ON [public.]table (columns)"
            );
            let ident = |s: &str| {
                !s.is_empty()
                    && s.len() <= 63
                    && s.bytes().enumerate().all(|(i, b)| {
                        b.is_ascii_lowercase() || b == b'_' || (i > 0 && b.is_ascii_digit())
                    })
            };
            let name = words[6];
            let table = words[8].strip_prefix("public.").unwrap_or(words[8]);
            let columns = &words[10..words.len() - 1];
            ensure!(
                ident(name)
                    && ident(table)
                    && !columns.is_empty()
                    && columns.len() % 2 == 1
                    && columns.iter().enumerate().all(|(i, s)| if i % 2 == 0 {
                        ident(s)
                    } else {
                        *s == ","
                    }),
                "concurrent-indexes requires simple lowercase identifiers and column lists"
            );
            ensure!(
                names.insert(name.to_owned()),
                "duplicate concurrent index name: {name}"
            );
            indexes.push((
                name.to_owned(),
                table.to_owned(),
                columns
                    .iter()
                    .step_by(2)
                    .copied()
                    .collect::<Vec<_>>()
                    .join(", "),
            ));
        }
        ensure!(!indexes.is_empty(), "empty concurrent-indexes migration");
        Ok(Some(Self(indexes)))
    }

    pub fn prepare(&self, client: &mut Client, migration: &str) -> Result<()> {
        let indexes: Vec<_> = self
            .0
            .iter()
            .map(|(n, t, c)| (n.as_str(), t.as_str(), c.as_str()))
            .collect();
        prepare_named(client, migration, &indexes)
    }

    pub fn verify(&self, client: &mut impl postgres::GenericClient) -> Result<()> {
        for (name, table, columns) in &self.0 {
            ensure!(
                state(client, name, table, columns)? == Some(true),
                "concurrent index public.{name} is missing or invalid before recording history"
            );
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn assert_refused(source: &str) {
        let result =
            ConcurrentIndexes::parse(&format!("-- polis-migrate: concurrent-indexes\n{source}"));
        assert!(
            matches!(&result, Err(error) if error.to_string().contains("concurrent-indexes")),
            "{source}: {result:?}"
        );
    }

    #[test]
    fn refuses_predicate() {
        assert_refused(
            "CREATE INDEX CONCURRENTLY IF NOT EXISTS example_idx ON example (zid) WHERE zid IS NOT NULL;",
        );
    }

    #[test]
    fn refuses_storage_options() {
        assert_refused(
            "CREATE INDEX CONCURRENTLY IF NOT EXISTS example_idx ON example (zid) WITH (fillfactor = 70);",
        );
    }

    #[test]
    fn refuses_include() {
        assert_refused(
            "CREATE INDEX CONCURRENTLY IF NOT EXISTS example_idx ON example (zid) INCLUDE (created);",
        );
    }

    #[test]
    fn refuses_tablespace() {
        assert_refused(
            "CREATE INDEX CONCURRENTLY IF NOT EXISTS example_idx ON example (zid) TABLESPACE pg_default;",
        );
    }

    #[test]
    fn refuses_explicit_access_method() {
        assert_refused(
            "CREATE INDEX CONCURRENTLY IF NOT EXISTS example_idx ON example USING btree (zid);",
        );
    }

    #[test]
    fn refuses_standalone_commit() {
        assert_refused("COMMIT;");
    }

    #[test]
    fn refuses_outer_transaction_wrapper() {
        assert_refused(
            "BEGIN; CREATE INDEX CONCURRENTLY IF NOT EXISTS example_idx ON example (zid); COMMIT;",
        );
    }

    #[test]
    fn refuses_missing_concurrently() {
        assert_refused("CREATE INDEX IF NOT EXISTS example_idx ON example (zid);");
    }

    #[test]
    fn refuses_missing_if_not_exists() {
        assert_refused("CREATE INDEX CONCURRENTLY example_idx ON example (zid);");
    }

    #[test]
    fn refuses_uppercase_identifier() {
        assert_refused("CREATE INDEX CONCURRENTLY IF NOT EXISTS Example_idx ON example (zid);");
    }

    #[test]
    fn refuses_quoted_identifier() {
        assert_refused("CREATE INDEX CONCURRENTLY IF NOT EXISTS \"example_idx\" ON example (zid);");
    }

    #[test]
    fn narrow_header_contract() -> Result<()> {
        let header = "-- file.sql\n-- polis-migrate: concurrent-indexes\n";
        let statement =
            "CREATE INDEX CONCURRENTLY IF NOT EXISTS example_idx ON public.example (zid, created);";
        assert!(ConcurrentIndexes::parse(statement)?.is_none());
        assert!(ConcurrentIndexes::parse(&format!("{header}{statement}"))?.is_some());
        for invalid in [
            "BEGIN;",
            "DROP INDEX example_idx;",
            "SELECT 1;",
            "CREATE INDEX example_idx ON example (zid);",
            "CREATE INDEX CONCURRENTLY IF NOT EXISTS example_idx ON other.example (zid);",
            "CREATE INDEX CONCURRENTLY IF NOT EXISTS example_idx ON example (lower(zid));",
            "CREATE INDEX CONCURRENTLY IF NOT EXISTS example_idx ON example (zid DESC);",
        ] {
            assert!(
                ConcurrentIndexes::parse(&format!("{header}{invalid}")).is_err(),
                "{invalid}"
            );
        }
        assert!(ConcurrentIndexes::parse(&format!("{header}{statement}{statement}")).is_err());
        Ok(())
    }
}
