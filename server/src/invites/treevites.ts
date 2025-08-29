import bcrypt from "bcryptjs";
import crypto from "node:crypto";

import { failJson } from "../utils/fail";
import { generateRandomCode, generateLoginCode } from "../auth/generate-token";
import { getZinvite } from "../utils/zinvite";
import { issueAnonymousJWT } from "../auth/anonymous-jwt";
import {
  parsePagination,
  applySqlPagination,
  createPaginationMeta,
} from "../utils/pagination";
import Config from "../config";
import pg from "../db/pg-query";
import logger from "../utils/logger";

async function insertInviteWithRetry(
  params: {
    zid: number;
    waveId: number;
    parentInviteId: number | null;
    inviteOwnerPid: number | null;
  },
  maxAttempts = 5
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

/**
 * Create invite codes for a participant for all child waves that already exist
 * Called lazily when a participant joins a wave via acceptInvite
 */
async function createParticipantInviteCodes(
  zid: number,
  waveId: number,
  parentInviteId: number,
  pid: number
): Promise<void> {
  logger.info(
    `Creating participant invite codes for pid ${pid} in wave ${waveId}`
  );

  // First, get the wave number of the wave they joined
  const currentWaveRows = (await pg.queryP_readOnly(
    "select wave from treevite_waves where id = ($1);",
    [waveId]
  )) as { wave: number }[];

  if (!currentWaveRows || !currentWaveRows.length) {
    logger.warn(`Wave not found for waveId ${waveId}`);
    return;
  }

  const currentWave = currentWaveRows[0].wave;

  // Find all child waves of the wave they joined (where parent_wave = currentWave)
  const childWaveRows = (await pg.queryP_readOnly(
    "select id, wave, invites_per_user from treevite_waves where zid = ($1) and parent_wave = ($2) and invites_per_user > 0;",
    [zid, currentWave]
  )) as { id: number; wave: number; invites_per_user: number }[];

  let totalCodes = 0;

  // Create invite codes for each child wave
  for (const childWave of childWaveRows) {
    logger.info(
      `Creating ${childWave.invites_per_user} invite codes for pid ${pid} in child wave ${childWave.wave} (id: ${childWave.id})`
    );

    for (let i = 0; i < childWave.invites_per_user; i++) {
      await insertInviteWithRetry({
        zid,
        waveId: childWave.id,
        parentInviteId,
        inviteOwnerPid: pid,
      });
      totalCodes++;
    }
  }

  logger.info(
    `Created ${totalCodes} invite codes for participant ${pid} across ${childWaveRows.length} child waves`
  );
}

/**
 * Create invite codes retroactively for existing participants when a new child wave is created
 * This handles the case where participants joined the parent wave before the child wave existed
 */
async function createRetroactiveInviteCodes(
  zid: number,
  newWaveId: number,
  parentWaveId: number,
  invitesPerUser: number
): Promise<void> {
  // Find all participants who have already joined the parent wave
  const existingParticipants = (await pg.queryP_readOnly(
    "select id as parent_invite_id, invite_used_by_pid from treevite_invites where wave_id = ($1) and invite_used_by_pid is not null;",
    [parentWaveId]
  )) as { parent_invite_id: number; invite_used_by_pid: number }[];

  let createdCount = 0;

  // Create invite codes for each existing participant
  for (const participant of existingParticipants) {
    const ownerPid = participant.invite_used_by_pid;

    for (let i = 0; i < invitesPerUser; i++) {
      await insertInviteWithRetry({
        zid,
        waveId: newWaveId,
        parentInviteId: participant.parent_invite_id,
        inviteOwnerPid: ownerPid,
      });
      createdCount++;
    }
  }

  logger.info(
    `Created ${createdCount} retroactive invite codes for ${existingParticipants.length} existing participants in new wave ${newWaveId}`
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

    // Create invite codes for existing participants from parent wave
    if (invitesPerUser > 0 && parentWave > 0) {
      // Find parent wave id for retroactive code creation
      const parentWaveRows = (await pg.queryP_readOnly(
        "select id from treevite_waves where zid = ($1) and wave = ($2);",
        [zid, parentWave]
      )) as { id: number }[];
      const parentWaveId =
        parentWaveRows && parentWaveRows[0] && parentWaveRows[0].id;

      if (parentWaveId) {
        await createRetroactiveInviteCodes(
          zid,
          waveId,
          parentWaveId,
          invitesPerUser
        );
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

    // First, validate the invite code without marking it as used
    const inviteRows = (await pg.queryP_readOnly(
      "select id, wave_id, parent_invite_id, invite_used_by_pid from treevite_invites where zid = ($1) and invite_code = ($2) and status = 0;",
      [zid, inviteCode]
    )) as {
      id: number;
      wave_id: number;
      parent_invite_id: number | null;
      invite_used_by_pid: number | null;
    }[];

    if (!inviteRows || !inviteRows.length) {
      failJson(res, 400, "polis_err_treevite_invalid_or_used_invite");
      return;
    }

    const invite = inviteRows[0];
    let uid: number;
    let pid: number;

    // Check if we already have a participant from existing auth
    if (req.p.uid && req.p.pid && req.p.pid > 0) {
      // Use existing authenticated participant
      uid = req.p.uid;
      pid = req.p.pid;
    } else {
      // Create new anonymous user and participant
      // This bypasses the normal treevite protection since we have a valid invite
      const uidRows = (await pg.queryP(
        "insert into users (is_owner, site_owner) values (false, false) returning uid;"
      )) as { uid: number }[];
      uid = uidRows[0].uid;

      const partRows = (await pg.queryP(
        "insert into participants (uid, zid) values (($1), ($2)) returning pid;",
        [uid, zid]
      )) as { pid: number }[];
      pid = partRows[0].pid;
    }

    // Now mark the invite as used with the actual pid (atomically)
    const updateRows = (await pg.queryP(
      "update treevite_invites set status = 1, invite_used_by_pid = ($1), invite_used_at = now(), updated_at = now() where id = ($2) and status = 0 returning id;",
      [pid, invite.id]
    )) as { id: number }[];

    if (!updateRows || !updateRows.length) {
      // Race condition - invite was used by someone else between our check and update
      failJson(res, 400, "polis_err_treevite_invite_race_condition");
      return;
    }

    // Issue login code for the participant
    const loginCode = generateLoginCode(16);
    await upsertLoginCode(zid, pid, loginCode);

    // Create participant's own invite codes (lazy creation based on wave settings)
    await createParticipantInviteCodes(zid, invite.wave_id, invite.id, pid);

    // Issue participant JWT
    const conversationId = (await getZinvite(zid)) as string;
    const token = issueAnonymousJWT(conversationId, uid, pid);

    res.status(201).json({
      status: "ok",
      wave_id: invite.wave_id,
      invite_id: invite.id,
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
    logger.debug(
      `handle_GET_treevite_myInvites: ${JSON.stringify({ zid, pid })}`
    );

    if (typeof zid !== "number") {
      failJson(res, 400, "polis_err_treevite_missing_zid");
      return;
    }

    // If pid is undefined or -1, user hasn't participated in this conversation yet
    if (typeof pid !== "number" || pid === -1) {
      res.status(200).json([]);
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

// GET /api/v3/treevite/me
// Get current participant's treevite context (wave info + owned invites)
export async function handle_GET_treevite_me(req: any, res: any) {
  try {
    const zid = req.p.zid;
    const pid = req.p.pid;

    if (typeof zid !== "number") {
      failJson(res, 400, "polis_err_treevite_missing_zid");
      return;
    }

    // If pid is undefined or -1, user hasn't participated in this conversation yet
    if (typeof pid !== "number" || pid === -1) {
      res.status(200).json({
        participant: null,
        wave: null,
        invites: [],
      });
      return;
    }

    // Find which wave this participant entered through
    const participantWaveRows = (await pg.queryP_readOnly(
      "select ti.wave_id, tw.wave, tw.invites_per_user, tw.owner_invites, tw.size, ti.invite_used_at from treevite_invites ti join treevite_waves tw on ti.wave_id = tw.id where ti.zid = ($1) and ti.invite_used_by_pid = ($2) limit 1;",
      [zid, pid]
    )) as {
      wave_id: number;
      wave: number;
      invites_per_user: number;
      owner_invites: number;
      size: number;
      invite_used_at: string;
    }[];

    let waveInfo = null;
    if (participantWaveRows && participantWaveRows.length > 0) {
      const waveData = participantWaveRows[0];
      waveInfo = {
        wave_id: waveData.wave_id,
        wave: waveData.wave,
        invites_per_user: waveData.invites_per_user,
        owner_invites: waveData.owner_invites,
        size: waveData.size,
        joined_at: waveData.invite_used_at,
      };
    }

    // Get participant's owned invites
    const inviteRows = await pg.queryP_readOnly(
      "select id, invite_code, status, created_at, invite_used_by_pid, invite_used_at from treevite_invites where zid = ($1) and invite_owner_pid = ($2) order by created_at asc;",
      [zid, pid]
    );

    res.status(200).json({
      participant: {
        pid,
        zid,
      },
      wave: waveInfo,
      invites: inviteRows || [],
    });
  } catch (err) {
    failJson(res, 500, "polis_err_treevite_me", err);
  }
}

// GET /api/v3/treevite/invites
// List owner invites for a conversation with pagination and filtering
export async function handle_GET_treevite_invites(req: any, res: any) {
  try {
    const zid = req.p.zid;
    const waveId = typeof req.p.wave_id === "number" ? req.p.wave_id : null;
    const status = typeof req.p.status === "number" ? req.p.status : null;

    if (typeof zid !== "number") {
      failJson(res, 400, "polis_err_treevite_missing_zid");
      return;
    }

    // Parse pagination parameters
    const pagination = parsePagination(
      {
        limit: req.p.limit,
        offset: req.p.offset,
      },
      {
        defaultLimit: 50,
        maxLimit: 500,
      }
    );

    // Build base query and parameters
    let baseQuery =
      "select i.id, i.zid, i.wave_id, i.invite_code, i.status, i.invite_used_by_pid, i.invite_used_at, i.created_at, i.updated_at, w.wave from treevite_invites i left join treevite_waves w on i.wave_id = w.id where i.zid = ($1) and i.invite_owner_pid is null";
    let countQuery =
      "select count(*)::int as total from treevite_invites i where i.zid = ($1) and i.invite_owner_pid is null";
    const baseParams: unknown[] = [zid];

    // Add filters
    if (waveId !== null) {
      baseQuery += ` and i.wave_id = ($${baseParams.length + 1})`;
      countQuery += ` and i.wave_id = ($${baseParams.length + 1})`;
      baseParams.push(waveId);
    }

    if (status !== null) {
      baseQuery += ` and i.status = ($${baseParams.length + 1})`;
      countQuery += ` and i.status = ($${baseParams.length + 1})`;
      baseParams.push(status);
    }

    // Add ordering and pagination
    baseQuery += " order by i.created_at desc";
    const paginationSql = applySqlPagination(baseParams, pagination);
    const finalQuery = baseQuery + " " + paginationSql.sql;

    // Execute queries in parallel
    const [dataRows, countRows] = await Promise.all([
      pg.queryP_readOnly(finalQuery, paginationSql.params),
      pg.queryP_readOnly(countQuery, baseParams),
    ]);

    const total = countRows && countRows[0] && (countRows[0] as any).total;
    const paginationMeta = createPaginationMeta(
      pagination.limit,
      pagination.offset,
      total
    );

    res.status(200).json({
      invites: dataRows || [],
      pagination: paginationMeta,
    });
  } catch (err) {
    failJson(res, 500, "polis_err_treevite_list_invites", err);
  }
}
