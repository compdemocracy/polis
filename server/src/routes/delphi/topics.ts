import { Request, Response } from "express";
import logger from "../../utils/logger";
import { DynamoDBClient, ListTablesCommand } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, QueryCommand } from "@aws-sdk/lib-dynamodb";
import { getZidFromReport } from "../../utils/parameter";
import Config from "../../config";

// Configure DynamoDB based on environment
const dynamoDBConfig: any = {
  region: Config.AWS_REGION || "us-east-1",
};

// Debug logging
logger.info(`Config.dynamoDbEndpoint value: ${Config.dynamoDbEndpoint}`);
logger.info(
  // eslint-disable-next-line no-restricted-properties
  `process.env.DYNAMODB_ENDPOINT value: ${process.env.DYNAMODB_ENDPOINT}`
);

// If DYNAMODB_ENDPOINT is set, we're using local DynamoDB
if (Config.dynamoDbEndpoint) {
  dynamoDBConfig.endpoint = Config.dynamoDbEndpoint;
  // For local DynamoDB, use dummy credentials
  dynamoDBConfig.credentials = {
    accessKeyId: "DUMMYIDEXAMPLE",
    secretAccessKey: "DUMMYEXAMPLEKEY",
  };
  logger.info(`Using local DynamoDB at endpoint: ${Config.dynamoDbEndpoint}`);
} else {
  // For production, use real AWS credentials
  if (Config.AWS_ACCESS_KEY_ID && Config.AWS_SECRET_ACCESS_KEY) {
    dynamoDBConfig.credentials = {
      accessKeyId: Config.AWS_ACCESS_KEY_ID,
      secretAccessKey: Config.AWS_SECRET_ACCESS_KEY,
    };
    logger.info(`Using production DynamoDB with AWS credentials`);
  } else {
    // Let the SDK use default credential provider chain (IAM role, etc.)
    logger.info(`Using default AWS credential provider chain`);
  }
}

// Log connection config for debugging
logger.info(`DynamoDB Config:
  Region: ${dynamoDBConfig.region}
  Endpoint: ${dynamoDBConfig.endpoint || "Default AWS endpoint"}
  AWS_ACCESS_KEY_ID: ${Config.AWS_ACCESS_KEY_ID ? "Set" : "Not set"}
  AWS_SECRET_ACCESS_KEY: ${Config.AWS_SECRET_ACCESS_KEY ? "Set" : "Not set"}
  DYNAMODB_ENDPOINT: ${Config.dynamoDbEndpoint || "Not set"}
`);

// Create DynamoDB clients
const client = new DynamoDBClient(dynamoDBConfig);
const docClient = DynamoDBDocumentClient.from(client, {
  marshallOptions: {
    convertEmptyValues: true,
    removeUndefinedValues: true,
  },
});

/**
 * Handler for Delphi API route that retrieves LLM topic names from DynamoDB
 */
export function handle_GET_delphi(req: Request, res: Response) {
  logger.info("Delphi API request received");

  // Get report_id from request
  const report_id = req.query.report_id as string;
  const requested_job_id = req.query.job_id as string | undefined; // Optional job_id to filter by

  if (!report_id) {
    return res.json({
      status: "error",
      message: "report_id is required",
    });
  }

  // Extract zid from report_id - we need this to query DynamoDB
  getZidFromReport(report_id)
    .then((zid) => {
      if (!zid) {
        return res.json({
          status: "error",
          message: "Could not find conversation for report_id",
          report_id: report_id,
        });
      }

      const conversation_id = zid.toString();
      logger.info(
        `Fetching Delphi LLM topics for conversation_id: ${conversation_id}`
      );

      // Table name for LLM topic names
      const tableName = "Delphi_CommentClustersLLMTopicNames";

      // First, try to list tables to see if our table exists
      try {
        // Create a command to list all tables
        const listTablesCommand = new ListTablesCommand({});

        // Log that we're checking tables
        logger.info(`Checking DynamoDB tables...`);

        // Execute the command and handle results
        client
          .send(listTablesCommand)
          .then((tableData) => {
            // Make sure TableNames is defined
            const tableNames = tableData.TableNames || [];
            logger.info(
              `Found ${tableNames.length} DynamoDB tables: ${JSON.stringify(
                tableNames
              )}`
            );

            // Check if our table exists
            const tableExists = tableNames.includes(tableName);
            logger.info(`Table ${tableName} exists: ${tableExists}`);

            if (!tableExists) {
              // If table doesn't exist, return a helpful message
              // Also provide info on how to create the table
              return res.json({
                status: "success",
                message: `Table ${tableName} not found in DynamoDB.`,
                hint: "The table may need to be created by running the Delphi pipeline",
                report_id: report_id,
                available_tables: tableNames,
                topics: {},
              });
            }

            // If we get here, the table exists, proceed with query
            proceedWithQuery();
          })
          .catch((err) => {
            logger.error(`Error listing DynamoDB tables: ${err.message}`);
            logger.error(`Error type: ${err.name}`);
            if (err.code === "UnrecognizedClientException") {
              logger.error(
                "This error usually indicates an authentication issue with DynamoDB"
              );
              logger.error("Check AWS credentials and region settings");
            } else if (err.name === "NetworkingError") {
              logger.error(
                `Cannot connect to DynamoDB endpoint: ${dynamoDBConfig.endpoint}`
              );
              logger.error(
                "Check if the DynamoDB service is running and accessible from the server container"
              );
              logger.error(
                "Consider testing with: curl " + dynamoDBConfig.endpoint
              );
            }

            // If we can't list tables, we should still try the query
            // It might be a permissions issue where we can query but not list
            logger.info("Proceeding with query anyway...");
            proceedWithQuery();
          });
      } catch (err) {
        // Something went wrong with the setup
        const error = err as Error;
        logger.error(`Error setting up table list: ${error.message}`);
        logger.error(`Error stack: ${error.stack}`);
        logger.info("Proceeding with query anyway...");
        proceedWithQuery();
      }

      // Function to execute the actual query
      function proceedWithQuery() {
        // Query parameters to get LLM topic names for the conversation
        const params = {
          TableName: tableName,
          KeyConditionExpression: "conversation_id = :cid",
          ExpressionAttributeValues: {
            ":cid": conversation_id,
          },
        };

        // Log that we're executing the query
        logger.info(`Executing DynamoDB query: ${JSON.stringify(params)}`);

        // Query DynamoDB
        docClient
          .send(new QueryCommand(params))
          .then((data) => {
            // Early return if no items found
            if (!data.Items || data.Items.length === 0) {
              return res.json({
                status: "success",
                message: "No LLM topics found for this conversation",
                report_id: report_id,
                topics: {},
              });
            }

            // Process results - organize topics by run, then by layer, then by cluster
            // Group by creation timestamp and model to identify different runs
            const items = data.Items;
            let filteredItems = items;

            // If a specific job_id is requested, filter items by it
            // The job_id is the first part of the topic_key
            if (requested_job_id) {
              logger.info(`Filtering topics for job_id: ${requested_job_id}`);
              filteredItems = items.filter((item) => {
                const topicKey = (item.topic_key as string) || "";
                return topicKey.startsWith(`${requested_job_id}#`);
              });
              logger.info(
                `Found ${filteredItems.length} items matching job_id: ${requested_job_id}`
              );
            }

            // Group by job_id (extracted from topic_key)
            const runGroups: Record<string, any[]> = {}; // Key is job_id

            filteredItems.forEach((item) => {
              const createdAt = item.created_at || "";
              const topicKey = (item.topic_key as string) || "";

              // Extract job_id from topic_key (e.g., "job123#0#5")
              const jobKeyParts = topicKey.split("#");
              const item_job_id =
                jobKeyParts.length > 0
                  ? jobKeyParts[0]
                  : `unknown_job_${createdAt.substring(0, 10)}`;

              if (!runGroups[item_job_id]) {
                runGroups[item_job_id] = [];
              }

              runGroups[item_job_id].push(item);
            });

            // Now organize each run into layers and clusters
            const allRuns: Record<string, any> = {};

            Object.entries(runGroups).forEach(([runKey, runItems]) => {
              // runKey is now job_id
              const topicsByLayer: Record<string, Record<string, any>> = {};

              // Sort items within the run by layer_id and then cluster_id for consistent ordering
              runItems.sort((a, b) => {
                const layerA = parseInt(a.layer_id || "0");
                const layerB = parseInt(b.layer_id || "0");
                if (layerA !== layerB) return layerA - layerB;
                const clusterA = parseInt(a.cluster_id || "0");
                const clusterB = parseInt(b.cluster_id || "0");
                return clusterA - clusterB;
              });

              // Process each item in this run
              runItems.forEach((item) => {
                const layerId = item.layer_id;
                const clusterId = item.cluster_id;

                // Initialize layer if it doesn't exist
                if (!topicsByLayer[layerId]) {
                  topicsByLayer[layerId] = {};
                }

                // Add topic to its layer
                topicsByLayer[layerId][clusterId] = {
                  topic_name: item.topic_name,
                  model_name: item.model_name,
                  created_at: item.created_at,
                  topic_key: item.topic_key,
                };
              });

              // Get sample data to represent the run
              const sampleItem = runItems[0];

              // Add run with metadata
              allRuns[runKey] = {
                job_id: runKey, // runKey is the job_id
                model_name: sampleItem.model_name,
                created_at: sampleItem.created_at, // Keep full timestamp for sorting
                topics_by_layer: topicsByLayer,
                item_count: runItems.length,
              };
            });

            // Return all runs, with the most recent runs first
            const sortedRuns = Object.entries(allRuns)
              .sort(([, runA], [, runB]) => {
                // Sort by created_at (full timestamp) in descending order (newest first)
                const dateA = runA.created_at || "";
                const dateB = runB.created_at || "";
                return dateB.localeCompare(dateA);
              })
              .reduce((acc, [key, value]) => {
                acc[key] = value;
                return acc;
              }, {} as Record<string, any>);

            // Return the results
            return res.json({
              status: "success",
              message: "LLM topics retrieved successfully",
              report_id: report_id,
              runs: sortedRuns,
            });
          })
          .catch((err) => {
            // Check if this is a "table not found" error
            if (err.name === "ResourceNotFoundException") {
              logger.warn(
                `DynamoDB table not found: Delphi_CommentClustersLLMTopicNames`
              );
              return res.json({
                status: "success",
                message: "Delphi topic service not available yet",
                hint: "The table may need to be created by running the Delphi pipeline",
                report_id: report_id,
                topics: {},
              });
            }

            // Log detailed error information
            logger.error(`Error querying DynamoDB: ${err.message}`);
            logger.error(`Error type: ${err.name}`);
            logger.error(`Error code: ${err.$metadata?.httpStatusCode}`);

            // Format a helpful message based on the error type
            let helpMessage = "";

            // Check credentials error
            if (err.name === "CredentialsProviderError") {
              logger.error(
                "AWS credential issue - check environment variables"
              );
              helpMessage =
                "AWS credential issue - check AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY environment variables";
            }

            // Check connection error
            if (err.name === "NetworkingError") {
              logger.error(
                `Network error connecting to DynamoDB endpoint: ${
                  dynamoDBConfig.endpoint || "default"
                }`
              );
              helpMessage = `Network error connecting to DynamoDB at ${
                dynamoDBConfig.endpoint || "default"
              } - check if DynamoDB service is running and accessible`;
            }

            // Check permissions error
            if (err.name === "AccessDeniedException") {
              logger.error(
                "AWS permissions issue - credentials do not have access to this DynamoDB table"
              );
              helpMessage =
                "AWS permissions issue - credentials do not have access to this DynamoDB table";
            }

            // If validation error
            if (err.name === "ValidationException") {
              logger.error(`DynamoDB validation error: ${err.message}`);
              helpMessage = `DynamoDB validation error: ${err.message} - check table schema or partition key`;
            }

            // Try to log more details if available
            try {
              logger.error(JSON.stringify(err, null, 2));
            } catch (e) {
              logger.error("Could not stringify error object");
            }

            return res.json({
              status: "success", // Use success to avoid frontend errors
              message: "Error querying DynamoDB",
              error: err.message,
              error_type: err.name,
              help: helpMessage,
              report_id: report_id,
              topics: {}, // Return empty topics to avoid client-side errors
            });
          });
      }
    })
    .catch((err) => {
      logger.error(`Error in delphi endpoint: ${err}`);
      return res.json({
        status: "error",
        message: "Error processing request",
        error: err.message,
        report_id: report_id,
      });
    });
}
