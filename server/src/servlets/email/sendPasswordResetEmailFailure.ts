export default function sendPasswordResetEmailFailure(email: any, server: any) {
  let body = `We were unable to find a pol.is account registered with the email address: ${email}

You may have used another email address to create your account.

If you need to create a new account, you can do that here ${server}/home

Feel free to reply to this email if you need help.`;

  return sendTextEmail(polisFromAddress, email, "Password Reset Failed", body);
}
