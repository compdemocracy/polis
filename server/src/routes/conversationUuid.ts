import crypto from "crypto";
import pg from "../db/pg-query";
import logger from "../utils/logger";
import { isModerator } from "../utils/common";
import { failJson } from "../utils/fail";

function generateUuid(): string {
  return crypto.randomUUID();
}

// Define the response type
interface ConversationUuidResponse {
  conversation_uuid?: string;
  error?: string;
}

// Define the zinvite row type
interface ZinviteRow {
  uuid: string | null;
}

export async function handle_GET_conversationUuid(
  req: { p: { uid?: number; zid: number } },
  res: { json: (arg0: ConversationUuidResponse) => void }
) {
  const { uid, zid } = req.p;

  // The conversation UUID is the capability key for the participant-XID export
  // (GET /api/v3/xid/:xid_report): anyone holding it can download the
  // conversation's participant identifiers. Returning or minting it is therefore
  // work performed against someone else's conversation, so it takes the same
  // ownership gate as the other admin operations on a conversation (the data
  // export and the XID admin routes): only the conversation's owner or a
  // moderator on the owner's site may obtain it. Non-owners get 403 and no UUID
  // is created for them.
  let isMod: boolean;
  try {
    isMod = await isModerator(zid, uid);
  } catch (err) {
    return failJson(res, 500, "polis_err_conversation_uuid_auth_check", err);
  }
  if (!isMod) {
    return failJson(res, 403, "polis_err_conversation_uuid_auth");
  }

  try {
    // First, check if a UUID already exists for this conversation
    const queryResult = await pg.queryP_readOnly(
      "SELECT uuid FROM zinvites WHERE zid = $1",
      [zid]
    );
    const existingRows = queryResult as ZinviteRow[];

    if (existingRows.length === 0) {
      throw new Error(`No zinvite found for zid: ${zid}`);
    }

    let uuid = existingRows[0].uuid;

    // If no UUID exists, generate and store a new one
    if (!uuid) {
      uuid = generateUuid();
      await pg.queryP("UPDATE zinvites SET uuid = $1 WHERE zid = $2", [
        uuid,
        zid,
      ]);
    }

    res.json({
      conversation_uuid: uuid,
    });
  } catch (err) {
    // Log the error and send a 500 response
    logger.error(`Error retrieving/creating UUID for zid ${zid}:`, err);
    res.json({
      error: "Error retrieving or creating conversation UUID",
    });
  }
}
