#!/usr/bin/env node

/**
 * Script to check how many collective statements exist in DynamoDB
 */

import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, ScanCommand } from "@aws-sdk/lib-dynamodb";
import Config from "../src/config";

// Configure DynamoDB client
const dynamoDBConfig: any = {
  region: Config.AWS_REGION || "us-east-1",
};

if (Config.dynamoDbEndpoint) {
  dynamoDBConfig.endpoint = Config.dynamoDbEndpoint;
  dynamoDBConfig.credentials = {
    accessKeyId: "DUMMYIDEXAMPLE",
    secretAccessKey: "DUMMYEXAMPLEKEY",
  };
} else if (Config.AWS_ACCESS_KEY_ID && Config.AWS_SECRET_ACCESS_KEY) {
  dynamoDBConfig.credentials = {
    accessKeyId: Config.AWS_ACCESS_KEY_ID,
    secretAccessKey: Config.AWS_SECRET_ACCESS_KEY,
  };
}

const client = new DynamoDBClient(dynamoDBConfig);
const docClient = DynamoDBDocumentClient.from(client, {
  marshallOptions: {
    convertEmptyValues: true,
    removeUndefinedValues: true,
  },
});

async function checkCollectiveStatements() {
  try {
    const params = {
      TableName: "Delphi_CollectiveStatement"
    };

    let count = 0;
    let lastEvaluatedKey;

    do {
      const command: any = {
        ...params,
        ExclusiveStartKey: lastEvaluatedKey
      };
      
      const data = await docClient.send(new ScanCommand(command));
      if (data.Items) {
        count += data.Items.length;
      }
      lastEvaluatedKey = data.LastEvaluatedKey;
    } while (lastEvaluatedKey);

    console.log(`Total collective statements in database: ${count}`);

  } catch (err) {
    console.error("Error checking collective statements:", err);
  }
}

// Run the check
checkCollectiveStatements();