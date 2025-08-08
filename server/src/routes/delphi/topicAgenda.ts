import _ from "underscore";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, QueryCommand } from "@aws-sdk/lib-dynamodb";
import { Response } from "express";

import { RequestWithP } from "../../d";
import Config from "../../config";
import logger from "../../utils/logger";
import pgQuery from "../../db/pg-query";

// DynamoDB configuration for job queries only
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

const dynamoClient = new DynamoDBClient(dynamoDBConfig);
const docClient = DynamoDBDocumentClient.from(dynamoClient, {
  marshallOptions: {
    convertEmptyValues: true,
    removeUndefinedValues: true,
  },
});

/**
 * Get the current Delphi job ID for a conversation
 */
async function getCurrentDelphiJobId(zid: string): Promise<string | null> {
  try {
    // Query the ConversationIndex GSI to find completed jobs for this conversation
    const queryParams = {
      TableName: "Delphi_JobQueue",
      IndexName: "ConversationIndex",
      KeyConditionExpression: "conversation_id = :zid",
      FilterExpression: "#status = :status",
      ExpressionAttributeNames: {
        "#status": "status", // Use expression attribute name since 'status' might be reserved
      },
      ExpressionAttributeValues: {
        ":zid": zid.toString(),
        ":status": "COMPLETED",
      },
      ScanIndexForward: false, // Sort by created_at DESC
      Limit: 1,
    };

    const result = await docClient.send(new QueryCommand(queryParams));

    if (result.Items && result.Items.length > 0) {
      const jobId = result.Items[0].job_id;
      return jobId;
    }

    return null;
  } catch (error: any) {
    logger.error("Error getting current Delphi job ID from DynamoDB", error);
    return null;
  }
}

/**
 * POST /api/v3/topicAgenda/selections
 * Save topic agenda selections for a user
 */
export async function handle_POST_topicAgenda_selections(
  req: RequestWithP,
  res: Response
) {
  try {
    const { selections } = req.body;

    if (!selections) {
      return res.status(400).json({
        status: "error",
        message: "selections are required",
      });
    }

    // The middleware ensures we have a participant
    const zid = req.p.zid!;
    const pid = req.p.pid!;

    // Get current Delphi job ID
    const jobId = await getCurrentDelphiJobId(zid.toString());

    // Use UPSERT (INSERT ... ON CONFLICT UPDATE) to handle both new and existing records
    const query = `
      INSERT INTO topic_agenda_selections (zid, pid, archetypal_selections, delphi_job_id, total_selections, created_at, updated_at)
      VALUES ($1, $2, $3, $4, $5, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
      ON CONFLICT (zid, pid) 
      DO UPDATE SET 
        archetypal_selections = EXCLUDED.archetypal_selections,
        delphi_job_id = EXCLUDED.delphi_job_id,
        total_selections = EXCLUDED.total_selections,
        updated_at = CURRENT_TIMESTAMP
      RETURNING zid, pid, total_selections
    `;

    const result = await pgQuery.queryP(query, [
      zid,
      pid,
      JSON.stringify(selections),
      jobId,
      selections.length,
    ]);

    const response: any = {
      status: "success",
      message: "Topic agenda selections saved successfully",
      data: {
        conversation_id: zid.toString(),
        participant_id: pid.toString(),
        selections_count:
          (result as any)[0]?.total_selections || selections.length,
        job_id: jobId,
      },
    };

    // Auth token will be automatically included by attachAuthToken middleware

    res.json(response);
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
export async function handle_GET_topicAgenda_selections(
  req: RequestWithP,
  res: Response
) {
  try {
    // Check if we have a participant (user is authenticated and has a participant record)
    if (_.isUndefined(req.p.pid) || req.p.pid < 0) {
      // No participant record - return empty response
      return res.json({
        status: "success",
        message: "No selections found",
        data: null,
      });
    }

    const zid = req.p.zid!;
    const pid = req.p.pid;

    // Retrieve from PostgreSQL
    const query = `
      SELECT 
        zid as conversation_id,
        pid as participant_id,
        archetypal_selections,
        delphi_job_id,
        total_selections,
        created_at,
        updated_at
      FROM topic_agenda_selections
      WHERE zid = $1 AND pid = $2
    `;

    const result = await pgQuery.queryP(query, [zid, pid]);
    const rows = result as any[];

    if (!rows || rows.length === 0) {
      return res.json({
        status: "success",
        message: "No selections found",
        data: null,
      });
    }

    const row = rows[0];

    res.json({
      status: "success",
      data: {
        conversation_id: row.conversation_id.toString(),
        participant_id: row.participant_id.toString(),
        archetypal_selections: row.archetypal_selections,
        delphi_job_id: row.delphi_job_id,
        total_selections: row.total_selections,
        created_at: row.created_at,
        updated_at: row.updated_at,
      },
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
export async function handle_PUT_topicAgenda_selections(
  req: RequestWithP,
  res: Response
) {
  try {
    const { selections } = req.body;

    if (!selections) {
      return res.status(400).json({
        status: "error",
        message: "selections are required",
      });
    }

    // Check if we have a participant record
    if (_.isUndefined(req.p.pid) || req.p.pid < 0) {
      return res.status(401).json({
        status: "error",
        message: "Authentication required",
      });
    }

    const zid = req.p.zid!;
    const pid = req.p.pid;

    // Get current Delphi job ID
    const jobId = await getCurrentDelphiJobId(zid.toString());

    // Update the record
    const updateQuery = `
      UPDATE topic_agenda_selections 
      SET 
        archetypal_selections = $3,
        delphi_job_id = $4,
        total_selections = $5,
        updated_at = CURRENT_TIMESTAMP
      WHERE zid = $1 AND pid = $2
      RETURNING zid, pid, total_selections
    `;

    const result = await pgQuery.queryP(updateQuery, [
      zid,
      pid,
      JSON.stringify(selections),
      jobId,
      selections.length,
    ]);
    const rows = result as any[];

    if (rows.length === 0) {
      // Record doesn't exist, create it instead
      const insertQuery = `
        INSERT INTO topic_agenda_selections (zid, pid, archetypal_selections, delphi_job_id, total_selections, created_at, updated_at)
        VALUES ($1, $2, $3, $4, $5, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
        RETURNING zid, pid, total_selections
      `;

      const insertResult = await pgQuery.queryP(insertQuery, [
        zid,
        pid,
        JSON.stringify(selections),
        jobId,
        selections.length,
      ]);
      const insertRows = insertResult as any[];

      res.json({
        status: "success",
        message: "Topic agenda selections created successfully",
        data: {
          conversation_id: zid.toString(),
          participant_id: pid.toString(),
          selections_count:
            insertRows[0]?.total_selections || selections.length,
          job_id: jobId,
        },
      });
    } else {
      res.json({
        status: "success",
        message: "Topic agenda selections updated successfully",
        data: {
          conversation_id: zid.toString(),
          participant_id: pid.toString(),
          selections_count: rows[0]?.total_selections || selections.length,
          job_id: jobId,
        },
      });
    }
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
export async function handle_DELETE_topicAgenda_selections(
  req: RequestWithP,
  res: Response
) {
  try {
    // Check if we have a participant record
    if (_.isUndefined(req.p.pid) || req.p.pid < 0) {
      return res.status(401).json({
        status: "error",
        message: "Authentication required",
      });
    }

    const zid = req.p.zid!;
    const pid = req.p.pid;

    // Delete from PostgreSQL
    const deleteQuery = `
      DELETE FROM topic_agenda_selections
      WHERE zid = $1 AND pid = $2
      RETURNING zid, pid
    `;

    const result = await pgQuery.queryP(deleteQuery, [zid, pid]);
    const rows = result as any[];

    if (rows.length === 0) {
      return res.json({
        status: "success",
        message: "No selections to delete",
      });
    }

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
