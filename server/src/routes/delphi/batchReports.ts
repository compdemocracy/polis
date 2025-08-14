import { Request, Response } from "express";
import { v4 as uuidv4 } from "uuid";
import { DynamoDB } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocument } from "@aws-sdk/lib-dynamodb";
import logger from "../../utils/logger";
import { getZidFromReport } from "../../utils/parameter";
import Config from "../../config";

// Initialize DynamoDB client
const dynamoDbClient = new DynamoDB({
  endpoint: Config.DYNAMODB_ENDPOINT as string,
  region: Config.AWS_REGION as string,
  credentials: {
    accessKeyId: Config.AWS_ACCESS_KEY_ID as string,
    secretAccessKey: Config.AWS_SECRET_ACCESS_KEY as string,
  },
});

// Create DocumentClient
const docClient = DynamoDBDocument.from(dynamoDbClient);

/**
 * Handler for Delphi API route that generates batch narrative reports
 * This implementation submits a job to the Delphi_JobQueue DynamoDB table
 * which will be processed by the job poller running in the delphi container
 */
export async function handle_POST_delphi_batch_reports(
  req: Request,
  res: Response
) {
  logger.info("Delphi Batch Reports API request received");

  // Get report_id from request
  const report_id = req.body.report_id as string;

  if (!report_id) {
    return res.json({
      status: "error",
      message: "report_id is required",
    });
  }

  // Extract zid from report_id
  try {
    if (!req.p.delphiEnabled) {
      throw new Error("Unauthorized");
    }
    const zid = await getZidFromReport(report_id);
    if (!zid) {
      return res.json({
        status: "error",
        message: "Could not find conversation for report_id",
        report_id: report_id,
      });
    }

    const conversation_id = zid.toString();
    logger.info(
      `Generating batch reports for conversation_id: ${conversation_id}`
    );

    // Model parameter - must be explicitly set
    // eslint-disable-next-line no-restricted-properties
    const model = (req.body.model as string) || process.env.ANTHROPIC_MODEL;
    if (!model) {
      return res.json({
        status: "error",
        message:
          "Model must be specified in request or ANTHROPIC_MODEL environment variable must be set",
      });
    }
    const max_batch_size = (req.body.max_batch_size as number) || 20;
    const no_cache = (req.body.no_cache as boolean) || false;

    // No need to configure DynamoDB client here, it's done at module level

    // Generate job_id using report_id to avoid exposing ZID
    const timestamp = Math.floor(Date.now() / 1000);
    const randomSuffix = uuidv4().substring(0, 8);
    const job_id = `batch_report_${report_id}_${timestamp}_${randomSuffix}`;

    // Build job configuration for narrative batch
    const jobConfig = {
      job_type: "CREATE_NARRATIVE_BATCH",
      stages: [
        {
          stage: "CREATE_NARRATIVE_BATCH_CONFIG_STAGE",
          config: {
            model: model,
            max_batch_size: max_batch_size,
            no_cache: no_cache,
            report_id: report_id,
          },
        },
      ],
    };

    // Create job item
    const jobItem = {
      job_id: job_id,
      status: "PENDING",
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      conversation_id: conversation_id,
      report_id: report_id,
      job_type: "CREATE_NARRATIVE_BATCH",
      job_config: JSON.stringify(jobConfig),
      priority: 50, // Medium priority
      version: 1,
      worker_id: "none", // Non-empty placeholder for index
      started_at: "",
      completed_at: "",
      job_results: "{}",
      logs: JSON.stringify({ entries: [] }),
      environment: JSON.stringify({
        NARRATIVE_BATCH_MODEL: model,
        NARRATIVE_BATCH_MAX_SIZE: max_batch_size.toString(),
        NARRATIVE_BATCH_NO_CACHE: no_cache ? "1" : "0",
      }),
    };

    // Submit job to DynamoDB
    logger.info(
      `Submitting narrative batch job to queue: ${job_id} for conversation ${conversation_id}`
    );

    logger.info(
      `Putting narrative batch job in DynamoDB: ${JSON.stringify({
        TableName: "Delphi_JobQueue",
        Item: {
          job_id: jobItem.job_id,
          conversation_id: jobItem.conversation_id,
        },
      })}`
    );

    await docClient.put({
      TableName: "Delphi_JobQueue",
      Item: jobItem,
    });

    logger.info(`Successfully submitted job ${job_id} to Delphi_JobQueue`);

    return res.json({
      status: "success",
      message: "Batch report generation job submitted",
      report_id: report_id,
      job_id: job_id,
      batch_id: job_id, // Include batch_id field for frontend compatibility
      model: model,
      max_batch_size: max_batch_size,
      no_cache: no_cache,
    });
  } catch (err: any) {
    logger.error(`Error in delphi batch reports endpoint: ${err.message}`);
    if (err instanceof Error && err.stack) {
      logger.error(err.stack);
    }

    return res.json({
      status: "error",
      message: "Error processing request",
      error: err instanceof Error ? err.message : "Unknown error",
      report_id: report_id,
    });
  }
}
