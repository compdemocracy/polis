import { SendMessageCommand } from "@aws-sdk/client-sqs";
import { PutObjectCommand } from "@aws-sdk/client-s3";
import fs from "fs";
import path from "path";
import { sqsClient } from "./src/utils/sqs";
import { S3Client, S3ClientConfig } from "@aws-sdk/client-s3";
import pg from "./src/db/pg-query";
import Config from "./src/config";

const QUEUE_URL =
  Config.SQS_QUEUE_URL ||
  "http://localhost:4566/000000000000/import-jobs-queue";
const BUCKET_NAME = Config.AWS_S3_BUCKET_NAME || "polis-delphi";
const ZID = 55;
const CSV_FILENAME = "test_import.csv";

// --- S3 Configuration ---
const customEndpoint = Config.AWS_S3_ENDPOINT;

const config: S3ClientConfig = {
  region: Config.AWS_REGION || "us-east-1",
  credentials: {
    accessKeyId: Config.AWS_ACCESS_KEY_ID || "minioadmin",
    secretAccessKey: Config.AWS_SECRET_ACCESS_KEY || "minioadmin",
  },
};

if (customEndpoint) {
  config.endpoint = customEndpoint;
  config.forcePathStyle = true;
}

export const s3Client = new S3Client(config);

async function main() {
  console.log("🚀 Starting End-to-End Import Test");

  try {
    // 0. Verify CSV exists locally
    const filePath = path.join(process.cwd(), CSV_FILENAME);
    if (!fs.existsSync(filePath)) {
      throw new Error(`CSV file not found at ${filePath}. Create it first!`);
    }

    // 1. Upload CSV to S3 (MinIO)
    console.log(`📤 Uploading ${CSV_FILENAME} to bucket '${BUCKET_NAME}'...`);
    const fileContent = fs.readFileSync(filePath);
    await s3Client.send(
      new PutObjectCommand({
        Bucket: BUCKET_NAME,
        Key: CSV_FILENAME,
        Body: fileContent,
      })
    );
    console.log("✅ Upload Complete");

    // 2. Insert Job Record into DB
    console.log("💾 Creating DB Job Record...");
    const insertQuery = `
      INSERT INTO byod_import_jobs (zid, s3_key, status, stage, created_at)
      VALUES ($1, $2, 'pending', 'mapping', NOW())
      RETURNING id;
    `;
    const res = await pg.queryP(insertQuery, [ZID, CSV_FILENAME]);
    const jobId = res[0].id;
    console.log(`✅ Job ID ${jobId} created`);

    // 3. Send SQS Message
    console.log("📨 Sending SQS Message...");
    await sqsClient.send(
      new SendMessageCommand({
        QueueUrl: QUEUE_URL,
        MessageBody: JSON.stringify({
          jobId: jobId,
          zid: ZID,
          s3Key: CSV_FILENAME,
        }),
      })
    );
    console.log(`✅ Message sent! Worker should pick it up momentarily.`);

    console.log("\n--- NEXT STEPS ---");
    console.log(
      "1. Watch logs: docker compose --profile local-services logs -f import-worker"
    );
    console.log("2. Verify DB:  SELECT * FROM votes WHERE zid = 55;");
  } catch (err) {
    console.error("❌ Test Failed:", err);
  } finally {
    process.exit(0);
  }
}

main();
