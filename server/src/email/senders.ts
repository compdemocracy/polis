// Copyright (C) 2012-present, The Authors. This program is free software: you can redistribute
// it and / or  modify it under the terms of the GNU Affero General Public License, version 3,
// as published by the Free Software Foundation.This program is distributed in the hope that it
// will be useful, but WITHOUT ANY WARRANTY; without even the implied warranty of MERCHANTABILITY
// or FITNESS FOR A PARTICULAR PURPOSE.See the GNU Affero General Public License for more details.
// You should have received a copy of the GNU Affero General Public License along with this program.
// If not, see < http://www.gnu.org/licenses/>.

import AWS from "aws-sdk";
import fs from "node:fs";
import mg from "nodemailer-mailgun-transport";
import nodemailer from "nodemailer";
import Config from "../config";
import logger from "../utils/logger";

AWS.config.update({ region: Config.awsRegion });

function sendTextEmailWithBackup(
  sender: any,
  recipient: any,
  subject: any,
  text: any
) {
  const transportTypes = Config.emailTransportTypes
    ? Config.emailTransportTypes.split(",")
    : ["aws-ses", "mailgun"];
  if (transportTypes.length < 2) {
    logger.warn("No backup email transport available.");
  }
  const backupTransport = transportTypes[1];
  sendTextEmail(sender, recipient, subject, text, backupTransport);
}

function isDocker() {
  return fs.existsSync("/.dockerenv");
}

function getMailOptions(transportType: any) {
  let mailgunAuth;

  switch (transportType) {
    case "maildev":
      return {
        host: isDocker() ? "maildev" : "localhost",
        port: 1025,
        ignoreTLS: true,
      };
    case "scaleway":
      return {
        host: Config.SCALEWAY_HOST,
        port: parseInt(Config.SCALEWAY_SMTP_PORT, 10) || undefined,
        secure: false,
        auth: {
          user: Config.SCALEWAY_USER,
          pass: Config.SCALEWAY_PASS,
        }
      };
    case "mailgun":
      mailgunAuth = {
        auth: {
          api_key: Config.mailgunApiKey || "unset-value",
          domain: Config.mailgunDomain || "unset-value",
        },
      };
      return mg(mailgunAuth);
    case "aws-ses":
      return {
        SES: new AWS.SES({ apiVersion: "2010-12-01" }),
      };
    default:
      throw new Error(
        `Unknown or undefined email transport type: ${transportType}`
      );
  }
}

function sendTextEmail(
  sender: any,
  recipient: any,
  subject: any,
  text: any,
  transportTypes = Config.emailTransportTypes,
  priority = 1
): Promise<any> {
  if (!transportTypes || transportTypes.length === 0) {
    // Base case for recursion: If all transports have been tried and failed,
    // create and throw a final, definitive error.
    const finalError = new Error(
      `All email transports failed for recipient: ${recipient}`
    );
    (finalError as any).code = "E_ALL_TRANSPORTS_FAILED";
    return Promise.reject(finalError);
  }

  const transportTypesArray = transportTypes.split(",");
  const thisTransportType = transportTypesArray.shift();
  const nextTransportTypes = [...transportTypesArray];

  try {
    const mailOptions = getMailOptions(thisTransportType);
    const transporter = nodemailer.createTransport(mailOptions);

    return transporter
      .sendMail({ from: sender, to: recipient, subject: subject, text: text })
      .catch(function (originalError: any) {
        const errorContext = {
          message: `Email transport failed at priority ${priority}.`,
          details: `Transport type '${thisTransportType}' failed for recipient '${recipient}'. Attempting failover.`,
          priority,
          transport: thisTransportType,
          recipient,
          timestamp: new Date().toISOString(),
          cause: {
            name: originalError.name,
            message: originalError.message,
            stack: originalError.stack,
            code: originalError.code,
          },
        };

        logger.error("polis_err_email_transport_failure", errorContext);

        return sendTextEmail(
          sender,
          recipient,
          subject,
          text,
          nextTransportTypes.join(","),
          priority + 1
        );
      });
  } catch (initializationError: any) {
    const errorContext = {
      message: `Failed to initialize email transporter at priority ${priority}.`,
      transport: thisTransportType,
      timestamp: new Date().toISOString(),
      cause: {
        name: initializationError.name,
        message: initializationError.message,
        stack: initializationError.stack,
      },
    };
    logger.error("polis_err_email_init_failure", errorContext);

    return sendTextEmail(
      sender,
      recipient,
      subject,
      text,
      nextTransportTypes.join(","),
      priority + 1
    );
  }
}

function sendMultipleTextEmails(
  sender: string | undefined,
  recipientArray: any[],
  subject: string,
  text: string
) {
  recipientArray = recipientArray || [];
  return Promise.all(
    recipientArray.map(function (email: string) {
      const promise = sendTextEmail(sender, email, subject, text);
      promise.catch(function (finalError: any) {
        logger.error("polis_err_failed_to_email_user_definitively", {
          message: `Could not send email to user '${email}' after trying all available transports.`,
          recipient: email,
          timestamp: new Date().toISOString(),
          finalError: {
            name: finalError.name,
            message: finalError.message,
            stack: finalError.stack,
            code: finalError.code,
          },
        });
      });
      return promise;
    })
  );
}

function emailTeam(subject: string, body: string) {
  const adminEmails = Config.adminEmails ? JSON.parse(Config.adminEmails) : [];

  return sendMultipleTextEmails(
    Config.polisFromAddress,
    adminEmails,
    subject,
    body
  ).catch(function (err: any) {
    logger.error("polis_err_uncaught_in_email_team", {
      message: "An unexpected error occurred in the emailTeam function.",
      timestamp: new Date().toISOString(),
      cause: {
        name: err.name,
        message: err.message,
        stack: err.stack,
      },
    });
  });
}

export {
  sendMultipleTextEmails,
  sendTextEmail,
  sendTextEmailWithBackup,
  emailTeam,
};
