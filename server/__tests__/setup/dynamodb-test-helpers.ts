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
          { AttributeName: "status", AttributeType: "S" },
          { AttributeName: "created_at", AttributeType: "S" },
          { AttributeName: "conversation_id", AttributeType: "S" },
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
