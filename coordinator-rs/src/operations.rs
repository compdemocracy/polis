//! Rev4 reservations and exact, durable operation reconciliation.
//!
//! No absence/timeout releases capacity. Cleanup is a separate protected SQL
//! operation; this adapter never deletes an operation, receipt or floor.
use crate::store::{digest, storage_digest};
use anyhow::{Result, ensure};
use postgres::Client;
use serde_json::Value;

pub fn reconcile_one(
    client: &mut Client,
    env: &str,
    zid: i32,
    operation: &str,
) -> Result<Option<i64>> {
    let mut tx = client.transaction()?;
    // The fixed SECURITY DEFINER RPC acquires parent -> lease -> budget ->
    // operation locks. Control has no direct UPDATE (even for SELECT FOR UPDATE)
    // on budgets/operations. Keep this transaction open while independently
    // verifying original payload bytes; a failed check rolls its state back.
    let state: String = match tx.query_one(
        "SELECT public.pc_reconcile($1,$2,$3)",
        &[&env, &zid, &operation],
    ) {
        Ok(row) => row.get(0),
        Err(error)
            if error.as_db_error().is_some_and(|e| {
                e.code().code() == "P2020" && e.message() == "RECEIPT_IDENTITY_CONFLICT"
            }) =>
        {
            return Ok(None);
        }
        Err(error) => return Err(error.into()),
    };
    let row = tx.query_opt("SELECT g.math_tick,g.input_checkpoint,
      g.owner_id=o.owner_id AND g.publisher_epoch=o.owner_epoch
      AND g.capability_sha256=o.capability_sha256 AND g.expected_tick IS NOT DISTINCT FROM o.expected_tick
      AND g.input_checkpoint->'publisher_epoch'=to_jsonb(o.owner_epoch)
      AND g.input_checkpoint->'operation_id'=to_jsonb(o.operation_id)
      AND encode(sha256(convert_to((g.input_checkpoint-ARRAY['operation_id','publisher_epoch','original_digests','payload_digests'])::text,'UTF8')),'hex')=o.checkpoint_sha256
      FROM public.polis_coordinator_operations o JOIN public.polis_coordinator_generations g
      USING(math_env,zid,operation_id) WHERE o.math_env=$1 AND o.zid=$2 AND o.operation_id=$3",
      &[&env, &zid, &operation])?;
    let tick = if let Some(row) = row {
        if row.get::<_, Option<bool>>(2) != Some(true) {
            return Ok(None); // Keep the durable nonterminal reservation charged.
        }
        let tick: i64 = row.get(0);
        let checkpoint: Value = row.get(1);
        let parts = tx.query("SELECT payload_kind,original_bytes,original_sha256,storage_sha256 FROM public.polis_coordinator_payloads WHERE math_env=$1 AND zid=$2 AND math_tick=$3 ORDER BY payload_kind", &[&env, &zid, &tick])?;
        if parts.len() != 3 {
            return Ok(None);
        }
        for part in parts {
            let name: String = part.get(0);
            let raw: Vec<u8> = part.get(1);
            let raw_hash = digest(&raw);
            let stored: String = part.get(3);
            let decoded = crate::wire::parse(&raw)
                .ok()
                .and_then(|v| storage_digest(&v).ok());
            if !(part.get::<_, String>(2) == raw_hash
                && checkpoint["original_digests"][&name] == raw_hash
                && checkpoint["payload_digests"][&name] == stored
                && decoded.is_some_and(|d| d == stored))
            {
                return Ok(None);
            }
        }
        Some(tick)
    } else {
        None
    };
    ensure!(
        state
            == if tick.is_some() {
                "resolved"
            } else {
                "unresolved"
            },
        "RECONCILIATION_REPLY"
    );
    tx.commit()?;
    Ok(tick)
}

pub fn reconcile_pending(client: &mut Client, env: &str, limit: i64) -> Result<()> {
    ensure!((1..=1000).contains(&limit), "RECONCILIATION_LIMIT");
    // Persisted oldest-first order survives replacement processes. Avoid
    // disturbing a currently computing dispatch whose lease is still live.
    let rows = client.query("SELECT o.zid,o.operation_id FROM public.polis_coordinator_operations o
      WHERE o.math_env=$1 AND o.state<>'resolved' AND
      (NOT EXISTS(SELECT FROM public.polis_coordinator_leases l WHERE l.math_env=o.math_env AND l.zid=o.zid
         AND l.dispatch_operation_id=o.operation_id AND l.expires_at>clock_timestamp())
       OR EXISTS(SELECT FROM public.polis_coordinator_generations g WHERE g.math_env=o.math_env AND g.zid=o.zid AND g.operation_id=o.operation_id))
      ORDER BY o.reconciled_at,o.zid,o.operation_id LIMIT $2", &[&env, &limit])?;
    for row in rows {
        reconcile_one(client, env, row.get(0), row.get::<_, String>(1).as_str())?;
    }
    Ok(())
}
