// Copyright (C) 2012-present, The Authors. This program is free software: you can redistribute it and/or  modify it under the terms of the GNU Affero General Public License, version 3, as published by the Free Software Foundation. This program is distributed in the hope that it will be useful, but WITHOUT ANY WARRANTY; without even the implied warranty of MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the GNU Affero General Public License for more details. You should have received a copy of the GNU Affero General Public License along with this program.  If not, see <http://www.gnu.org/licenses/>.
"use strict"

const fs = require('fs');
const nodemailer = require('nodemailer');
const AWS = require('aws-sdk');
AWS.config.set('region', process.env.AWS_REGION);

function sendTextEmailWithBackup(sender, recipient, subject, text) {
  const transportTypes = process.env.EMAIL_TRANSPORT_TYPES
    ? process.env.EMAIL_TRANSPORT_TYPES.split(',')
    : ['aws-ses', 'mailgun']
  if (transportTypes.length < 2) {
    new Error('No backup email transport available.');
  }
  const backupTransport = transportTypes[1];
  sendTextEmail(sender, recipient, subject, text, backupTransport);
}

function isDocker() {
  // See: https://stackoverflow.com/a/25518345/504018
  return fs.existsSync('/.dockerenv');
}

function getMailOptions(transportType) {
  switch (transportType) {
    case 'maildev':
      return {
        // Allows running outside docker, connecting to exposed port of maildev container.
        host: isDocker() ? 'maildev' : 'localhost',
        port: 25,
        ignoreTLS: true,
      }
    case 'mailgun':
      const mg = require('nodemailer-mailgun-transport');
      const mailgunAuth = {
        auth: {
          api_key: process.env.MAILGUN_API_KEY,
          domain: process.env.MAILGUN_DOMAIN
        }
      }
      return mg(mailgunAuth)
    case 'aws-ses':
      return {
        // reads AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY from process.env
        SES: new AWS.SES({ apiVersion: '2010-12-01' })
      }
    default:
      return {};
  }
}

function sendTextEmail(sender, recipient, subject, text, transportTypes = process.env.EMAIL_TRANSPORT_TYPES, priority = 1) {
  // Exit if empty string passed.
  if (!transportTypes) { return }

  transportTypes = transportTypes.split(',');
  // Shift first index and clone to rename.
  const thisTransportType = transportTypes.shift();
  const nextTransportTypes = [...transportTypes];
  const mailOptions = getMailOptions(thisTransportType);
  const transporter = nodemailer.createTransport(mailOptions);

  let promise = transporter.sendMail({from: sender, to: recipient, subject: subject, text: text})
    .catch(function(err) {
    console.error("polis_err_email_sender_failed_transport_priority_" + priority.toString());
    console.error(`Unable to send email via priority ${priority.toString()} transport '${thisTransportType}' to: ${recipient}`);
    console.error(err);
    return sendTextEmail(sender, recipient, subject, text, nextTransportTypes.join(','), priority + 1);
  });
  return promise;
}

module.exports = {
  sendTextEmail: sendTextEmail,
  sendTextEmailWithBackupOnly: sendTextEmailWithBackup,
};
