import { SQSClient } from "@aws-sdk/client-sqs";
import Config from "../config";

export const sqsClient = new SQSClient({
  region: Config.AWS_REGION || "us-east-1",
  credentials: {
    accessKeyId: Config.AWS_ACCESS_KEY_ID || "test", // Localstack accepts any string
    secretAccessKey: Config.AWS_SECRET_ACCESS_KEY || "test",
  },
  // CRITICAL: If local, override endpoint.
  // If running via docker-compose, use the service name "http://localstack:4566"
  // If running node on host machine, use "http://localhost:4566"
  endpoint:
    Config.nodeEnv === "development" ? Config.SQS_LOCAL_ENDPOINT : undefined,
});
