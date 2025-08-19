import pg from "../db/pg-query";
import { failJson } from "../utils/fail";

// POST /api/v3/treevite/waves
// Creates the next wave for a conversation
export async function handle_POST_treevite_waves(req: any, res: any) {
  try {
    const zid = req.p.zid;
    const invitesPerUser = Number(req.p.invites_per_user) || 0;
    const ownerInvites = Number(req.p.owner_invites) || 0;
    const explicitParentWave =
      typeof req.p.parent_wave === "number" ? req.p.parent_wave : null;

    if (typeof zid !== "number") {
      failJson(res, 400, "polis_err_treevite_missing_zid");
      return;
    }

    if (invitesPerUser <= 0 && ownerInvites <= 0) {
      failJson(res, 400, "polis_err_treevite_wave_requires_invites");
      return;
    }

    // Determine next wave number (1-based)
    const rows = (await pg.queryP_readOnly(
      "select max(wave) as max_wave from treevite_waves where zid = ($1);",
      [zid]
    )) as { max_wave: number | null }[];

    const maxWave = (rows && rows[0] && Number(rows[0].max_wave)) || 0;
    const nextWave = maxWave ? maxWave + 1 : 1;

    // Resolve parent wave: explicit, else default to greatest existing wave, else 0
    const parentWave =
      explicitParentWave !== null ? explicitParentWave : maxWave || 0;

    // Compute parent size (0->1 by definition)
    let parentSize = 1;
    if (parentWave > 0) {
      const parentRows = (await pg.queryP_readOnly(
        "select size from treevite_waves where zid = ($1) and wave = ($2);",
        [zid, parentWave]
      )) as { size: number | null }[];
      if (!parentRows || !parentRows.length) {
        failJson(res, 400, "polis_err_treevite_parent_wave_not_found");
        return;
      }
      parentSize = Number(parentRows[0].size) || 0;
      if (parentSize <= 0) {
        // If parent has no size cached yet, treat as 1 to avoid blocking
        parentSize = 1;
      }
    }

    const derivedSize = parentSize * invitesPerUser + ownerInvites;

    // Insert wave
    const insert = await pg.queryP(
      "insert into treevite_waves (zid, wave, parent_wave, invites_per_user, owner_invites, size) values (($1), ($2), ($3), ($4), ($5), ($6)) returning *;",
      [zid, nextWave, parentWave, invitesPerUser, ownerInvites, derivedSize]
    );

    res.status(201).json(insert && insert[0]);
  } catch (err) {
    failJson(res, 500, "polis_err_treevite_create_wave", err);
  }
}

// GET /api/v3/treevite/waves
// Lists waves for a conversation (optionally a specific wave)
export async function handle_GET_treevite_waves(req: any, res: any) {
  try {
    const zid = req.p.zid;
    const wave = typeof req.p.wave === "number" ? req.p.wave : null;

    if (typeof zid !== "number") {
      failJson(res, 400, "polis_err_treevite_missing_zid");
      return;
    }

    let q =
      "select id, zid, wave, parent_wave, invites_per_user, owner_invites, size, created_at, updated_at from treevite_waves where zid = ($1)";
    const params: any[] = [zid];
    if (wave !== null) {
      q += " and wave = ($2)";
      params.push(wave);
    }
    q += " order by wave asc;";

    const rows = await pg.queryP_readOnly(q, params);
    res.status(200).json(rows);
  } catch (err) {
    failJson(res, 500, "polis_err_treevite_list_waves", err);
  }
}
