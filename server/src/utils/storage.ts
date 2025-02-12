/* eslint-disable no-console */
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  PutCommand,
  QueryCommand,
  DeleteCommand
} from "@aws-sdk/lib-dynamodb";

export default class DynamoStorageService {
  private client: DynamoDBClient;
  private tableName: string;
  private cacheDisabled: boolean;

  constructor(region: string, tableName: string, disableCache?: boolean) {
    const dynamoClient = new DynamoDBClient({ region });
    this.client = dynamoClient;
    this.tableName = tableName;
    this.cacheDisabled = disableCache || false;
  }

  async putItem(item: Record<string, unknown> | undefined) {
    const params = {
      TableName: this.tableName,
      Item: item,
    };
  
    const command = new PutCommand(params);
  
    try {
      const response = await this.client.send(command);
      return response;
    } catch (error) {
      console.error(error)
    }
  }

  async queryItemsByRidSectionModel(rid_section_model: string) {
    const params = {
      TableName: this.tableName,
      KeyConditionExpression: "rid_section_model = :rid_section_model",
      ExpressionAttributeValues: {
        ":rid_section_model": rid_section_model,
      },
    };
  
    const command = new QueryCommand(params);

    if (this.cacheDisabled) {
      return []
    }
  
    try {
      const data = await this.client.send(command);
      return data.Items;
    } catch (error) {
      console.error("Error querying items:", error);
    }
  }

  async deleteReportItem(rid_section_model: string, timestamp: string) {
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
      console.log("Item deleted successfully:", response);
      return response;
    } catch (error) {
      console.error("Error deleting item:", error);
    }
  }
}