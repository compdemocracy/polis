import bcrypt from "bcryptjs";
import crypto from "node:crypto";

import { failJson } from "../utils/fail";
import { generateRandomCode, generateLoginCode } from "../auth/generate-token";
import { getZinvite } from "../utils/zinvite";
import { issueAnonymousJWT } from "../auth/anonymous-jwt";
import Config from "../config";
import pg from "../db/pg-query";

async function insertInviteWithRetry(
  params: {
    zid: number;
    waveId: number;
    parentInviteId: number | null;
    inviteOwnerPid: number | null;
  },
  maxAttempts: number = 5
): Promise<number> {
  const { zid, waveId, parentInviteId, inviteOwnerPid } = params;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const code = generateRandomCode(10);
    const rows = await pg.queryP<{ id: number }>(
      "insert into treevite_invites (zid, wave_id, parent_invite_id, invite_code, invite_owner_pid) values (($1), ($2), ($3), ($4), ($5)) on conflict (zid, invite_code) do nothing returning id;",
      [zid, waveId, parentInviteId, code, inviteOwnerPid]
    );
    if (rows && (rows as any).length) {
      return (rows as any)[0].id as number;
    }
  }
  throw new Error("polis_err_treevite_invite_code_collision");
}

function computeFingerprint(zid: number, pid: number, code: string): string {
  const secret = Config.encryptionPassword || "polis_treevite_fingerprint_key";
  const hmac = crypto.createHmac("sha256", secret);
  hmac.update(`${zid}:${pid}:${code}`);
  return hmac.digest("hex");
}

async function upsertLoginCode(
  zid: number,
  pid: number,
  loginCode: string
): Promise<void> {
  const hash = await bcrypt.hash(loginCode, 10);
  const fp = computeFingerprint(zid, pid, loginCode);
  const lookup = crypto
    .createHash("sha256")
    .update(loginCode + (Config.loginCodePepper || ""))
    .digest("hex");
  await pg.queryP(
    "insert into treevite_login_codes (zid, pid, login_code_hash, login_code_fingerprint, login_code_lookup, fp_kid, revoked, last_used_at, updated_at) values (($1), ($2), ($3), ($4), ($5), 1, false, null, now()) on conflict (zid, pid) do update set login_code_hash = excluded.login_code_hash, login_code_fingerprint = excluded.login_code_fingerprint, login_code_lookup = excluded.login_code_lookup, fp_kid = excluded.fp_kid, revoked = false, updated_at = now();",
    [zid, pid, hash, fp, lookup]
  );
}

////// ROUTES //////

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

    const waveRow = insert && insert[0];

    // Create invites now
    const waveId = waveRow.id as number;

    // Owner invites (parentInviteId null, owner pid null)
    for (let i = 0; i < ownerInvites; i++) {
      await insertInviteWithRetry({
        zid,
        waveId,
        parentInviteId: null,
        inviteOwnerPid: null,
      });
    }

    // Per-user invites for members of parent wave
    if (invitesPerUser > 0) {
      if (parentWave > 0) {
        // find parent wave id
        const parentWaveRows = (await pg.queryP_readOnly(
          "select id from treevite_waves where zid = ($1) and wave = ($2);",
          [zid, parentWave]
        )) as { id: number }[];
        const parentWaveId =
          parentWaveRows && parentWaveRows[0] && parentWaveRows[0].id;

        if (!parentWaveId) {
          failJson(res, 400, "polis_err_treevite_parent_wave_not_found");
          return;
        }

        const parentMembers = (await pg.queryP_readOnly(
          "select id as parent_invite_id, invite_used_by_pid from treevite_invites where wave_id = ($1) and invite_used_by_pid is not null;",
          [parentWaveId]
        )) as { parent_invite_id: number; invite_used_by_pid: number }[];

        for (const member of parentMembers) {
          const ownerPid = member.invite_used_by_pid || null;
          for (let i = 0; i < invitesPerUser; i++) {
            await insertInviteWithRetry({
              zid,
              waveId,
              parentInviteId: member.parent_invite_id,
              inviteOwnerPid: ownerPid,
            });
          }
        }
      } else {
        // parentWave == 0 → create invites_per_user root invites
        for (let i = 0; i < invitesPerUser; i++) {
          await insertInviteWithRetry({
            zid,
            waveId,
            parentInviteId: null,
            inviteOwnerPid: null,
          });
        }
      }
    }

    // Return the wave row and a summary of invites created
    const countRows = await pg.queryP_readOnly(
      "select count(*)::int as total from treevite_invites where wave_id = ($1);",
      [waveId]
    );
    const totalInvites =
      countRows && countRows[0] && (countRows[0] as any).total;

    res.status(201).json({ ...waveRow, invites_created: totalInvites });
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
``;

// POST /api/v3/treevite/acceptInvite
// Exchange a valid invite code for participation and issue a login code + JWT
export async function handle_POST_treevite_acceptInvite(req: any, res: any) {
  try {
    const zid = req.p.zid;
    const inviteCode = (req.p.invite_code || "").trim();
    if (typeof zid !== "number" || !inviteCode) {
      failJson(res, 400, "polis_err_treevite_invalid_request");
      return;
    }

    // Validate invite and mark as used atomically
    const rows = (await pg.queryP(
      "update treevite_invites set status = 1, invite_used_by_pid = coalesce(invite_used_by_pid, -1), invite_used_at = now(), updated_at = now() where zid = ($1) and invite_code = ($2) and status = 0 returning id, wave_id, parent_invite_id, invite_used_by_pid;",
      [zid, inviteCode]
    )) as {
      id: number;
      wave_id: number;
      parent_invite_id: number | null;
      invite_used_by_pid: number | null;
    }[];

    if (!rows || !rows.length) {
      failJson(res, 400, "polis_err_treevite_invalid_or_used_invite");
      return;
    }

    // Ensure participant exists and get pid
    let pid: number | null = null;
    if (rows[0].invite_used_by_pid && rows[0].invite_used_by_pid >= 0) {
      pid = rows[0].invite_used_by_pid;
    }

    if (pid === null) {
      // We need uid/pid to set as the consumer. Try to get uid/pid from participants table for current req user; if none, create anon user and participant flow
      // Using existing helpers is involved here; for now, find or create a participant tied to the request's uid (if any)
      // If req.p.uid is missing, create a new anonymous user via a shortcut: insert into users and participants
      // However, to minimize scope, we map the used invite to an existing participant if provided in request (pid), else fail gracefully
      // For this incremental step, we will create a placeholder participant on demand
      const uidRows = (await pg.queryP(
        "insert into users (is_owner, site_owner) values (false, false) returning uid;"
      )) as { uid: number }[];
      const uid = uidRows[0].uid;
      const partRows = (await pg.queryP(
        "insert into participants (uid, zid) values (($1), ($2)) returning pid;",
        [uid, zid]
      )) as { pid: number }[];
      pid = partRows[0].pid;

      // Update the invite's used_by to this pid
      await pg.queryP(
        "update treevite_invites set invite_used_by_pid = ($1) where id = ($2);",
        [pid, rows[0].id]
      );
    }

    // Issue login code
    const loginCode = generateLoginCode(16);
    await upsertLoginCode(zid, pid as number, loginCode);

    // Issue participant JWT
    const conversationId = (await getZinvite(zid)) as string;
    const uidOfPidRows = (await pg.queryP_readOnly(
      "select uid from participants where zid = ($1) and pid = ($2);",
      [zid, pid]
    )) as { uid: number }[];
    const uid = uidOfPidRows[0].uid;
    const token = issueAnonymousJWT(conversationId, uid, pid as number);

    res.status(201).json({
      status: "ok",
      wave_id: rows[0].wave_id,
      invite_id: rows[0].id,
      login_code: loginCode,
      auth: {
        token,
        token_type: "Bearer",
        expires_in: 365 * 24 * 60 * 60,
      },
    });
  } catch (err) {
    failJson(res, 500, "polis_err_treevite_accept_invite", err);
  }
}

// POST /api/v3/treevite/login
// Submit a login_code to obtain a participant JWT
export async function handle_POST_treevite_login(req: any, res: any) {
  try {
    const zid = req.p.zid;
    const loginCode = (req.p.login_code || "").trim();
    if (typeof zid !== "number" || !loginCode) {
      failJson(res, 400, "polis_err_treevite_invalid_request");
      return;
    }

    // Fast lookup by peppered SHA-256
    const lookup = crypto
      .createHash("sha256")
      .update(loginCode + (Config.loginCodePepper || ""))
      .digest("hex");
    const candidateRows = (await pg.queryP_readOnly(
      "select pid, login_code_hash, revoked from treevite_login_codes where zid = ($1) and login_code_lookup = ($2) limit 1;",
      [zid, lookup]
    )) as { pid: number; login_code_hash: string; revoked: boolean }[];

    if (!candidateRows || !candidateRows.length || candidateRows[0].revoked) {
      failJson(res, 401, "polis_err_treevite_login_code_invalid");
      return;
    }

    const candidate = candidateRows[0];
    const ok = await bcrypt.compare(loginCode, candidate.login_code_hash);
    if (!ok) {
      failJson(res, 401, "polis_err_treevite_login_code_invalid");
      return;
    }
    const pid = candidate.pid;
    await pg.queryP(
      "update treevite_login_codes set last_used_at = now(), updated_at = now() where zid = ($1) and pid = ($2);",
      [zid, pid]
    );

    const conversationId = (await getZinvite(zid)) as string;
    const uidOfPidRows = (await pg.queryP_readOnly(
      "select uid from participants where zid = ($1) and pid = ($2);",
      [zid, pid]
    )) as { uid: number }[];
    const uid = uidOfPidRows[0].uid;
    const token = issueAnonymousJWT(conversationId, uid, pid);

    res.status(200).json({
      status: "ok",
      auth: {
        token,
        token_type: "Bearer",
        expires_in: 365 * 24 * 60 * 60,
      },
    });
  } catch (err) {
    failJson(res, 500, "polis_err_treevite_login_failed", err);
  }
}

// GET /api/v3/treevite/myInvites
// List invites owned by the participant to share
export async function handle_GET_treevite_myInvites(req: any, res: any) {
  try {
    const zid = req.p.zid;
    const pid = req.p.pid;
    if (typeof zid !== "number" || typeof pid !== "number") {
      failJson(res, 400, "polis_err_treevite_invalid_request");
      return;
    }

    const rows = await pg.queryP_readOnly(
      "select id, invite_code, status, created_at from treevite_invites where zid = ($1) and invite_owner_pid = ($2) and status = 0 order by id asc;",
      [zid, pid]
    );
    res.status(200).json(rows);
  } catch (err) {
    failJson(res, 500, "polis_err_treevite_list_my_invites", err);
  }
}
