import { Consumer } from "sqs-consumer";
import { sqsClient } from "../utils/sqs";
import { processImportJob } from "./import-processor";
import Config from "../config";
import pg from "../db/pg-query";
import logger from "../utils/logger";
import {
  VoteConventionStartupError,
  requireDeclaredConvention,
} from "../votes/dbConvention";

const queueUrl = Config.SQS_QUEUE_URL;

if (!queueUrl) {
  logger.error("Missing SQS_QUEUE_URL. Exiting.");
  process.exit(1);
}

logger.log({
  message: `[Worker] Starting Import Worker on queue: ${queueUrl}`,
  level: "info",
});

const app = Consumer.create({
  queueUrl: queueUrl,
  sqs: sqsClient,
  batchSize: 1, // Process one massive CSV at a time per container
  handleMessage: async (message) => {
    if (!message.Body) {
      return message;
    }

    try {
      const payload = JSON.parse(message.Body);
      logger.info(`[Worker] Received Job ${payload.jobId}`);
      await processImportJob(payload);
      return message;
    } catch (err) {
      logger.error(`[Worker] Critical error processing message:`, err);
      throw err;
    }
  },
});

app.on("error", (err) => logger.error("[Worker] SQS Error:", err));
app.on("processing_error", (err) =>
  logger.error("[Worker] Processing Error:", err.message)
);

// The worker writes votes: the database must declare its stored vote sign,
// and it must be the sign this build is built for (P-078;
// docs/vote-convention-upgrade.md). No message is consumed until it does.
requireDeclaredConvention(
  (sql: string) =>
    pg.queryP(sql) as Promise<Array<Record<string, unknown>>>,
  "import worker"
).then(
  (convention) => {
    logger.info(
      `[Worker] vote convention: version ${convention.version}, agree stored as ${convention.agreeValue}`
    );
    app.start();
  },
  (err: unknown) => {
    if (err instanceof VoteConventionStartupError) {
      logger.error(err.message);
    } else {
      logger.error("[Worker] failed to read the database's vote convention", err);
    }
    process.exit(1);
  }
);
