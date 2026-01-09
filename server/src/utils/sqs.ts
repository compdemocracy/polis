import { SQSClient, SQSClientConfig } from "@aws-sdk/client-sqs";
import Config from "../config";

const clientConfig: SQSClientConfig = {
  region: Config.AWS_REGION || "us-east-1",
};

// ONLY add explicit credentials if they are REAL env vars (Local Dev).
// In ECS, these are undefined, so we skip this and let the SDK find the IAM Role.
// eslint-disable-next-line no-restricted-properties
if (process.env.AWS_ACCESS_KEY_ID && process.env.AWS_SECRET_ACCESS_KEY) {
  clientConfig.credentials = {
    // eslint-disable-next-line no-restricted-properties
    accessKeyId: process.env.AWS_ACCESS_KEY_ID,
    // eslint-disable-next-line no-restricted-properties
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
  };
}

// Support LocalStack endpoint if present
if (Config.SQS_LOCAL_ENDPOINT && Config.nodeEnv !== "production") {
  clientConfig.endpoint = Config.SQS_LOCAL_ENDPOINT;
}

export const sqsClient = new SQSClient(clientConfig);
