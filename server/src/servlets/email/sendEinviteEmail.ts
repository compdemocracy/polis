function sendEinviteEmail(req: any, email: any, einvite: any) {
  const serverName = getServerNameWithProtocol(req);
  const body = `Welcome to pol.is!

Click this link to open your account:

${serverName}/welcome/${einvite}

Thank you for using Polis`;

  return sendTextEmail(
    polisFromAddress,
    email,
    "Get Started with Polis",
    body
  );
}