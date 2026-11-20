import { Response } from "express";
import pg from "../../db/pg-query";
import { failJson } from "../../utils/fail";
import Config from "../../config";
import { positiveId } from "./generationOwner";

/**
 * Whether an account may use Polis 2: start a Delphi pipeline run
 * (POST /api/v3/delphi/jobs), a narrative batch
 * (POST /api/v3/delphi/batchReports), a collective statement
 * (POST /api/v3/collectiveStatement) or the legacy narrative
 * (GET /api/v3/reportNarrative). Each of those routes asks here first, and
 * then applies the conversation-owner rule in generationOwner.ts, unchanged.
 * GET /api/v3/delphi/me answers the same question to the signed-in caller.
 *
 * Where the answer comes from is POLIS_DELPHI_ENTITLEMENT (Config
 * .delphiEntitlement):
 *   claim (the default): the access token's delphi_enabled claim
 *     (req.p.delphiEnabled), exactly as these routes have always read it. The
 *     database is never read for this.
 *   claim_or_db: the claim, or else a row for the account in
 *     delphi_entitlements (migration 000048).
 *   db: a row for the account only; the claim is not consulted.
 * Any other value is refused when the server starts (config.ts); one that
 * reaches this function anyway answers as claim.
 *
 * The database answer is one read by primary key on the ordinary read-write
 * pool (the primary, so a grant is seen at once). These routes never run in
 * participation scope, so the read can never take a connection a vote, a
 * comment or the next comment needs, and nothing slow happens while it holds
 * its connection. A failed read throws, so the route's own error reply
 * answers and nothing starts.
 *
 * The vote CSV import (POST /api/v3/votes-bulk) also requires the claim, and
 * still reads it directly (routes/votes.ts): it is not moved here.
 */
export type DelphiEntitlementSource = "claim" | "claim_or_db" | "db";

export const DELPHI_ENTITLEMENT_READ =
  "SELECT 1 FROM delphi_entitlements WHERE uid = ($1);";

async function hasEntitlementRow(uid: unknown): Promise<boolean> {
  const account = positiveId(uid);
  if (account === null) return false;
  const rows = (await pg.queryP(DELPHI_ENTITLEMENT_READ, [account])) as
    | unknown[]
    | undefined;
  return Array.isArray(rows) && rows.length === 1;
}

export async function isDelphiEntitled(p: {
  uid?: unknown;
  delphiEnabled?: unknown;
}): Promise<boolean> {
  const claim = Boolean(p.delphiEnabled);
  switch (Config.delphiEntitlement as string) {
    case "db":
      return hasEntitlementRow(p.uid);
    case "claim_or_db":
      return claim || hasEntitlementRow(p.uid);
    default:
      return claim;
  }
}

/**
 * GET /api/v3/delphi/me: whether the signed-in caller may use Polis 2,
 * {"delphi_entitled": true|false}, through isDelphiEntitled. It does not say
 * on which conversations: starting work still needs the conversation's owner
 * or a site administrator.
 */
export async function handle_GET_delphi_me(
  req: { p: { uid?: unknown; delphiEnabled?: unknown } },
  res: Response
): Promise<void> {
  try {
    const entitled = await isDelphiEntitled(req.p);
    res.status(200).json({ delphi_entitled: entitled });
  } catch (err) {
    failJson(res, 500, "polis_err_delphi_entitlement", err);
  }
}
