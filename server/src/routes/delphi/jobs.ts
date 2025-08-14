import { v4 as uuidv4 } from "uuid";
import { Request, Response } from "express";
import { DynamoDB } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocument } from "@aws-sdk/lib-dynamodb";
import logger from "../../utils/logger";
import { getZidFromReport } from "../../utils/parameter";
import Config from "../../config";
import pg from "../../db/pg-query";

// Initialize DynamoDB client
const dynamoDbConfig: any = {
  region: Config.AWS_REGION || "us-east-1",
};

// If dynamoDbEndpoint is set, we're running locally (e.g., with Docker)
if (Config.dynamoDbEndpoint) {
  dynamoDbConfig.endpoint = Config.dynamoDbEndpoint;
  // Use dummy credentials for local DynamoDB
  dynamoDbConfig.credentials = {
    accessKeyId: "DUMMYIDEXAMPLE",
    secretAccessKey: "DUMMYEXAMPLEKEY",
  };
} else if (Config.AWS_ACCESS_KEY_ID && Config.AWS_SECRET_ACCESS_KEY) {
  // Use real credentials from environment
  dynamoDbConfig.credentials = {
    accessKeyId: Config.AWS_ACCESS_KEY_ID,
    secretAccessKey: Config.AWS_SECRET_ACCESS_KEY,
  };
}
// If neither are set, the SDK will use default credential provider chain

const dynamoDbClient = new DynamoDB(dynamoDbConfig);

// Create DocumentClient
const docClient = DynamoDBDocument.from(dynamoDbClient);

// Handler for POST /api/v3/delphi/jobs - Create a new Delphi job
export async function handle_POST_delphi_jobs(
  req: Request,
  res: Response
): Promise<void> {
  try {
    if (!req.p.delphiEnabled) {
      throw new Error("Unauthorized");
    }
    logger.info(
      `Creating Delphi job with parameters: ${JSON.stringify(req.body)}`
    );

    // Extract parameters from request body
    const {
      report_id,
      conversation_id,
      job_type = "FULL_PIPELINE",
      priority = 50,
      max_votes,
      batch_size,
      model = "claude-3-7-sonnet-20250219",
      include_topics = true,
    } = req.body;

    // Validate required parameters
    if (!report_id && !conversation_id) {
      res.status(400).json({
        status: "error",
        error:
          "Missing required parameter: either report_id or conversation_id must be provided",
      });
      return;
    }

    // Convert report_id to conversation_id if needed
    // Assuming there's a mapping function or service to do this
    const zid =
      conversation_id ||
      (report_id ? await getConversationIdFromReportId(report_id) : null);

    if (!zid) {
      res.status(400).json({
        status: "error",
        error: "Could not determine conversation ID",
      });
      return;
    }

    // Generate a unique job ID
    const job_id = uuidv4();

    // Current timestamp in ISO format
    const now = new Date().toISOString();

    // Build job configuration based on the Python CLI implementation
    const jobConfig: any = {};

    if (job_type === "FULL_PIPELINE") {
      // Full pipeline configs
      const stages = [];

      // PCA stage
      const pcaConfig: any = {};
      if (max_votes) {
        pcaConfig.max_votes = parseInt(max_votes, 10);
      }
      if (batch_size) {
        pcaConfig.batch_size = parseInt(batch_size, 10);
      }
      stages.push({ stage: "PCA", config: pcaConfig });

      // UMAP stage
      stages.push({
        stage: "UMAP",
        config: {
          n_neighbors: 15,
          min_dist: 0.1,
        },
      });

      // Report stage
      stages.push({
        stage: "REPORT",
        config: {
          model: model,
          include_topics: include_topics,
        },
      });

      // Add stages and visualizations to job config
      jobConfig.stages = stages;
      jobConfig.visualizations = ["basic", "enhanced", "multilayer"];
    }

    // Create job item with version number for optimistic locking
    const jobItem = {
      job_id: job_id, // Primary key
      status: "PENDING", // Secondary index key
      created_at: now, // Secondary index key
      updated_at: now,
      version: 1, // Version for optimistic locking
      started_at: "", // Using empty strings for nullable fields
      completed_at: "",
      worker_id: "none", // Non-empty placeholder for index
      job_type: job_type,
      priority: parseInt(String(priority), 10),
      conversation_id: String(zid), // Using conversation_id
      report_id: report_id, // Include report_id for proper S3 paths
      retry_count: 0,
      max_retries: 3,
      timeout_seconds: 14400, // 4 hours default timeout
      job_config: JSON.stringify(jobConfig),
      job_results: JSON.stringify({}),
      logs: JSON.stringify({
        entries: [
          {
            timestamp: now,
            level: "INFO",
            message: `Job created for conversation ${zid}`,
          },
        ],
        log_location: "",
      }),
      created_by: "api",
    };

    // Put item in DynamoDB
    try {
      logger.info(
        `Putting job item in DynamoDB: ${JSON.stringify({
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

      // Return success with job ID
      res.json({
        status: "success",
        job_id: job_id,
      });
    } catch (dbError) {
      logger.error(
        `Error writing to DynamoDB: ${
          dbError instanceof Error ? dbError.message : dbError
        }`
      );
      throw dbError; // Let the outer catch handle it
    }
  } catch (error) {
    logger.error(
      `Error creating Delphi job: ${
        error instanceof Error ? error.message : error
      }`
    );
    // Log more details for better debugging
    if (error instanceof Error) {
      logger.error(`Error name: ${error.name}`);
      logger.error(`Error stack: ${error.stack}`);
    }

    // Return detailed error for debugging
    res.status(500).json({
      status: "error",
      error: error instanceof Error ? error.message : "Unknown error",
      code:
        error instanceof Error && "code" in error
          ? (error as any).code
          : undefined,
      details: Config.nodeEnv === "development" ? String(error) : undefined,
    });
  }
}

// Helper function to get conversation_id from report_id
async function getConversationIdFromReportId(
  report_id: string
): Promise<string | null> {
  try {
    logger.info(`Getting conversation_id for report_id: ${report_id}`);

    // Use the existing util function if available, otherwise implement here
    if (typeof getZidFromReport === "function") {
      const zid = await getZidFromReport(report_id);
      // Ensure we return a string or null to match the function signature
      return zid !== null ? zid.toString() : null;
    }

    // Strip the 'r' prefix if it exists (e.g., r123abc -> 123abc)
    let normalized_report_id = report_id;
    if (report_id.startsWith("r") && report_id.length > 1) {
      normalized_report_id = report_id.substring(1);
    }

    // In this case, we need to query the zid from the zinvites table
    // The report_id is the same as the zinvite
    const query = `
      SELECT zid 
      FROM zinvites 
      WHERE zinvite = $1
    `;

    // Connect to PostgreSQL using the imported query function
    const rows = (await pg.queryP(query, [normalized_report_id])) as {
      zid: string;
    }[];

    if (rows.length === 0) {
      logger.error(`No conversation found for report_id: ${report_id}`);
      return null;
    }

    const zid = rows[0].zid;
    logger.info(`Found conversation_id ${zid} for report_id: ${report_id}`);

    return zid.toString();
  } catch (error) {
    logger.error(
      `Error mapping report_id to conversation_id: ${
        error instanceof Error ? error.message : error
      }`
    );
    if (error instanceof Error && error.stack) {
      logger.error(error.stack);
    }
    return null;
  }
}
