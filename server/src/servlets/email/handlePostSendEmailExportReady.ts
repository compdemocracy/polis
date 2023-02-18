export default function handle_POST_sendEmailExportReady(
  req: {
    p: {
      webserver_pass: string | undefined;
      webserver_username: string | undefined;
      email: any;
      conversation_id: string;
      filename: any;
    };
  },
  res: {
    status: (
      arg0: number
    ) => { (): any; new (): any; json: { (arg0: {}): void; new (): any } };
  }
) {
  if (
    req.p.webserver_pass !== Config.webserverPass ||
    req.p.webserver_username !== Config.webserverUsername
  ) {
    return fail(res, 403, "polis_err_sending_export_link_to_email_auth");
  }

  const serverUrl = Config.getServerUrl();
  const email = req.p.email;
  const subject =
    "Polis data export for conversation pol.is/" + req.p.conversation_id;
  const fromAddress = `Polis Team <${Config.adminEmailDataExport}>`;
  const body = `Greetings

You created a data export for conversation ${serverUrl}/${req.p.conversation_id} that has just completed. You can download the results for this conversation at the following url:

${serverUrl}/api/v3/dataExport/results?filename=${req.p.filename}&conversation_id=${req.p.conversation_id}

Please let us know if you have any questions about the data.

Thanks for using Polis!
`;

  console.log("SENDING EXPORT EMAIL");
  console.log({
    serverUrl,
    email,
    subject,
    fromAddress,
    body,
  });
  sendTextEmail(fromAddress, email, subject, body)
    .then(function () {
      res.status(200).json({});
    })
    .catch(function (err: any) {
      fail(res, 500, "polis_err_sending_export_link_to_email", err);
    });
}