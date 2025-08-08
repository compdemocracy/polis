#!/usr/bin/env node

/**
 * One-time script to clear all collective statements from DynamoDB
 * Run with: npx ts-node scripts/clear-collective-statements.ts
 */

import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, ScanCommand, DeleteCommand } from "@aws-sdk/lib-dynamodb";
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

async function clearCollectiveStatements() {
  console.log("Starting to clear collective statements...");
  
  try {
    // First, scan to get all items
    const params = {
      TableName: "Delphi_CollectiveStatement"
    };

    const allItems: any[] = [];
    let lastEvaluatedKey;

    // Scan all items
    do {
      const command: any = {
        ...params,
        ExclusiveStartKey: lastEvaluatedKey
      };
      
      const data = await docClient.send(new ScanCommand(command));
      if (data.Items) {
        allItems.push(...data.Items);
      }
      lastEvaluatedKey = data.LastEvaluatedKey;
    } while (lastEvaluatedKey);

    console.log(`Found ${allItems.length} collective statements to delete`);

    if (allItems.length === 0) {
      console.log("No items to delete. Table is already empty.");
      return;
    }

    // Confirm before deleting
    console.log("\nItems to delete:");
    allItems.forEach(item => {
      console.log(`  - ${item.zid_topic_jobid} (Topic: ${item.topic_name}, Created: ${item.created_at})`);
    });

    console.log("\nPress Ctrl+C within 5 seconds to cancel...");
    await new Promise(resolve => setTimeout(resolve, 5000));

    // Delete each item
    console.log("\nDeleting items...");
    let deletedCount = 0;
    let errors = 0;

    for (const item of allItems) {
      try {
        await docClient.send(new DeleteCommand({
          TableName: "Delphi_CollectiveStatement",
          Key: {
            zid_topic_jobid: item.zid_topic_jobid
          }
        }));
        deletedCount++;
        process.stdout.write(`\rDeleted ${deletedCount}/${allItems.length} items...`);
      } catch (err) {
        errors++;
        console.error(`\nError deleting item ${item.zid_topic_jobid}:`, err);
      }
    }

    console.log(`\n\nCompleted! Deleted ${deletedCount} items with ${errors} errors.`);

  } catch (err) {
    console.error("Fatal error:", err);
    process.exit(1);
  }
}

// Run the script
clearCollectiveStatements()
  .then(() => {
    console.log("Script finished successfully");
    process.exit(0);
  })
  .catch(err => {
    console.error("Script failed:", err);
    process.exit(1);
  });