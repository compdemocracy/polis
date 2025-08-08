/**
 * DynamoDB test helpers for managing test data in DynamoDB tables
 */
import {
  DynamoDBClient,
  CreateTableCommand,
  // DeleteTableCommand,
  DescribeTableCommand,
} from "@aws-sdk/client-dynamodb";
import {
  DynamoDBDocumentClient,
  PutCommand,
  QueryCommand,
  DeleteCommand,
} from "@aws-sdk/lib-dynamodb";
import Config from "../../src/config";
import logger from "../../src/utils/logger";

// DynamoDB configuration for test environment
const dynamoDBConfig: any = {
  region: Config.AWS_REGION || "us-east-1",
};

if (Config.dynamoDbEndpoint) {
  dynamoDBConfig.endpoint = Config.dynamoDbEndpoint;
  dynamoDBConfig.credentials = {
    accessKeyId: "DUMMYIDEXAMPLE",
    secretAccessKey: "DUMMYEXAMPLEKEY",
  };
}

const dynamoClient = new DynamoDBClient(dynamoDBConfig);
const docClient = DynamoDBDocumentClient.from(dynamoClient, {
  marshallOptions: {
    convertEmptyValues: true,
    removeUndefinedValues: true,
  },
});

// Export clients for reuse
export { dynamoClient, docClient };

/**
 * Ensures the Delphi_JobQueue table exists
 */
export async function ensureJobQueueTableExists(): Promise<void> {
  const tableName = "Delphi_JobQueue";

  try {
    // Check if table exists
    await dynamoClient.send(new DescribeTableCommand({ TableName: tableName }));
    logger.info(`Table ${tableName} already exists`);
  } catch (error: any) {
    if (error.name === "ResourceNotFoundException") {
      // Create the table
      logger.info(`Creating table ${tableName}...`);

      const createTableParams = {
        TableName: tableName,
        KeySchema: [{ AttributeName: "job_id", KeyType: "HASH" }],
        AttributeDefinitions: [
          { AttributeName: "job_id", AttributeType: "S" },
          { AttributeName: "conversation_id", AttributeType: "S" },
          { AttributeName: "created_at", AttributeType: "S" },
        ],
        BillingMode: "PAY_PER_REQUEST",
        GlobalSecondaryIndexes: [
          {
            IndexName: "ConversationIndex",
            KeySchema: [
              { AttributeName: "conversation_id", KeyType: "HASH" },
              { AttributeName: "created_at", KeyType: "RANGE" },
            ],
            Projection: { ProjectionType: "ALL" },
          },
        ],
      };

      await dynamoClient.send(new CreateTableCommand(createTableParams as any));

      // Wait for table to be active
      let tableActive = false;
      let attempts = 0;
      while (!tableActive && attempts < 30) {
        try {
          const response = await dynamoClient.send(
            new DescribeTableCommand({ TableName: tableName })
          );
          if (response.Table?.TableStatus === "ACTIVE") {
            tableActive = true;
            logger.info(`Table ${tableName} is now active`);
          } else {
            await new Promise((resolve) => setTimeout(resolve, 1000));
            attempts++;
          }
        } catch (e) {
          await new Promise((resolve) => setTimeout(resolve, 1000));
          attempts++;
        }
      }

      if (!tableActive) {
        throw new Error(`Table ${tableName} failed to become active`);
      }
    } else {
      logger.error(`Error checking table ${tableName}:`, error);
      throw error;
    }
  }
}

/**
 * Creates a completed Delphi job for a conversation
 * @param conversationId The conversation ID (zid)
 * @param jobId Optional job ID (defaults to generated ID)
 * @returns The created job ID
 */
export async function createCompletedDelphiJob(
  conversationId: string,
  jobId?: string
): Promise<string> {
  const actualJobId = jobId || `test-job-${conversationId}-${Date.now()}`;

  const item = {
    job_id: actualJobId,
    conversation_id: conversationId.toString(),
    status: "COMPLETED",
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    job_type: "full_pipeline",
    priority: 1,
    worker_id: "test-worker",
    // Additional fields that might be expected
    input_data: {
      conversation_id: conversationId.toString(),
      math_tick: -1,
    },
    output_data: {
      topics_generated: 5,
      clusters_generated: 3,
      processing_time_ms: 1234,
    },
    metadata: {
      test: true,
      created_by: "integration-test",
    },
  };

  await docClient.send(
    new PutCommand({
      TableName: "Delphi_JobQueue",
      Item: item,
    })
  );

  logger.info(
    `Created completed Delphi job ${actualJobId} for conversation ${conversationId}`
  );

  return actualJobId;
}

/**
 * Deletes all jobs for a conversation
 * @param conversationId The conversation ID to clean up
 */
export async function cleanupDelphiJobs(conversationId: string): Promise<void> {
  try {
    // Query all jobs for this conversation
    const queryParams = {
      TableName: "Delphi_JobQueue",
      IndexName: "ConversationIndex",
      KeyConditionExpression: "conversation_id = :zid",
      ExpressionAttributeValues: {
        ":zid": conversationId.toString(),
      },
    };

    const result = await docClient.send(new QueryCommand(queryParams));

    if (result.Items && result.Items.length > 0) {
      // Delete each job
      for (const item of result.Items) {
        await docClient.send(
          new DeleteCommand({
            TableName: "Delphi_JobQueue",
            Key: {
              job_id: item.job_id,
            },
          })
        );
      }

      logger.info(
        `Cleaned up ${result.Items.length} Delphi jobs for conversation ${conversationId}`
      );
    }
  } catch (error) {
    logger.error(
      `Error cleaning up Delphi jobs for conversation ${conversationId}:`,
      error
    );
    // Don't throw - cleanup errors shouldn't fail tests
  }
}

/**
 * Creates a pending Delphi job for a conversation
 * @param conversationId The conversation ID (zid)
 * @returns The created job ID
 */
export async function createPendingDelphiJob(
  conversationId: string
): Promise<string> {
  const jobId = `test-pending-job-${conversationId}-${Date.now()}`;

  const item = {
    job_id: jobId,
    conversation_id: conversationId.toString(),
    status: "PENDING",
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    job_type: "full_pipeline",
    priority: 1,
    input_data: {
      conversation_id: conversationId.toString(),
      math_tick: -1,
    },
    metadata: {
      test: true,
      created_by: "integration-test",
    },
  };

  await docClient.send(
    new PutCommand({
      TableName: "Delphi_JobQueue",
      Item: item,
    })
  );

  logger.info(
    `Created pending Delphi job ${jobId} for conversation ${conversationId}`
  );

  return jobId;
}

/**
 * Creates a failed Delphi job for a conversation
 * @param conversationId The conversation ID (zid)
 * @returns The created job ID
 */
export async function createFailedDelphiJob(
  conversationId: string
): Promise<string> {
  const jobId = `test-failed-job-${conversationId}-${Date.now()}`;

  const item = {
    job_id: jobId,
    conversation_id: conversationId.toString(),
    status: "FAILED",
    created_at: new Date(Date.now() - 60000).toISOString(), // 1 minute ago
    updated_at: new Date().toISOString(),
    job_type: "full_pipeline",
    priority: 1,
    worker_id: "test-worker",
    error_message: "Test failure",
    input_data: {
      conversation_id: conversationId.toString(),
      math_tick: -1,
    },
    metadata: {
      test: true,
      created_by: "integration-test",
    },
  };

  await docClient.send(
    new PutCommand({
      TableName: "Delphi_JobQueue",
      Item: item,
    })
  );

  logger.info(
    `Created failed Delphi job ${jobId} for conversation ${conversationId}`
  );

  return jobId;
}

/**
 * Table names for Delphi topic-related tables
 */
export const DELPHI_TOPIC_NAMES_TABLE = "Delphi_CommentClustersLLMTopicNames";
export const DELPHI_COMMENT_HIERARCHICAL_TABLE =
  "Delphi_CommentHierarchicalClusterAssignments";

/**
 * Ensures the Delphi topic-related tables exist
 */
export async function ensureDelphiTopicTablesExist(): Promise<void> {
  // Create topic names table
  try {
    await dynamoClient.send(
      new DescribeTableCommand({ TableName: DELPHI_TOPIC_NAMES_TABLE })
    );
    logger.info(`Table ${DELPHI_TOPIC_NAMES_TABLE} already exists`);
  } catch (e: unknown) {
    const err = e as { name?: string; message?: string };
    if (err.name === "ResourceNotFoundException") {
      logger.info(`Creating table ${DELPHI_TOPIC_NAMES_TABLE}...`);
      const createParams = {
        TableName: DELPHI_TOPIC_NAMES_TABLE,
        BillingMode: "PAY_PER_REQUEST" as const,
        KeySchema: [
          { AttributeName: "conversation_id", KeyType: "HASH" as const },
          { AttributeName: "topic_key", KeyType: "RANGE" as const },
        ],
        AttributeDefinitions: [
          { AttributeName: "conversation_id", AttributeType: "S" as const },
          { AttributeName: "topic_key", AttributeType: "S" as const },
        ],
      };
      await dynamoClient.send(new CreateTableCommand(createParams));
      await new Promise((r) => setTimeout(r, 250));
    } else {
      logger.error(`Error checking topic names table: ${err.message}`);
      throw e;
    }
  }

  // Create hierarchical assignments table
  try {
    await dynamoClient.send(
      new DescribeTableCommand({
        TableName: DELPHI_COMMENT_HIERARCHICAL_TABLE,
      })
    );
    logger.info(`Table ${DELPHI_COMMENT_HIERARCHICAL_TABLE} already exists`);
  } catch (e: unknown) {
    const err = e as { name?: string; message?: string };
    if (err.name === "ResourceNotFoundException") {
      logger.info(`Creating table ${DELPHI_COMMENT_HIERARCHICAL_TABLE}...`);
      const createParams = {
        TableName: DELPHI_COMMENT_HIERARCHICAL_TABLE,
        BillingMode: "PAY_PER_REQUEST" as const,
        KeySchema: [
          { AttributeName: "conversation_id", KeyType: "HASH" as const },
          { AttributeName: "comment_id", KeyType: "RANGE" as const },
        ],
        AttributeDefinitions: [
          { AttributeName: "conversation_id", AttributeType: "S" as const },
          { AttributeName: "comment_id", AttributeType: "N" as const }, // comment_id is a number
        ],
      };
      await dynamoClient.send(new CreateTableCommand(createParams));
      await new Promise((r) => setTimeout(r, 250));
    } else {
      logger.error(`Error checking hierarchical table: ${err.message}`);
      throw e;
    }
  }
}

/**
 * Creates test data for Delphi topic clusters
 * @param zid Conversation ID
 * @param topicKey Topic key identifier
 * @param tids Array of comment IDs to assign to this cluster
 * @param layerId Hierarchical layer ID (0-4)
 * @param clusterId Cluster ID within the layer
 */
export async function createDelphiTopicCluster(
  zid: number,
  topicKey: string,
  tids: number[],
  layerId = 0,
  clusterId = 1
): Promise<void> {
  // Ensure tables exist
  await ensureDelphiTopicTablesExist();

  // First, put the topic name mapping
  const topicItem = {
    conversation_id: String(zid),
    topic_key: topicKey,
    layer_id: String(layerId), // Store as string
    cluster_id: String(clusterId), // Store as string
    topic_name: `Test Topic ${topicKey}`,
    model_name: "test-model",
    created_at: new Date().toISOString(),
  };

  logger.info(`Creating topic mapping for ${topicKey} in conversation ${zid}`);

  await docClient.send(
    new PutCommand({
      TableName: DELPHI_TOPIC_NAMES_TABLE,
      Item: topicItem,
    })
  );

  // Then, put the hierarchical cluster assignments for each comment
  for (const tid of tids) {
    const item: Record<string, unknown> = {
      conversation_id: String(zid),
      comment_id: tid, // Store as number since DynamoDB key is type N
      distance_to_centroid: 0.5,
      cluster_confidence: 0.9,
      is_outlier: false,
    };

    // Set the appropriate layer cluster ID based on layerId
    item[`layer${layerId}_cluster_id`] = clusterId; // Store as number

    // Set other layer cluster IDs to null or default values
    for (let i = 0; i <= 4; i++) {
      if (i !== layerId) {
        item[`layer${i}_cluster_id`] = null;
      }
    }

    await docClient.send(
      new PutCommand({
        TableName: DELPHI_COMMENT_HIERARCHICAL_TABLE,
        Item: item,
      })
    );
  }

  logger.info(
    `Created cluster assignments for ${tids.length} comments in topic ${topicKey}`
  );
}

/**
 * Cleans up Delphi topic data for a conversation
 * @param zid Conversation ID to clean up
 */
export async function cleanupDelphiTopicData(zid: number): Promise<void> {
  const conversationId = String(zid);

  try {
    // Clean up topic names
    const topicResult = await docClient.send(
      new QueryCommand({
        TableName: DELPHI_TOPIC_NAMES_TABLE,
        KeyConditionExpression: "conversation_id = :cid",
        ExpressionAttributeValues: {
          ":cid": conversationId,
        },
      })
    );

    if (topicResult.Items && topicResult.Items.length > 0) {
      for (const item of topicResult.Items) {
        await docClient.send(
          new DeleteCommand({
            TableName: DELPHI_TOPIC_NAMES_TABLE,
            Key: {
              conversation_id: conversationId,
              topic_key: item.topic_key,
            },
          })
        );
      }
      logger.info(
        `Cleaned up ${topicResult.Items.length} topic mappings for conversation ${zid}`
      );
    }

    // Clean up hierarchical assignments
    const hierarchicalResult = await docClient.send(
      new QueryCommand({
        TableName: DELPHI_COMMENT_HIERARCHICAL_TABLE,
        KeyConditionExpression: "conversation_id = :cid",
        ExpressionAttributeValues: {
          ":cid": conversationId,
        },
      })
    );

    if (hierarchicalResult.Items && hierarchicalResult.Items.length > 0) {
      for (const item of hierarchicalResult.Items) {
        await docClient.send(
          new DeleteCommand({
            TableName: DELPHI_COMMENT_HIERARCHICAL_TABLE,
            Key: {
              conversation_id: conversationId,
              comment_id: item.comment_id,
            },
          })
        );
      }
      logger.info(
        `Cleaned up ${hierarchicalResult.Items.length} cluster assignments for conversation ${zid}`
      );
    }
  } catch (error) {
    logger.error(
      `Error cleaning up Delphi topic data for conversation ${zid}:`,
      error
    );
    // Don't throw - cleanup errors shouldn't fail tests
  }
}
