const mailgun = require("mailgun-js")(
  {apiKey: process.env['MAILGUN_API_KEY'], domain: process.env['MAILGUN_DOMAIN']});

function sendText(sender, recipient, subject, text) {
  console.log("sending email with Mailgun: " + [sender, recipient, subject, text].join("\n"));

  return new Promise(function (resolve, reject) {
    var data = {
      from: sender,
      to: recipient,
      subject: subject,
      text: text
    };
    mailgun.messages().send(data, function (error, body) {
      console.log("Mailgun sent");
      console.log(body);
      if (error) {
        console.error(error);
        reject(error);
      } else {
        resolve();
      }
    });
  });
}

module.exports = {
  sendText
};
