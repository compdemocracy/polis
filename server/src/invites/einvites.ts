import { generateTokenP } from "../auth";
import { sendTextEmail } from "../email/senders";
import Config from "../config";
import pg from "../db/pg-query";

function _sendEinviteEmail(req: any, email: any, einvite: any) {
  const serverName = Config.getServerNameWithProtocol(req);
  const body = `Welcome to pol.is!

Click this link to open your account:

${serverName}/welcome/${einvite}

Thank you for using Polis`;

  return sendTextEmail(
    Config.polisFromAddress,
    email,
    "Get Started with Polis",
    body
  );
}

function doSendEinvite(req: any, email: any) {
  return generateTokenP(30, false).then(function (einvite: any) {
    return pg
      .queryP("insert into einvites (email, einvite) values ($1, $2);", [
        email,
        einvite,
      ])
      .then(function () {
        return _sendEinviteEmail(req, email, einvite);
      });
  });
}

export { doSendEinvite };
