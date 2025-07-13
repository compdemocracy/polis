import {
  DeleteItemCommand,
  DescribeTableCommand,
  DynamoDBClient,
  ScanCommandInput,
} from "@aws-sdk/client-dynamodb";
import {
  PutCommand,
  QueryCommand,
  DeleteCommand,
  ScanCommand,
} from "@aws-sdk/lib-dynamodb";
import config from "../config";
import logger from "./logger";

type Credentials = {
  accessKeyId: string;
  secretAccessKey: string;
};

type ClientConfig = {
  region: string;
  endpoint?: string;
  credentials: Credentials;
};

export interface StorageError {
  name: string;
  message: string;
  code?: string;
  statusCode?: number;
  isTableNotFound?: boolean;
  isCredentialsError?: boolean;
  isNetworkError?: boolean;
  isPermissionError?: boolean;
}

export default class DynamoStorageService {
  private client: DynamoDBClient;
  private tableName: string;
  private cacheDisabled: boolean;

  constructor(tableName: string, disableCache?: boolean) {
    const credentials: Credentials = {
      accessKeyId: config.awsAccessKeyId,
      secretAccessKey: config.awsSecretAccessKey,
    };
    const clientConfig: ClientConfig = {
      region: config.awsRegion,
      credentials,
    };

    if (config.dynamoDbEndpoint) {
      clientConfig.endpoint = config.dynamoDbEndpoint;
    }

    this.client = new DynamoDBClient(clientConfig);
    this.tableName = tableName;
    this.cacheDisabled = disableCache || false;
  }

  /**
   * Creates a standardized error object with helpful information
   */
  private createStorageError(error: any): StorageError {
    const storageError: StorageError = {
      name: error.name || "DynamoDBError",
      message: error.message || "Unknown DynamoDB error",
      code: error.code,
      statusCode: error.$metadata?.httpStatusCode,
    };

    // Categorize error types for easier handling
    if (error.name === "ResourceNotFoundException") {
      storageError.isTableNotFound = true;
    } else if (
      error.name === "CredentialsProviderError" ||
      error.name === "UnrecognizedClientException"
    ) {
      storageError.isCredentialsError = true;
    } else if (error.name === "NetworkingError") {
      storageError.isNetworkError = true;
    } else if (error.name === "AccessDeniedException") {
      storageError.isPermissionError = true;
    }

    return storageError;
  }

  /**
   * Logs detailed error information for debugging
   */
  private logError(
    operation: string,
    error: StorageError,
    context?: any
  ): void {
    logger.error(`DynamoDB ${operation} error:`, {
      name: error.name,
      message: error.message,
      code: error.code,
      statusCode: error.statusCode,
      tableName: this.tableName,
      context,
    });

    // Log helpful hints for common errors
    if (error.isTableNotFound) {
      logger.warn(
        `Table "${this.tableName}" does not exist. This may indicate the Delphi pipeline hasn't been run yet or the table needs to be created.`
      );
    } else if (error.isCredentialsError) {
      logger.error(
        "AWS credential issue - check AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY environment variables"
      );
    } else if (error.isNetworkError) {
      logger.error(
        `Network error connecting to DynamoDB endpoint: ${
          config.dynamoDbEndpoint || "default AWS endpoint"
        }`
      );
    } else if (error.isPermissionError) {
      logger.error(
        "AWS permissions issue - credentials do not have access to this DynamoDB table"
      );
    }
  }

  /**
   * Checks if the table exists - now returns a result instead of throwing
   */
  async initTable(): Promise<{ success: boolean; error?: StorageError }> {
    try {
      const describeCmd = new DescribeTableCommand({
        TableName: this.tableName,
      });
      await this.client.send(describeCmd);
      logger.info(`Table "${this.tableName}" exists and is accessible.`);
      return { success: true };
    } catch (error: any) {
      const storageError = this.createStorageError(error);
      this.logError("initTable", storageError);
      return { success: false, error: storageError };
    }
  }

  async putItem(
    item: Record<string, unknown> | undefined
  ): Promise<{ success: boolean; error?: StorageError; data?: any }> {
    if (!item) {
      return {
        success: false,
        error: { name: "ValidationError", message: "Item cannot be undefined" },
      };
    }

    const params = {
      TableName: this.tableName,
      Item: item,
    };

    const command = new PutCommand(params);

    try {
      const response = await this.client.send(command);
      logger.debug(`Item stored successfully in ${this.tableName}:`, response);
      return { success: true, data: response };
    } catch (error: any) {
      const storageError = this.createStorageError(error);
      this.logError("putItem", storageError, { item });
      return { success: false, error: storageError };
    }
  }

  async queryItemsByRidSectionModel(
    rid_section_model: string
  ): Promise<{ success: boolean; error?: StorageError; data?: any[] }> {
    if (this.cacheDisabled) {
      return { success: true, data: [] };
    }

    const params = {
      TableName: this.tableName,
      KeyConditionExpression: "rid_section_model = :rid_section_model",
      ExpressionAttributeValues: {
        ":rid_section_model": rid_section_model,
      },
    };

    const command = new QueryCommand(params);

    try {
      const response = await this.client.send(command);
      return { success: true, data: response.Items };
    } catch (error: any) {
      const storageError = this.createStorageError(error);
      this.logError("queryItemsByRidSectionModel", storageError, {
        rid_section_model,
      });
      return { success: false, error: storageError };
    }
  }

  async deleteReportItem(
    rid_section_model: string,
    timestamp: string
  ): Promise<{ success: boolean; error?: StorageError; data?: any }> {
    const params = {
      TableName: this.tableName,
      Key: {
        rid_section_model: rid_section_model,
        timestamp: timestamp,
      },
    };

    const command = new DeleteCommand(params);

    try {
      const response = await this.client.send(command);
      logger.info("Item deleted successfully:", response);
      return { success: true, data: response };
    } catch (error: any) {
      const storageError = this.createStorageError(error);
      this.logError("deleteReportItem", storageError, {
        rid_section_model,
        timestamp,
      });
      return { success: false, error: storageError };
    }
  }

  async deleteAllByReportID(reportIdPrefix: string): Promise<{
    success: boolean;
    error?: StorageError;
    deletedCount?: number;
  }> {
    if (!reportIdPrefix) {
      const error: StorageError = {
        name: "ValidationError",
        message: "reportIdPrefix cannot be empty or null.",
      };
      logger.error(error.message);
      return { success: false, error };
    }

    let lastEvaluatedKey: Record<string, any> | undefined = undefined;
    let totalDeletedCount = 0;

    do {
      const scanParams: ScanCommandInput = {
        TableName: this.tableName,
        FilterExpression: "begins_with(rid_section_model, :reportIdPrefix)",
        ExpressionAttributeValues: {
          // @ts-expect-error dynamo
          ":reportIdPrefix": String(reportIdPrefix),
        },
        ExclusiveStartKey: lastEvaluatedKey,
      };

      const scanCommand = new ScanCommand(scanParams);
      let itemsToDelete;

      try {
        const scanResponse = await this.client.send(scanCommand);
        itemsToDelete = scanResponse.Items;
        lastEvaluatedKey = scanResponse.LastEvaluatedKey;

        if (!itemsToDelete || itemsToDelete.length === 0) {
          if (!lastEvaluatedKey) {
            logger.debug(
              `No items found with report ID prefix: ${reportIdPrefix}`
            );
          }
          break;
        }
        logger.debug(
          `Found ${itemsToDelete.length} items to delete in this batch.`
        );
      } catch (scanError) {
        const storageError = this.createStorageError(scanError);
        this.logError("deleteAllByReportID:scan", storageError, {
          reportIdPrefix,
        });
        return { success: false, error: storageError };
      }

      const deletePromises = itemsToDelete.map(async (item) => {
        const rid_section_model = item.rid_section_model;
        const timestamp = item.timestamp;

        const deleteParams = {
          TableName: this.tableName,
          Key: {
            rid_section_model: { S: rid_section_model },
            timestamp: { S: timestamp },
          },
        };

        const deleteItemCommand = new DeleteItemCommand(deleteParams);

        try {
          await this.client.send(deleteItemCommand);
          logger.debug(
            `Deleted item with rid_section_model: ${rid_section_model}${
              timestamp ? `, timestamp: ${timestamp}` : ""
            }`
          );
          totalDeletedCount++;
        } catch (deleteError) {
          const storageError = this.createStorageError(deleteError);
          this.logError("deleteAllByReportID:delete", storageError, {
            rid_section_model,
            timestamp,
          });
          // Continue with other deletions even if one fails
        }
      });

      await Promise.all(deletePromises);
    } while (lastEvaluatedKey);

    return { success: true, deletedCount: totalDeletedCount };
  }

  async getAllByReportID(
    reportIdPrefix: string
  ): Promise<{ success: boolean; error?: StorageError; data?: any[] }> {
    if (!reportIdPrefix) {
      const error: StorageError = {
        name: "ValidationError",
        message: "reportIdPrefix cannot be empty or null.",
      };
      logger.error(error.message);
      return { success: false, error };
    }

    const scanParams = {
      TableName: this.tableName,
      FilterExpression: "begins_with(rid_section_model, :reportIdPrefix)",
      ExpressionAttributeValues: {
        ":reportIdPrefix": String(reportIdPrefix),
      },
    };

    const scanCommand = new ScanCommand(scanParams);

    try {
      const scanResponse = await this.client.send(scanCommand);
      const items = scanResponse.Items;

      if (!items || items.length === 0) {
        logger.debug(`No items found with report ID prefix: ${reportIdPrefix}`);
        return { success: true, data: [] };
      }

      logger.debug(
        `Found ${items.length} items with report ID prefix: ${reportIdPrefix}`
      );
      return { success: true, data: items };
    } catch (scanError) {
      const storageError = this.createStorageError(scanError);
      this.logError("getAllByReportID", storageError, { reportIdPrefix });
      return { success: false, error: storageError };
    }
  }
}
