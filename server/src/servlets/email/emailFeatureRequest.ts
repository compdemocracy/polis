export default function emailFeatureRequest(message: string) {
  const body = `Somebody clicked a dummy button!

${message}`;

  return sendMultipleTextEmails(
    polisFromAddress,
    adminEmails,
    "Dummy button clicked!!!",
    body
  ).catch(function (err: any) {
    yell("polis_err_failed_to_email_for_dummy_button");
    yell(message);
  });
}

function emailTeam(subject: string, body: string) {
  return sendMultipleTextEmails(
    polisFromAddress,
    adminEmails,
    subject,
    body
  ).catch(function (err: any) {
    yell("polis_err_failed_to_email_team");
    yell(message);
  });
}

function emailBadProblemTime(message: string) {
  const body = `Yo, there was a serious problem. Here's the message:

${message}`;

  return emailTeam("Polis Bad Problems!!!", body);
}