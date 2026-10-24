import type { PoolClient } from "pg";
import pg from "../db/pg-query";

export const IMPORT_TARGET_NOT_EMPTY = "polis_err_import_target_not_empty";
export const IMPORT_TARGET_MESSAGE =
  "This conversation already has data; importing would overwrite it. Polis does not merge. Import into a new conversation instead.";

export class ImportTargetNotEmptyError extends Error {
  readonly code = IMPORT_TARGET_NOT_EMPTY;
  constructor() {
    super(IMPORT_TARGET_MESSAGE);
  }
}

// Vote-import admission reads the primary. Comments and owner membership are
// allowed. Historical votes or non-owner participants refuse the vote import,
// including a retry of a partially written job.
export async function assertImportTargetEmpty(
  zid: number,
  client?: PoolClient
): Promise<void> {
  const sql = `SELECT
    EXISTS (SELECT 1 FROM votes WHERE zid = $1) OR
    EXISTS (SELECT 1 FROM votes_latest_unique WHERE zid = $1) OR
    EXISTS (SELECT 1 FROM participants p JOIN conversations c USING (zid)
            WHERE p.zid = $1 AND p.uid IS DISTINCT FROM c.owner) AS occupied`;
  const params = [zid];
  const rows = client
    ? (await client.query(sql, params)).rows
    : ((await pg.queryP(sql, params)) as { occupied: boolean }[]);
  if (rows[0].occupied) throw new ImportTargetNotEmptyError();
}

// Only import writers use this namespace. A competing import is refused rather
// than queued behind another job. Participation never acquires this lock.
export async function lockImportTarget(client: PoolClient, zid: number) {
  const { rows } = await client.query(
    "SELECT pg_try_advisory_xact_lock(18490271, $1::int) AS acquired",
    [zid]
  );
  if (!rows[0].acquired) throw new ImportTargetNotEmptyError();
}
