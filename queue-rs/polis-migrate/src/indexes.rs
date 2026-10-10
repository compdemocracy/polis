//! Resumable, autocommit execution for the immutable watermark index migration.
//! The caller holds the database-wide migration lock across every statement.
use anyhow::{Context, Result, ensure};
use postgres::Client;

const INDEXES: [(&str, &str, &str); 2] = [
    ("votes_created_idx", "votes", "created"),
    ("comments_modified_idx", "comments", "modified"),
];

fn state(client: &mut Client, name: &str, table: &str, column: &str) -> Result<Option<bool>> {
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
        "000022: conflicting object public.{name}; preserve it and resolve its definition before retrying"
    );
    let usable: Option<bool> = row.get(0);
    Ok(Some(usable == Some(true)))
}

pub fn prepare(client: &mut Client) -> Result<()> {
    // Preflight BOTH identities before changing either one. A conflicting or
    // invalid preexisting index is never dropped or replaced automatically.
    for (name, table, column) in INDEXES {
        if let Some(usable) = state(client, name, table, column)? {
            ensure!(
                usable,
                "000022: public.{name} is invalid/not ready; inspect the interrupted build, then explicitly DROP INDEX CONCURRENTLY public.{name} before retrying apply; history has not recorded 000022"
            );
        }
    }
    for (name, table, column) in INDEXES {
        // Recheck after the preceding build. Uncoordinated external DDL is not
        // serialized by the runner's advisory lock; any collision fails closed.
        if state(client, name, table, column)? == Some(true) {
            continue;
        }
        ensure!(
            state(client, name, table, column)?.is_none(),
            "000022: concurrent catalog change for public.{name}; inspect before retrying"
        );
        println!("BUILDING CONCURRENTLY public.{name}");
        client.batch_execute(&format!(
            "CREATE INDEX CONCURRENTLY {name} ON public.{table} USING btree ({column})"
        )).with_context(|| format!(
            "000022: concurrent build interrupted for public.{name}; inspect validity before retrying; valid earlier indexes are retained and no 000022 history row was committed"
        ))?;
        ensure!(
            state(client, name, table, column)? == Some(true),
            "000022: index public.{name} did not reach the expected valid state"
        );
    }
    Ok(())
}
