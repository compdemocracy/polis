// Copyright (C) 2012-present, Polis Technology Inc. This program is free software: you can redistribute it and/or  modify it under the terms of the GNU Affero General Public License, version 3, as published by the Free Software Foundation. This program is distributed in the hope that it will be useful, but WITHOUT ANY WARRANTY; without even the implied warranty of MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the GNU Affero General Public License for more details. You should have received a copy of the GNU Affero General Public License along with this program.  If not, see <http://www.gnu.org/licenses/>.
"use strict"

const mailgun = require("mailgun-js")(
    {apiKey: process.env.MAILGUN_API_KEY, domain: process.env.MAILGUN_DOMAIN});

function EmailSenders(AWS) {
  const sesClient = new AWS.SES({apiVersion: '2010-12-01'}); // reads AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY from process.env

  function sendTextEmailWithSes(sender, recipient, subject, text) {
    console.log("sending email with SES: " + [sender, recipient, subject, text].join(" "));

    return new Promise(function(resolve, reject) {
      sesClient.sendEmail({
        Destination: {
          ToAddresses: [recipient],
        },
        Source: sender,
        Message: {
          Subject: {
            Data: subject,
          },
          Body: {
            Text: {
              Data: text,
            },
          },
        },

      }, function(err, data) {
        if (err) {
          console.error("polis_err_ses_email_send_failed");
          console.error("Unable to send email via ses to " + recipient);
          console.error(err);
          reject(err);
        } else {
          console.log("sent email with ses to " + recipient);
          resolve();
        }
      });
    });
  }
  
  function sendTextEmailWithMailgun(sender, recipient, subject, text) {
    console.log("sending email with Mailgun: " + [sender, recipient, subject, text].join("\n"));
  
    return new Promise(function(resolve, reject) {
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

  return {
    sendTextEmail: sendTextEmailWithMailgun
  };
}


module.exports = {
  EmailSenders: EmailSenders,
};
