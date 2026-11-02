import { ExpressResponse } from "../d";
import pg from "../db/pg-query";
import { isPolisDev } from "../utils/common";
import logger from "../utils/logger";
import { addInRamMetric } from "../utils/metered";

interface XidAccount {
  owns_conversation: boolean;
  is_owner: boolean;
  site_moderator: boolean;
  oidc_mapped: boolean;
}

export function classifyXidAccount(account: XidAccount, isAdmin: boolean) {
  if (isAdmin) return "admin";
  if (account.owns_conversation) return "conversation_owner";
  if (account.is_owner) return "owner_flag";
  if (account.site_moderator) return "site_moderator";
  if (account.oidc_mapped) return "oidc_mapped";
  return undefined;
}

class XidAccountError extends Error {
  constructor(readonly accountClass: string, readonly status = 403) {
    super(
      status === 403
        ? "polis_err_xid_owner_account"
        : "polis_err_participant_creation"
    );
  }
}

/** A bare external identity must never confer account privileges. */
export async function requireXidParticipantAccount(uid: number): Promise<void> {
  if (isPolisDev(uid)) {
    throw new XidAccountError("admin");
  }

  let account: XidAccount;
  try {
    // Use the primary: privilege changes must not wait for a read replica.
    // EXISTS uses the existing owner, site_id and uid indexes; no locks or writes.
    const rows = await pg.queryP<XidAccount>(
      `SELECT u.is_owner,
        EXISTS (SELECT 1 FROM conversations c WHERE c.owner = u.uid)
          AS owns_conversation,
        EXISTS (SELECT 1 FROM users owner_user
          JOIN conversations c ON c.owner = owner_user.uid
          WHERE owner_user.site_id = u.site_id) AS site_moderator,
        EXISTS (SELECT 1 FROM oidc_user_mappings m WHERE m.uid = u.uid)
          AS oidc_mapped
       FROM users u WHERE u.uid = $1`,
      [uid]
    );
    // A missing account has no privileges; preserve existing token handling.
    if (!rows[0]) return;
    account = rows[0];
  } catch {
    // Optional participation and legacy-cookie auth must fail closed too.
    throw new XidAccountError("check_failed", 500);
  }

  const accountClass = classifyXidAccount(account, false);
  if (accountClass) throw new XidAccountError(accountClass);
}

export function isXidAccountError(error: unknown): error is XidAccountError {
  return error instanceof XidAccountError;
}

export function respondToXidAccountError(
  res: ExpressResponse,
  error: XidAccountError
) {
  // One countable event per refusal, with no identity values.
  addInRamMetric(`xid.refused.${error.accountClass}`, 1);
  logger.warn(error.message, { account_class: error.accountClass });
  return res.status(error.status).json({
    error: error.message,
    message: error.message,
    status: error.status,
  });
}
