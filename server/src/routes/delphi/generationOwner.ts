import { Response } from "express";
import pg from "../../db/pg-query";
import { failJson } from "../../utils/fail";
import Config from "../../config";

/**
 * Who may start Delphi work on a conversation: a pipeline run
 * (POST /api/v3/delphi/jobs), a narrative batch
 * (POST /api/v3/delphi/batchReports), a collective statement
 * (POST /api/v3/collectiveStatement) or the legacy narrative
 * (GET /api/v3/reportNarrative). Narratives and statements call a paid model.
 *
 * Each of those routes first checks the caller's delphi_enabled claim, as it
 * always has, and answers a caller without it exactly as before. The claim
 * says the account may use Delphi; it does not say on whose conversation. So
 * a caller with the claim must also own the conversation the request names,
 * or be a site administrator (isSiteAdministrator below). Moderators on the
 * owner's site get no right from this.
 *
 * Anyone else is refused with HTTP 403 and DELPHI_NOT_CONVERSATION_OWNER
 * before anything is admitted, written or sent to a model.
 *
 * The vote CSV import (POST /api/v3/votes-bulk), which needs the same claim,
 * applies the same rule through mayStartDelphiWork and answers its refusal
 * with a code of its own (routes/votes.ts).
 */
export const DELPHI_NOT_CONVERSATION_OWNER =
  "polis_err_delphi_not_conversation_owner";

const MAX_INT4 = 2147483647;

/** A positive integer id (number or decimal string), else null. */
function positiveId(value: unknown): number | null {
  if (typeof value !== "number" && typeof value !== "string") return null;
  const text = String(value);
  if (!/^[1-9][0-9]*$/.test(text)) return null;
  const id = Number(text);
  return Number.isSafeInteger(id) && id <= MAX_INT4 ? id : null;
}

/**
 * The uids ADMIN_UIDS names (Config.adminUIDs, the list the server's
 * isPolisDev reads), parsed with a shape check. Only a JSON array whose
 * entries are all positive int4 numbers names anyone, by exact numeric
 * membership. Any other value (a JSON string, a scalar, null, an object,
 * strings or other non-numbers in the array, invalid JSON) names nobody and
 * never throws here. Kept to these routes: the shared helper compares with
 * indexOf on whatever was parsed, so a JSON string would match by substring.
 */
const NO_ADMINISTRATORS: ReadonlySet<number> = new Set();
let administratorsFrom: unknown;
let administrators: ReadonlySet<number> = NO_ADMINISTRATORS;

function siteAdministrators(raw: unknown): ReadonlySet<number> {
  if (raw === administratorsFrom) return administrators;
  let parsed: unknown;
  try {
    parsed = typeof raw === "string" && raw !== "" ? JSON.parse(raw) : [];
  } catch {
    parsed = null;
  }
  const valid =
    Array.isArray(parsed) &&
    parsed.every(
      (v) =>
        typeof v === "number" &&
        Number.isSafeInteger(v) &&
        v > 0 &&
        v <= MAX_INT4
    );
  administratorsFrom = raw;
  administrators = valid ? new Set(parsed as number[]) : NO_ADMINISTRATORS;
  return administrators;
}

/** Site administrators may start Delphi work on any conversation. */
function isSiteAdministrator(uid: number): boolean {
  return siteAdministrators(Config.adminUIDs).has(uid);
}

/**
 * Whether `uid` may start Delphi work on conversation `zid`. One read of the
 * conversation's owner, by primary key, on the server's ordinary read-write
 * pool (these routes never run in participation scope). A zid or uid that is
 * not a conversation or account number is nobody's, and costs no read. A
 * failed read throws, so the route's own error reply answers and nothing
 * starts.
 */
export async function mayStartDelphiWork(
  zid: unknown,
  uid: unknown
): Promise<boolean> {
  const conversation = positiveId(zid);
  const caller = positiveId(uid);
  if (conversation === null || caller === null) return false;
  const rows = (await pg.queryP(
    "SELECT owner FROM conversations WHERE zid = ($1);",
    [conversation]
  )) as { owner: number | string | null }[];
  if (!Array.isArray(rows) || rows.length !== 1) return false;
  return positiveId(rows[0].owner) === caller || isSiteAdministrator(caller);
}

/** The refusal, the same on all four routes. */
export function refuseNotConversationOwner(res: Response): void {
  failJson(res, 403, DELPHI_NOT_CONVERSATION_OWNER);
}

/**
 * Whether two identifiers a request gave for its conversation name the same
 * conversation: both positive conversation numbers, and equal. A request that
 * names its conversation twice is admitted only if they agree, whoever sends
 * it, so ownership checked on one cannot carry work under the other.
 */
export function namesOneConversation(a: unknown, b: unknown): boolean {
  const first = positiveId(a);
  return first !== null && first === positiveId(b);
}
