import { Request, Response } from "express";
import logger from "../../utils/logger";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, PutCommand, GetCommand, UpdateCommand, DeleteCommand } from "@aws-sdk/lib-dynamodb";
import Config from "../../config";
import { queryP as pgQueryP } from "../../db/pg-query";
import Conversation from "../../conversation";
import { getPidPromise } from "../../user";

// DynamoDB configuration (reuse pattern from other Delphi routes)
const dynamoDBConfig: any = {
  region: Config.AWS_REGION || "us-east-1",
};

if (Config.dynamoDbEndpoint) {
  dynamoDBConfig.endpoint = Config.dynamoDbEndpoint;
  dynamoDBConfig.credentials = {
    accessKeyId: "DUMMYIDEXAMPLE",
    secretAccessKey: "DUMMYEXAMPLEKEY",
  };
} else {
  if (Config.AWS_ACCESS_KEY_ID && Config.AWS_SECRET_ACCESS_KEY) {
    dynamoDBConfig.credentials = {
      accessKeyId: Config.AWS_ACCESS_KEY_ID,
      secretAccessKey: Config.AWS_SECRET_ACCESS_KEY,
    };
  }
}

const client = new DynamoDBClient(dynamoDBConfig);
const docClient = DynamoDBDocumentClient.from(client, {
  marshallOptions: {
    convertEmptyValues: true,
    removeUndefinedValues: true,
  },
});

const TABLE_NAME = "Delphi_TopicAgendaSelections";

/**
 * Get the current Delphi job ID for a conversation
 */
async function getCurrentDelphiJobId(zid: string): Promise<string | null> {
  try {
    const query = `
      SELECT job_id 
      FROM delphi_jobs 
      WHERE conversation_id = $1 
        AND status = 'completed' 
      ORDER BY created_at DESC 
      LIMIT 1
    `;
    const result = await pgQueryP(query, [zid]) as { rows: Array<{ job_id: string }> };
    return result.rows.length > 0 ? result.rows[0].job_id : null;
  } catch (error) {
    logger.error("Error getting current Delphi job ID", error);
    return null;
  }
}

/**
 * POST /api/v3/topicAgenda/selections
 * Save topic agenda selections for a user
 */
export async function handle_POST_topicAgenda_selections(req: Request & { user?: any }, res: Response) {
  try {
    const { conversation_id, selections } = req.body;

    if (!conversation_id || !selections) {
      return res.status(400).json({
        status: "error",
        message: "conversation_id and selections are required",
      });
    }

    if (!req.user || !req.user.uid) {
      return res.status(401).json({
        status: "error",
        message: "Authentication required",
      });
    }

    // Convert conversation_id to zid
    const zid = await Conversation.getZidFromConversationId(conversation_id);
    const zidStr = zid.toString();

    // Get participant ID
    const pid = await getPidPromise(zidStr, req.user.uid);
    const pidStr = pid.toString();

    // Get current Delphi job ID
    const jobId = await getCurrentDelphiJobId(zidStr);

    // Prepare DynamoDB item
    const item = {
      conversation_id: zidStr,
      participant_id: pidStr,
      archetypal_selections: selections,
      metadata: {
        job_id: jobId,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
        version: 1,
        total_selections: selections.length,
      },
    };

    // Save to DynamoDB
    const putParams = {
      TableName: TABLE_NAME,
      Item: item,
    };

    await docClient.send(new PutCommand(putParams));

    logger.info(`Saved topic agenda selections for user ${pidStr} in conversation ${zidStr}`);

    res.json({
      status: "success",
      message: "Topic agenda selections saved successfully",
      data: {
        conversation_id: zidStr,
        participant_id: pidStr,
        selections_count: selections.length,
        job_id: jobId,
      },
    });
  } catch (error) {
    logger.error("Error saving topic agenda selections", error);
    res.status(500).json({
      status: "error",
      message: "Failed to save topic agenda selections",
    });
  }
}

/**
 * GET /api/v3/topicAgenda/selections
 * Retrieve topic agenda selections for a user
 */
export async function handle_GET_topicAgenda_selections(req: Request & { user?: any }, res: Response) {
  try {
    const conversation_id = req.query.conversation_id as string;

    if (!conversation_id) {
      return res.status(400).json({
        status: "error",
        message: "conversation_id is required",
      });
    }

    if (!req.user || !req.user.uid) {
      return res.status(401).json({
        status: "error",
        message: "Authentication required",
      });
    }

    // Convert conversation_id to zid
    const zid = await Conversation.getZidFromConversationId(conversation_id);
    const zidStr = zid.toString();

    // Get participant ID
    const pid = await getPidPromise(zidStr, req.user.uid);
    const pidStr = pid.toString();

    // Retrieve from DynamoDB
    const getParams = {
      TableName: TABLE_NAME,
      Key: {
        conversation_id: zidStr,
        participant_id: pidStr,
      },
    };

    const result = await docClient.send(new GetCommand(getParams));

    if (!result.Item) {
      return res.json({
        status: "success",
        message: "No selections found",
        data: null,
      });
    }

    logger.info(`Retrieved topic agenda selections for user ${pidStr} in conversation ${zidStr}`);

    res.json({
      status: "success",
      data: result.Item,
    });
  } catch (error) {
    logger.error("Error retrieving topic agenda selections", error);
    res.status(500).json({
      status: "error",
      message: "Failed to retrieve topic agenda selections",
    });
  }
}

/**
 * PUT /api/v3/topicAgenda/selections
 * Update topic agenda selections for a user
 */
export async function handle_PUT_topicAgenda_selections(req: Request & { user?: any }, res: Response) {
  try {
    const { conversation_id, selections } = req.body;

    if (!conversation_id || !selections) {
      return res.status(400).json({
        status: "error",
        message: "conversation_id and selections are required",
      });
    }

    if (!req.user || !req.user.uid) {
      return res.status(401).json({
        status: "error",
        message: "Authentication required",
      });
    }

    // Convert conversation_id to zid
    const zid = await Conversation.getZidFromConversationId(conversation_id);
    const zidStr = zid.toString();

    // Get participant ID
    const pid = await getPidPromise(zidStr, req.user.uid);
    const pidStr = pid.toString();

    // Get current Delphi job ID
    const jobId = await getCurrentDelphiJobId(zidStr);

    // Update in DynamoDB
    const updateParams = {
      TableName: TABLE_NAME,
      Key: {
        conversation_id: zidStr,
        participant_id: pidStr,
      },
      UpdateExpression: "SET archetypal_selections = :selections, metadata = :metadata",
      ExpressionAttributeValues: {
        ":selections": selections,
        ":metadata": {
          job_id: jobId,
          created_at: new Date().toISOString(), // Keep original creation time if exists
          updated_at: new Date().toISOString(),
          version: 1,
          total_selections: selections.length,
        },
      },
      ReturnValues: "ALL_NEW" as const,
    };

    const result = await docClient.send(new UpdateCommand(updateParams));

    logger.info(`Updated topic agenda selections for user ${pidStr} in conversation ${zidStr}`);

    res.json({
      status: "success",
      message: "Topic agenda selections updated successfully",
      data: {
        conversation_id: zidStr,
        participant_id: pidStr,
        selections_count: selections.length,
        job_id: jobId,
      },
    });
  } catch (error) {
    logger.error("Error updating topic agenda selections", error);
    res.status(500).json({
      status: "error",
      message: "Failed to update topic agenda selections",
    });
  }
}

/**
 * DELETE /api/v3/topicAgenda/selections
 * Delete topic agenda selections for a user
 */
export async function handle_DELETE_topicAgenda_selections(req: Request & { user?: any }, res: Response) {
  try {
    const conversation_id = req.query.conversation_id as string;

    if (!conversation_id) {
      return res.status(400).json({
        status: "error",
        message: "conversation_id is required",
      });
    }

    if (!req.user || !req.user.uid) {
      return res.status(401).json({
        status: "error",
        message: "Authentication required",
      });
    }

    // Convert conversation_id to zid
    const zid = await Conversation.getZidFromConversationId(conversation_id);
    const zidStr = zid.toString();

    // Get participant ID
    const pid = await getPidPromise(zidStr, req.user.uid);
    const pidStr = pid.toString();

    // Delete from DynamoDB
    const deleteParams = {
      TableName: TABLE_NAME,
      Key: {
        conversation_id: zidStr,
        participant_id: pidStr,
      },
    };

    await docClient.send(new DeleteCommand(deleteParams));

    logger.info(`Deleted topic agenda selections for user ${pidStr} in conversation ${zidStr}`);

    res.json({
      status: "success",
      message: "Topic agenda selections deleted successfully",
    });
  } catch (error) {
    logger.error("Error deleting topic agenda selections", error);
    res.status(500).json({
      status: "error",
      message: "Failed to delete topic agenda selections",
    });
  }
}