import crypto from "crypto";
import pg from "../db/pg-query";
import logger from "../utils/logger";

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
  req: { p: { zid: string } },
  res: { json: (arg0: ConversationUuidResponse) => void }
) {
  const { zid } = req.p;

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
