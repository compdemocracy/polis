import { sql_users } from "../db/sql";
import { failJson } from "../utils/fail";
import { getUser } from "../user";
import { isPolisDev, escapeLiteral } from "../utils/common";
import _ from "underscore";
import pg from "../db/pg-query";
import type {
  UserType,
  ExpressRequest,
  ExpressResponse,
  ConversationInfo,
} from "../d";
import { getConversationInfo } from "../conversation";
import { sendTextEmail } from "../email/senders";
import Config from "../config";

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

interface PostUsersInviteRequest extends ExpressRequest {
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
  const { uid, xid, owner_uid } = req.p;

  if (!uid) {
    failJson(res, 401, "Authentication required");
    return;
  }

  try {
    const user = await getUser(uid, null, xid, owner_uid);
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

  try {
    const query = sql_users.update(fields).where(sql_users.uid.equals(uid));
    const result = await pg.queryP(query.toString(), []);
    res.status(200).json(result);
  } catch (error) {
    failJson(res, 500, "polis_err_put_user", error);
  }
}

// Helper function to generate random invitation tokens
function generateSUZinvites(count: number): string[] {
  const invites: string[] = [];
  for (let i = 0; i < count; i++) {
    // Generate a random string similar to the original implementation
    const invite =
      Math.random().toString(36).substring(2, 15) +
      Math.random().toString(36).substring(2, 15);
    invites.push(invite);
  }
  return invites;
}

// Helper function to send invitation email
async function sendSuzinviteEmail(
  req: PostUsersInviteRequest,
  email: string,
  conversation_id: string,
  suzinvite: string
): Promise<void> {
  const serverName = Config.getServerNameWithProtocol(req);
  const body = [
    "Welcome to pol.is!",
    "",
    "Click this link to open your account:",
    "",
    `${serverName}/ot/${conversation_id}/${suzinvite}`,
    "",
    "Thank you for using Polis",
  ].join("\n");

  await sendTextEmail(
    Config.polisFromAddress,
    email,
    "Join the pol.is conversation!",
    body
  );
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

// Helper function to save invites to database
async function saveSuzinvites(
  emails: string[],
  suzinvites: string[],
  zid: number,
  owner: number
): Promise<void> {
  const pairs = _.zip(emails, suzinvites) as [string, string][];

  const valuesStatements = pairs.map(([email, suzinvite]) => {
    const xid = escapeLiteral(email);
    const suzinviteEscaped = escapeLiteral(suzinvite);
    return `(${suzinviteEscaped}, ${xid}, ${zid}, ${owner})`;
  });

  const query = `INSERT INTO suzinvites (suzinvite, xid, zid, owner) VALUES ${valuesStatements.join(
    ","
  )}`;

  return new Promise((resolve, reject) => {
    pg.query(query, [], (err: any) => {
      if (err) {
        reject(err);
      } else {
        resolve();
      }
    });
  });
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
