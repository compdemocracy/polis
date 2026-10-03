// Copyright (C) 2012-present, The Authors. This program is free software: you can redistribute
// it and / or  modify it under the terms of the GNU Affero General Public License, version 3,
// as published by the Free Software Foundation.This program is distributed in the hope that it
// will be useful, but WITHOUT ANY WARRANTY; without even the implied warranty of MERCHANTABILITY
// or FITNESS FOR A PARTICULAR PURPOSE.See the GNU Affero General Public License for more details.
// You should have received a copy of the GNU Affero General Public License along with this program.
// If not, see < http://www.gnu.org/licenses/>.

import {
  SESv2Client,
  SendEmailCommand,
  SendEmailCommandOutput,
} from "@aws-sdk/client-sesv2";
import Config from "../config";
import logger from "../utils/logger";
import { shouldSkipEmail } from "../utils/offline";

const sesClient = new SESv2Client({
  region: Config.awsRegion,
  endpoint: Config.SESEndpoint,
  credentials: {
    accessKeyId: Config.awsAccessKeyId || "test",
    secretAccessKey: Config.awsSecretAccessKey || "test",
  },
});

async function sendTextEmail(
  sender: string,
  recipient: string,
  subject: string,
  text: string
): Promise<SendEmailCommandOutput> {
  const params = {
    Destination: {
      ToAddresses: [recipient],
    },
    Content: {
      Simple: {
        Subject: {
          Charset: "UTF-8",
          Data: subject,
        },
        Body: {
          Html: {
            Charset: "UTF-8",
            Data: `${text} + <br><i>Polis is powered by donations from people like you. Donate at <a href="https://donorbox.org/geo-polis">https://donorbox.org/geo-polis</a>.</i><br>`,
          },
          Text: {
            Charset: "UTF-8",
            Data: `${text} - Polis is powered by donations from people like you. Donate at https://donorbox.org/geo-polis.`,
          },
        },
      },
    },
    FromEmailAddress: sender,
  };

  if (shouldSkipEmail(Config)) {
    // OFFLINE with no SES_ENDPOINT: the SDK would reach real AWS. Log the
    // subject only (no recipient, no body) and report success with no id.
    logger.debug("polis_email_not_sent_offline", { subject });
    return { $metadata: {} } as SendEmailCommandOutput;
  }
  const command = new SendEmailCommand(params);
  return sesClient.send(command);
}

async function sendMultipleTextEmails(
  sender: string,
  recipientArray: string[] = [],
  subject: string,
  text: string
): Promise<PromiseSettledResult<SendEmailCommandOutput | void>[]> {
  const emailPromises = recipientArray.map((email) =>
    sendTextEmail(sender, email, subject, text)
  );

  const results = await Promise.allSettled(emailPromises);

  results.forEach((result, index) => {
    if (result.status === "rejected") {
      const recipient = recipientArray[index];
      const error = result.reason as Error;
      logger.error("polis_err_failed_to_email_user_definitively", {
        message: `Could not send email to user '${recipient}'.`,
        recipient,
        timestamp: new Date().toISOString(),
        finalError: {
          name: error.name,
          message: error.message,
          stack: error.stack,
        },
      });
    }
  });

  return results;
}

async function emailTeam(subject: string, body: string): Promise<void> {
  let adminEmails: string[] = [];
  try {
    if (Config.adminEmails) {
      adminEmails = JSON.parse(Config.adminEmails);
    }
  } catch (err) {
    logger.error("polis_err_email_config_parse_failure", {
      message: "Failed to parse JSON from Config.adminEmails.",
      configValue: Config.adminEmails,
      timestamp: new Date().toISOString(),
      cause: {
        name: (err as Error).name,
        message: (err as Error).message,
        stack: (err as Error).stack,
      },
    });
    return;
  }

  if (!Config.polisFromAddress) {
    logger.error("polis_err_email_config_missing_sender", {
      message: "The 'polisFromAddress' is not configured.",
      timestamp: new Date().toISOString(),
    });
    return;
  }

  if (adminEmails.length > 0) {
    await sendMultipleTextEmails(
      Config.polisFromAddress,
      adminEmails,
      subject,
      body
    );
  }
}

export { sendMultipleTextEmails, sendTextEmail, emailTeam };
