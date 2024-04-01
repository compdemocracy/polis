import fs from 'fs';
import AWS from 'aws-sdk';
import nodemailer from 'nodemailer';
import mg from 'nodemailer-mailgun-transport';
import Config from '../config.js';
import logger from '../utils/logger.js';
AWS.config.update({ region: Config.awsRegion });
function sendTextEmailWithBackup(sender, recipient, subject, text) {
  const transportTypes = Config.emailTransportTypes ? Config.emailTransportTypes.split(',') : ['aws-ses', 'mailgun'];
  if (transportTypes.length < 2) {
    logger.warn('No backup email transport available.');
  }
  const backupTransport = transportTypes[1];
  sendTextEmail(sender, recipient, subject, text, backupTransport);
}
function isDocker() {
  return fs.existsSync('/.dockerenv');
}
function getMailOptions(transportType) {
  let mailgunAuth;
  switch (transportType) {
    case 'maildev':
      return {
        host: isDocker() ? 'maildev' : 'localhost',
        port: 1025,
        ignoreTLS: true
      };
    case 'mailgun':
      mailgunAuth = {
        auth: {
          api_key: Config.mailgunApiKey || 'unset-value',
          domain: Config.mailgunDomain || 'unset-value'
        }
      };
      return mg(mailgunAuth);
    case 'aws-ses':
      return {
        SES: new AWS.SES({ apiVersion: '2010-12-01' })
      };
    default:
      return {};
  }
}
function sendTextEmail(sender, recipient, subject, text, transportTypes = Config.emailTransportTypes, priority = 1) {
  if (!transportTypes) {
    return;
  }
  const transportTypesArray = transportTypes.split(',');
  const thisTransportType = transportTypesArray.shift();
  const nextTransportTypes = [...transportTypesArray];
  const mailOptions = getMailOptions(thisTransportType);
  const transporter = nodemailer.createTransport(mailOptions);
  let promise = transporter
    .sendMail({ from: sender, to: recipient, subject: subject, text: text })
    .catch(function (err) {
      logger.error('polis_err_email_sender_failed_transport_priority_' + priority.toString(), err);
      logger.error(
        `Unable to send email via priority ${priority.toString()} transport '${thisTransportType}' to: ${recipient}`,
        err
      );
      return sendTextEmail(sender, recipient, subject, text, nextTransportTypes.join(','), priority + 1);
    });
  return promise;
}
export { sendTextEmail, sendTextEmailWithBackup as sendTextEmailWithBackupOnly };
export default {
  sendTextEmail: sendTextEmail,
  sendTextEmailWithBackupOnly: sendTextEmailWithBackup
};
