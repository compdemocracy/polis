import { Request, Response } from "express";
import { DynamoDB } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocument } from "@aws-sdk/lib-dynamodb";
import logger from "../../utils/logger";
import Config from "../../config";

// Initialize DynamoDB client with the same configuration as jobs.ts
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

const dynamoDbClient = new DynamoDB(dynamoDbConfig);
const docClient = DynamoDBDocument.from(dynamoDbClient);

/**
 * Handler for GET /api/v3/delphi/jobs/tree - Get a job tree by root_job_id or job_id
 */
export async function handle_GET_delphi_job_tree(
  req: Request,
  res: Response
): Promise<void> {
  try {
    const { root_job_id, job_id } = req.query;

    // Validate required parameters
    if (!root_job_id && !job_id) {
      res.status(400).json({
        status: "error",
        error: "Missing required parameter: either root_job_id or job_id must be provided",
      });
      return;
    }

    // If job_id is provided but root_job_id is not, find the root job first
    let rootJobId = root_job_id as string;
    if (!rootJobId && job_id) {
      // Get the job to find its root_job_id
      try {
        const jobResult = await docClient.get({
          TableName: "Delphi_JobQueue",
          Key: { job_id: job_id as string },
        });

        if (!jobResult.Item) {
          res.status(404).json({
            status: "error",
            error: `Job with ID ${job_id} not found`,
          });
          return;
        }

        // Use the job's root_job_id if it has one, otherwise use the job_id itself (it may be a root job)
        rootJobId = jobResult.Item.root_job_id || jobResult.Item.job_id;
      } catch (error) {
        logger.error(
          `Error getting job ${job_id}: ${
            error instanceof Error ? error.message : error
          }`
        );
        throw error;
      }
    }

    // Query for all jobs in the tree
    const treeJobs = await getJobTree(rootJobId);

    // Return the job tree
    res.json({
      status: "success",
      root_job_id: rootJobId,
      tree: treeJobs,
    });
  } catch (error) {
    logger.error(
      `Error getting job tree: ${
        error instanceof Error ? error.message : error
      }`
    );
    
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

/**
 * Handler for GET /api/v3/delphi/jobs/latest - Get the latest successful job for a conversation
 */
export async function handle_GET_delphi_latest_job(
  req: Request,
  res: Response
): Promise<void> {
  try {
    const { conversation_id, job_stage, job_type } = req.query;

    // Validate required parameters
    if (!conversation_id) {
      res.status(400).json({
        status: "error",
        error: "Missing required parameter: conversation_id must be provided",
      });
      return;
    }

    // Find the latest completed job for the conversation
    try {
      // Query the ConversationIndex using conversation_id
      const queryParams: any = {
        TableName: "Delphi_JobQueue",
        IndexName: "ConversationIndex",
        KeyConditionExpression: "conversation_id = :cid",
        FilterExpression: "#status = :status",
        ExpressionAttributeNames: {
          "#status": "status",
        },
        ExpressionAttributeValues: {
          ":cid": conversation_id as string,
          ":status": "COMPLETED",
        },
        ScanIndexForward: false, // Descending order by sort key (created_at)
        Limit: 50, // Get the most recent jobs
      };

      // Add job_stage filter if provided
      if (job_stage) {
        queryParams.FilterExpression += " AND #job_stage = :stage";
        queryParams.ExpressionAttributeNames["#job_stage"] = "job_stage";
        queryParams.ExpressionAttributeValues[":stage"] = job_stage as string;
      }

      // Add job_type filter if provided
      if (job_type) {
        queryParams.FilterExpression += " AND #job_type = :type";
        queryParams.ExpressionAttributeNames["#job_type"] = "job_type";
        queryParams.ExpressionAttributeValues[":type"] = job_type as string;
      }

      const jobResults = await docClient.query(queryParams);

      if (!jobResults.Items || jobResults.Items.length === 0) {
        res.status(404).json({
          status: "error",
          error: `No completed jobs found for conversation ${conversation_id}`,
        });
        return;
      }

      // Return the latest completed job
      res.json({
        status: "success",
        job: jobResults.Items[0],
      });
    } catch (error) {
      logger.error(
        `Error finding latest job for conversation ${conversation_id}: ${
          error instanceof Error ? error.message : error
        }`
      );
      throw error;
    }
  } catch (error) {
    logger.error(
      `Error getting latest job: ${
        error instanceof Error ? error.message : error
      }`
    );
    
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

/**
 * Handler for POST /api/v3/delphi/jobs/child - Create a child job
 */
export async function handle_POST_delphi_child_job(
  req: Request,
  res: Response
): Promise<void> {
  try {
    logger.info(
      `Creating child Delphi job with parameters: ${JSON.stringify(req.body)}`
    );

    // Extract parameters from request body
    const {
      parent_job_id,
      job_type = "FULL_PIPELINE",
      job_stage,
      conversation_id,
      priority = 50,
      job_config = {},
    } = req.body;

    // Validate required parameters
    if (!parent_job_id) {
      res.status(400).json({
        status: "error",
        error: "Missing required parameter: parent_job_id must be provided",
      });
      return;
    }

    // Get the parent job to inherit properties and verify it exists
    try {
      const parentJobResult = await docClient.get({
        TableName: "Delphi_JobQueue",
        Key: { job_id: parent_job_id },
      });

      if (!parentJobResult.Item) {
        res.status(404).json({
          status: "error",
          error: `Parent job with ID ${parent_job_id} not found`,
        });
        return;
      }

      const parentJob = parentJobResult.Item;
      
      // Create child job with inherited properties
      const childJob = await createChildJob(
        parent_job_id,
        job_type,
        job_stage || nextStageForJobType(job_type, parentJob.job_stage),
        conversation_id || parentJob.conversation_id,
        Number(priority),
        job_config
      );

      // Return success with job ID
      res.json({
        status: "success",
        job_id: childJob.job_id,
        parent_job_id: parent_job_id,
        root_job_id: childJob.root_job_id,
      });
    } catch (error) {
      logger.error(
        `Error creating child job: ${
          error instanceof Error ? error.message : error
        }`
      );
      throw error;
    }
  } catch (error) {
    logger.error(
      `Error creating child job: ${
        error instanceof Error ? error.message : error
      }`
    );
    
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

/**
 * Helper function to get a complete job tree by root_job_id
 */
async function getJobTree(rootJobId: string): Promise<any[]> {
  try {
    // First, get the root job directly
    const rootJobResult = await docClient.get({
      TableName: "Delphi_JobQueue",
      Key: { job_id: rootJobId },
    });

    const treeJobs = [];
    if (rootJobResult.Item) {
      treeJobs.push(rootJobResult.Item);
    }

    try {
      // Get all jobs with this job as their root (if we have the GSI)
      // Using scan with filter as a fallback approach
      const scanParams = {
        TableName: "Delphi_JobQueue",
        FilterExpression: "root_job_id = :rid",
        ExpressionAttributeValues: {
          ":rid": rootJobId,
        },
      };

      const scanResults = await docClient.scan(scanParams);
      if (scanResults.Items) {
        // Add only items we don't already have (exclude the root job we already added)
        for (const item of scanResults.Items) {
          if (item.job_id !== rootJobId) {
            treeJobs.push(item);
          }
        }
      }
    } catch (err) {
      logger.warn(`Could not scan for related jobs: ${err.message}`);
    }

    // Sort the jobs by created_at
    treeJobs.sort((a, b) => {
      return a.created_at.localeCompare(b.created_at);
    });

    return treeJobs;
  } catch (error) {
    logger.error(
      `Error getting job tree for root_job_id ${rootJobId}: ${
        error instanceof Error ? error.message : error
      }`
    );
    throw error;
  }
}

/**
 * Helper function to create a child job
 */
async function createChildJob(
  parentJobId: string,
  jobType: string,
  jobStage: string,
  conversationId: string,
  priority: number,
  jobConfig: any
): Promise<any> {
  try {
    // Get the parent job
    const parentJobResult = await docClient.get({
      TableName: "Delphi_JobQueue",
      Key: { job_id: parentJobId },
    });

    if (!parentJobResult.Item) {
      throw new Error(`Parent job with ID ${parentJobId} not found`);
    }

    const parentJob = parentJobResult.Item;
    
    // Get root_job_id from parent (or use parent_job_id if parent is the root)
    // Make sure we're not using empty strings (DynamoDB doesn't like empty strings in indexed fields)
    const rootJobId = (parentJob.root_job_id && parentJob.root_job_id !== "") ? parentJob.root_job_id : parentJob.job_id;
    
    // Generate a new job ID
    const jobId = require("uuid").v4();
    
    // Current timestamp in ISO format
    const now = new Date().toISOString();
    
    // Create job item with version number for optimistic locking
    const jobItem = {
      job_id: jobId, // Primary key
      status: "PENDING", // Secondary index key
      created_at: now, // Secondary index key
      updated_at: now,
      version: 1, // Version for optimistic locking
      started_at: "", // Using empty strings for nullable fields
      completed_at: "",
      worker_id: "none", // Non-empty placeholder for index
      job_type: jobType,
      job_stage: jobStage,
      priority: priority,
      conversation_id: String(conversationId),
      parent_job_id: parentJobId,
      root_job_id: rootJobId,
      retry_count: 0,
      max_retries: 3,
      timeout_seconds: 14400, // 4 hours default timeout
      job_config: typeof jobConfig === 'string' ? jobConfig : JSON.stringify(jobConfig),
      job_results: JSON.stringify({}),
      logs: JSON.stringify({
        entries: [
          {
            timestamp: now,
            level: "INFO",
            message: `Child job created for conversation ${conversationId}, parent: ${parentJobId}, root: ${rootJobId}`,
          },
        ],
        log_location: "",
      }),
      created_by: "api",
    };

    // Put item in DynamoDB
    await docClient.put({
      TableName: "Delphi_JobQueue",
      Item: jobItem,
    });

    return jobItem;
  } catch (error) {
    logger.error(
      `Error creating child job for parent ${parentJobId}: ${
        error instanceof Error ? error.message : error
      }`
    );
    throw error;
  }
}

/**
 * Helper function to determine the next stage based on job type and current stage
 */
function nextStageForJobType(jobType: string, currentStage?: string): string {
  // Default job stages progression
  const stageProgression = {
    FULL_PIPELINE: ["LOAD", "PCA", "UMAP", "TOPIC", "REPORT", "COMPLETE"],
    PCA: ["PCA"],
    UMAP: ["UMAP"],
    TOPIC_NAMING: ["TOPIC"],
    REPORT: ["REPORT"],
  };

  // If no current stage or it's not in the progression, return the first stage
  if (!currentStage || !stageProgression[jobType]) {
    return stageProgression[jobType]?.[0] || "UNKNOWN";
  }

  // Find the current stage in the progression
  const currentIndex = stageProgression[jobType].indexOf(currentStage);
  if (currentIndex === -1 || currentIndex === stageProgression[jobType].length - 1) {
    // If current stage not found or it's the last stage, return the first stage
    return stageProgression[jobType][0];
  }

  // Return the next stage in the progression
  return stageProgression[jobType][currentIndex + 1];
}