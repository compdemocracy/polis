import { Request, Response } from "express";
import logger from "../utils/logger";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, QueryCommand } from "@aws-sdk/lib-dynamodb";
import { getZidFromReport } from "../utils/parameter";
import Config from "../config";
import { getClusterAssignments } from "../utils/commentClusters";

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

interface TopicMetrics {
  comment_count: number;
  comment_tids: number[]; // List of comment IDs for client-side calculations
}

/**
 * Return basic topic info - all calculations done client-side
 */
async function calculateTopicMetrics(
  zid: number,
  commentIds: number[]
): Promise<TopicMetrics> {
  return {
    comment_count: commentIds.length,
    comment_tids: commentIds,
  };
}

/**
 * Handler for /api/v3/topicStats endpoint
 */
export async function handle_GET_topicStats(req: Request, res: Response) {
  logger.info("TopicStats API request received");

  const report_id = req.query.report_id as string;
  if (!report_id) {
    return res.status(400).json({
      status: "error",
      message: "report_id is required",
    });
  }

  try {
    const zid = await getZidFromReport(report_id);
    if (!zid) {
      return res.status(404).json({
        status: "error",
        message: "Could not find conversation for report_id",
        report_id: report_id,
      });
    }

    const conversation_id = zid.toString();
    logger.info(`Fetching topic stats for conversation_id: ${conversation_id}`);

    // Get all topics first
    const topicsTable = "Delphi_CommentClustersLLMTopicNames";
    const topicsParams = {
      TableName: topicsTable,
      KeyConditionExpression: "conversation_id = :cid",
      ExpressionAttributeValues: {
        ":cid": conversation_id,
      },
    };

    const topicsData = await docClient.send(new QueryCommand(topicsParams));
    if (!topicsData.Items || topicsData.Items.length === 0) {
      return res.json({
        status: "success",
        message: "No topics found for this conversation",
        stats: {},
      });
    }

    // Create mapping of layer_cluster to topic
    const clusterToTopic: Record<string, any> = {};
    topicsData.Items.forEach((topic) => {
      const topicKey = topic.topic_key;

      // Handle both formats:
      // Old format: 'layer0_5' -> layer=0, cluster=5
      // New format: 'uuid#0#5' -> layer=0, cluster=5

      if (topicKey.includes("#")) {
        // New format with job UUID
        const parts = topicKey.split("#");
        if (parts.length >= 3) {
          const layer = parseInt(parts[1]);
          const cluster = parseInt(parts[2]);
          clusterToTopic[`${layer}_${cluster}`] = topic;
        }
      } else if (topicKey.includes("_")) {
        // Old format
        const parts = topicKey.split("_");
        if (parts.length >= 2 && parts[0].startsWith("layer")) {
          const layer = parseInt(parts[0].replace("layer", ""));
          const cluster = parseInt(parts[1]);
          clusterToTopic[`${layer}_${cluster}`] = topic;
        }
      }
    });

    // Get all cluster assignments using centralized utility
    const clusterAssignmentsMap = await getClusterAssignments(zid);

    if (clusterAssignmentsMap.size === 0) {
      return res.json({
        status: "success",
        message: "No comment assignments found",
        stats: {},
      });
    }

    // Group comments by topic_key
    const commentsByTopic: Record<string, Set<number>> = {};

    // Initialize all topics
    topicsData.Items.forEach((topic) => {
      commentsByTopic[topic.topic_key] = new Set<number>();
    });

    // Map comments to topics based on cluster assignments
    for (const [commentId, assignment] of clusterAssignmentsMap.entries()) {
      // Check each layer (0-4)
      for (let layer = 0; layer <= 4; layer++) {
        const clusterIdKey =
          `layer${layer}_cluster_id` as keyof typeof assignment;
        const clusterId = assignment[clusterIdKey];
        if (clusterId !== undefined && clusterId !== -1) {
          const topicLookupKey = `${layer}_${clusterId}`;
          const topic = clusterToTopic[topicLookupKey];
          if (topic) {
            commentsByTopic[topic.topic_key].add(commentId);
          }
        }
      }
    }

    // Calculate metrics for each topic
    const topicStats: Record<string, TopicMetrics> = {};

    for (const [topicKey, commentIdSet] of Object.entries(commentsByTopic)) {
      const commentIds = Array.from(commentIdSet);
      const metrics = await calculateTopicMetrics(zid, commentIds);
      topicStats[topicKey] = metrics;
    }

    return res.json({
      status: "success",
      message: "Topic statistics retrieved successfully",
      report_id,
      stats: topicStats,
      total_topics: Object.keys(topicStats).length,
    });
  } catch (err: any) {
    logger.error(`Error in handle_GET_topicStats: ${err.message}`);
    logger.error(`Error stack: ${err.stack}`);

    return res.status(500).json({
      status: "error",
      message: "Error retrieving topic statistics",
      error_details: {
        name: err.name,
        message: err.message,
      },
      report_id,
    });
  }
}
