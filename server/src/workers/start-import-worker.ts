import { Consumer } from "sqs-consumer";
import { sqsClient } from "../utils/sqs";
import { processImportJob } from "./import-processor";
import Config from "../config";
import logger from "../utils/logger";

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

app.on("error", (err) => logger.error("[Worker] SQS Error:", err.message));
app.on("processing_error", (err) =>
  logger.error("[Worker] Processing Error:", err.message)
);

app.start();
