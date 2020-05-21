// Copyright (C) 2012-present, The Authors. This program is free software: you can redistribute it and/or  modify it under the terms of the GNU Affero General Public License, version 3, as published by the Free Software Foundation. This program is distributed in the hope that it will be useful, but WITHOUT ANY WARRANTY; without even the implied warranty of MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the GNU Affero General Public License for more details. You should have received a copy of the GNU Affero General Public License along with this program.  If not, see <http://www.gnu.org/licenses/>.
"use strict"

const nodemailer = require('nodemailer');
const Mailgun = require('mailgun').Mailgun;
const mailgun = new Mailgun(process.env.MAILGUN_API_KEY);

function EmailSenders(AWS) {

  function sendTextEmailWithBackup(sender, recipient, subject, text) {
    console.log("sending email with mailgun: " + [sender, recipient, subject, text].join(" "));
    let servername = "";
    let options = {};
    return new Promise(function(resolve, reject) {
      mailgun.sendText(sender, [recipient], subject, text, servername, options, function(err) {
        if (err) {
          console.error("Unable to send email via mailgun to " + recipient + " " + err);
          console.error("polis_err_mailgun_email_send_failed");
          reject(err);
        } else {
          console.log("sent email with mailgun to " + recipient);
          resolve();
        }
      });
    });
  }

  function sendTextEmail(sender, recipient, subject, text) {
    let mailOptions;

    if (process.env.DEV_MODE) {
      mailOptions = {
        host: 'maildev',
        port: 25,
        ignoreTLS: true,
      };
    } else {
      mailOptions = {
        // reads AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY from process.env
        SES: new AWS.SES({ apiVersion: '2010-12-01' })
      };
    }

    const transporter = nodemailer.createTransport(mailOptions);

    let promise = transporter.sendMail({from: sender, to: recipient, subject: subject, text: text}).catch(function(err) {
      console.error("polis_err_primary_email_sender_failed");
      console.error(err);
      return sendTextEmailWithBackup(sender, recipient, subject, text);
    });
    promise.catch(function(err) {
      console.error("polis_err_ses_email_send_failed");
      console.error("Unable to send email via ses to " + recipient);
      console.error(err);
    });
    return promise;
  }

  return {
    sendTextEmail: sendTextEmail,
    sendTextEmailWithBackupOnly: sendTextEmailWithBackup,
  };
}


module.exports = {
  EmailSenders: EmailSenders,
};
