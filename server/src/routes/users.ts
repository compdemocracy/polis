import _ from "underscore";
import { failJson } from "../utils/fail";
import { getConversationInfo } from "../conversation";
import { getUser } from "../user";
import { getXidRecord } from "../xids";
import { isModerator, isPolisDev } from "../utils/common";
import { sql_users } from "../db/sql";
import pg from "../db/pg-query";
import {
  generateSUZinvites,
  saveSuzinvites,
  sendSuzinviteEmail,
} from "../invites/suzinvites";
import type {
  UserType,
  ExpressRequest,
  ExpressResponse,
  ConversationInfo,
} from "../d";

// Types for better type safety
interface GetUsersRequest extends ExpressRequest {
  p: {
    uid?: number;
    xid: string;
    owner_uid?: number;
  };
}

interface PutUsersRequest extends ExpressRequest {
  p: {
    uid?: number;
    uid_of_user?: number;
    email?: string;
    hname?: string;
  };
}

export interface PostUsersInviteRequest extends ExpressRequest {
  p: {
    uid?: number;
    emails: string[];
    zid: number;
    conversation_id: string;
  };
}

interface StandardResponse extends ExpressResponse {
  status: (code: number) => { json: (data: any) => void };
}

async function handle_GET_users(
  req: GetUsersRequest,
  res: StandardResponse
): Promise<void> {
  let { uid } = req.p;
  const { xid, owner_uid } = req.p;
  let lookupXid: string | undefined = xid;
  let lookupOwnerUid = owner_uid;

  if (!uid) {
    failJson(res, 401, "Authentication required");
    return;
  }

  try {
    // Authorize the lookup before substituting the XID user's uid.
    if (xid && owner_uid) {
      const xidRecords = await getXidRecord(xid, undefined, owner_uid);
      const record = xidRecords?.[0];
      const mayRead =
        uid === owner_uid || isPolisDev(uid) || record?.uid === uid;
      if (!mayRead) {
        failJson(res, 403, "polis_err_get_user_not_authorized");
        return;
      }
      if (record) {
        uid = record.uid;
      } else {
        // No record was authorized: do not let getUser re-read a newly created XID.
        lookupXid = undefined;
        lookupOwnerUid = undefined;
      }
    }

    const user = await getUser(uid, null, lookupXid, lookupOwnerUid);
    res.status(200).json(user);
  } catch (error) {
    failJson(res, 500, "polis_err_getting_user_info", error);
  }
}

async function handle_PUT_users(
  req: PutUsersRequest,
  res: StandardResponse
): Promise<void> {
  let { uid } = req.p;
  const { uid_of_user, email, hname } = req.p;

  // Allow polis dev to update other users
  if (isPolisDev(uid) && uid_of_user) {
    uid = uid_of_user;
  }

  if (!uid) {
    failJson(res, 403, "Authentication required");
    return;
  }

  const fields: UserType = {};
  if (email !== undefined) {
    fields.email = email;
  }
  if (hname !== undefined) {
    fields.hname = hname;
  }

  // Both `email` and `hname` are want() parameters, so a request may carry
  // neither. sql_users.update({}) renders "UPDATE users SET  WHERE uid = …",
  // which Postgres rejects with a 42601 syntax error. Refuse the request
  // before any SQL is built rather than sending malformed SQL to the database.
  if (_.isEmpty(fields)) {
    failJson(res, 400, "polis_err_param_missing_user_fields");
    return;
  }

  try {
    const query = sql_users.update(fields).where(sql_users.uid.equals(uid));
    const result = await pg.queryP(query.toString(), []);
    res.status(200).json(result);
  } catch (error) {
    failJson(res, 500, "polis_err_put_user", error);
  }
}

// Helper function to record inviter relationship
async function addInviter(
  inviter_uid: number,
  invited_email: string
): Promise<void> {
  await pg.queryP(
    "INSERT INTO inviters (inviter_uid, invited_email) VALUES ($1, $2)",
    [inviter_uid, invited_email]
  );
}

async function handle_POST_users_invite(
  req: PostUsersInviteRequest,
  res: StandardResponse
): Promise<void> {
  const { uid, emails, zid, conversation_id } = req.p;

  if (!uid) {
    failJson(res, 403, "Authentication required");
    return;
  }

  // Sending join invitations for a conversation, and recording them against its
  // owner, is work performed on someone else's conversation. Only the owner, or a
  // moderator on the owner's site, may do it — the same ownership gate the other
  // conversation-admin routes use. Everyone else is refused before any read,
  // write or mail is sent.
  let isMod: boolean;
  try {
    isMod = await isModerator(zid, uid);
  } catch (err) {
    failJson(res, 500, "polis_err_sending_invite_auth_check", err);
    return;
  }
  if (!isMod) {
    failJson(res, 403, "polis_err_sending_invite_not_conversation_owner");
    return;
  }

  try {
    // Get conversation info
    const conversation: ConversationInfo = await getConversationInfo(zid);
    const { owner } = conversation;

    // Generate invitation tokens
    const suzinvites = generateSUZinvites(emails.length);

    // Save invites to database
    await saveSuzinvites(emails, suzinvites, zid, owner);

    // Send emails and record inviter relationships
    const emailPromises = emails.map(async (email, index) => {
      const suzinvite = suzinvites[index];

      try {
        await sendSuzinviteEmail(req, email, conversation_id, suzinvite);
        await addInviter(uid, email);
      } catch (error) {
        throw new Error(`Failed to send invite to ${email}: ${error}`);
      }
    });

    await Promise.all(emailPromises);

    res.status(200).json({
      status: "success",
    });
  } catch (error) {
    // Determine appropriate error message based on the step that failed
    let errorCode = "polis_err_sending_invite";

    if (error instanceof Error) {
      if (error.message.includes("conversation")) {
        errorCode = "polis_err_getting_conversation_info";
      } else if (error.message.includes("saving")) {
        errorCode = "polis_err_saving_invites";
      } else if (error.message.includes("generating")) {
        errorCode = "polis_err_generating_invites";
      }
    }

    failJson(res, 500, errorCode, error);
  }
}

export { handle_GET_users, handle_PUT_users, handle_POST_users_invite };
