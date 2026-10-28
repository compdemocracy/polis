//! Shared primary transaction policy for staged identity writes.
use postgres::{Client, Error, IsolationLevel, Transaction};

pub(crate) fn begin(client: &mut Client) -> Result<Transaction<'_>, Error> {
    let mut tx = client
        .build_transaction()
        .isolation_level(IsolationLevel::ReadCommitted)
        .start()?;
    tx.batch_execute("SET LOCAL lock_timeout='5s'; SET LOCAL statement_timeout='5s'; SET LOCAL idle_in_transaction_session_timeout='5s'")?;
    Ok(tx)
}
