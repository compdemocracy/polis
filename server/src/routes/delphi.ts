import { Request, Response } from "express";
import logger from "../utils/logger";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  DynamoDBDocumentClient,
  GetCommand,
  QueryCommand,
} from "@aws-sdk/lib-dynamodb";
import {
  CloudWatchLogsClient,
  FilterLogEventsCommand,
  FilteredLogEvent,
} from "@aws-sdk/client-cloudwatch-logs";
import { getZidFromReport } from "../utils/parameter";
import { getZidFromConversationId } from "../conversation";
import { isModerator } from "../utils/common";
import Config from "../config";

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

const logsClient = new CloudWatchLogsClient({
  region: Config.AWS_REGION || "us-east-1",
});

/**
 * Handler for Delphi API route that retrieves LLM topic names from DynamoDB
 */
export async function handle_GET_delphi(req: Request, res: Response) {
  logger.info("Delphi API request received");

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
    const tableName = "Delphi_CommentClustersLLMTopicNames";

    logger.info(
      `Fetching Delphi LLM topics for conversation_id: ${conversation_id}`
    );

    // Also fetch current job UUID from narrative reports for correct section key construction
    let currentJobUuid = null;
    try {
      const narrativeReportsTable = "Delphi_NarrativeReports";
      const gsiName = "ReportIdTimestampIndex";

      const narrativeParams: any = {
        TableName: narrativeReportsTable,
        IndexName: gsiName,
        KeyConditionExpression: "report_id = :rid",
        ExpressionAttributeValues: { ":rid": report_id },
        Limit: 1, // Just need one to get the job UUID pattern
      };

      const narrativeResult = await docClient.send(
        new QueryCommand(narrativeParams)
      );
      if (narrativeResult.Items && narrativeResult.Items.length > 0) {
        const sampleSection = narrativeResult.Items[0].section;
        // Extract job UUID from section name if it contains UUID pattern
        if (
          sampleSection &&
          sampleSection.includes("-") &&
          sampleSection.includes("_")
        ) {
          const uuidMatch = sampleSection.match(
            /([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})/
          );
          if (uuidMatch) {
            currentJobUuid = uuidMatch[1];
            logger.info(`Found current job UUID: ${currentJobUuid}`);
          }
        }
      }
    } catch (err) {
      logger.warn(`Could not fetch job UUID from narrative reports: ${err}`);
    }

    const allItems: any[] = [];
    let lastEvaluatedKey;

    do {
      const params: any = {
        TableName: tableName,
        KeyConditionExpression: "conversation_id = :cid",
        ExpressionAttributeValues: { ":cid": conversation_id },
        ExclusiveStartKey: lastEvaluatedKey,
      };

      const data = await docClient.send(new QueryCommand(params));
      if (data.Items) {
        allItems.push(...data.Items);
      }
      lastEvaluatedKey = data.LastEvaluatedKey;
    } while (lastEvaluatedKey);

    if (allItems.length === 0) {
      return res.json({
        status: "success",
        message: "No LLM topics found for this conversation",
        report_id,
        runs: {}, // Return "runs" object for consistency
      });
    }

    const runGroups: Record<string, any[]> = {};
    allItems.forEach((item) => {
      const modelName = item.model_name || "unknown";
      const createdAt = item.created_at || "";
      const createdDate = createdAt.substring(0, 10);
      const runKey = `${modelName}_${createdDate}`;
      if (!runGroups[runKey]) {
        runGroups[runKey] = [];
      }
      runGroups[runKey].push(item);
    });

    const allRuns: Record<string, any> = {};
    Object.entries(runGroups).forEach(([runKey, runItems]) => {
      const topicsByLayer: Record<string, Record<string, any>> = {};
      runItems.forEach((item) => {
        const layerId = item.layer_id;
        const clusterId = item.cluster_id;
        if (!topicsByLayer[layerId]) {
          topicsByLayer[layerId] = {};
        }
        topicsByLayer[layerId][clusterId] = {
          topic_name: item.topic_name,
          model_name: item.model_name,
          created_at: item.created_at,
          topic_key: item.topic_key,
        };
      });
      const sampleItem = runItems[0];
      allRuns[runKey] = {
        model_name: sampleItem.model_name,
        created_date: sampleItem.created_at,
        topics_by_layer: topicsByLayer,
        item_count: runItems.length,
        job_uuid: currentJobUuid, // Include job UUID for section key construction
      };
    });

    const sortedRuns = Object.entries(allRuns)
      .sort(([, runA], [, runB]) => {
        const dateA = new Date(runA.created_date || 0);
        const dateB = new Date(runB.created_date || 0);
        return dateB.getTime() - dateA.getTime();
      })
      .reduce((acc, [key, value]) => {
        acc[key] = value;
        return acc;
      }, {} as Record<string, any>);

    return res.json({
      status: "success",
      message: "LLM topics retrieved successfully",
      report_id,
      runs: sortedRuns,
    });
  } catch (err: any) {
    if (err.name === "ResourceNotFoundException") {
      logger.warn(
        `DynamoDB table not found: Delphi_CommentClustersLLMTopicNames`
      );
      return res.status(404).json({
        status: "error",
        message: "Delphi topic service not available yet.",
        hint: "The table may need to be created by running the Delphi pipeline.",
        report_id,
      });
    }
    logger.error(
      `Error querying DynamoDB or processing request: ${err.message}`
    );
    logger.error(`Error details: ${JSON.stringify(err)}`);

    return res.status(500).json({
      status: "error",
      message: "Error querying DynamoDB",
      error_details: {
        name: err.name,
        message: err.message,
      },
      report_id,
    });
  }
}

const getLogs = async (
  logGroupName: string,
  startTime: number,
  endTime: number,
  filterPattern: string,
  job_id: string
): Promise<FilteredLogEvent[]> => {
  if (Config.awsLogGroupName === "docker") {
    return [
      {
        message: `[DELPHI JOB ${job_id.slice(
          -8
        )}] INFO: view logs in console! - ${Date.now()}`,
      },
    ];
  } else {
    let allEvents: FilteredLogEvent[] = [];
    let nextToken: string | undefined = undefined;

    try {
      do {
        const command = new FilterLogEventsCommand({
          logGroupName: logGroupName,
          startTime: startTime,
          endTime: endTime,
          filterPattern: filterPattern,
          nextToken: nextToken,
        });

        const response = await logsClient.send(command);

        if (response.events) {
          allEvents.push(...response.events);
        }

        nextToken = response.nextToken;
      } while (nextToken);

      return allEvents;
    } catch (err) {
      logger.error("Error fetching logs:", err);
      throw err;
    }
  }
};

/**
 * Resolves the conversation a Delphi job belongs to, as a numeric zid.
 *
 * Delphi_JobQueue rows store `conversation_id` as a string that is either the
 * numeric zid (the topicAgenda/ConversationIndex convention) or the public
 * conversation_id (zinvite) that the job was submitted with, so both are
 * accepted here.
 *
 * @returns the zid, or null when the job does not exist / cannot be resolved.
 */
async function getZidForDelphiJob(job_id: string): Promise<number | null> {
  const result = await docClient.send(
    new GetCommand({
      TableName: "Delphi_JobQueue",
      Key: { job_id },
    })
  );

  const raw = result.Item?.conversation_id;
  if (raw === undefined || raw === null || raw === "") {
    return null;
  }

  const asString = String(raw);
  if (/^\d+$/.test(asString)) {
    return Number(asString);
  }

  try {
    const zid = await getZidFromConversationId(asString);
    return zid === undefined || zid === null ? null : Number(zid);
  } catch (err) {
    logger.warn(
      `Could not resolve conversation_id ${asString} for delphi job ${job_id}`,
      err
    );
    return null;
  }
}

export async function handle_GET_delphi_job_logs(req: Request, res: Response) {
  const job_id = req.query.job_id as string;
  const uid = req.p?.uid as number | undefined;
  const threeHoursAgo = Date.now() - 3 * 3600 * 1000;

  if (!job_id || typeof job_id !== "string") {
    return res
      .status(400)
      .json({ status: "error", message: "job_id is required" });
  }

  // Logs may contain conversation content, so reading them requires ownership
  // of the conversation the job was run for.
  let zid: number | null;
  try {
    zid = await getZidForDelphiJob(job_id);
  } catch (error) {
    logger.error(`Failed to look up delphi job ${job_id}`, error);
    return res
      .status(500)
      .json({ status: "error", message: "Failed to retrieve logs" });
  }

  if (zid === null) {
    return res.status(404).json({ status: "error", message: "Job not found" });
  }

  const isMod = await isModerator(zid, uid);
  if (!isMod) {
    return res
      .status(403)
      .json({ status: "error", message: "polis_err_delphi_logs_auth" });
  }

  try {
    const logs = await getLogs(
      Config.awsLogGroupName,
      threeHoursAgo,
      Date.now(),
      `"[DELPHI JOB ${job_id.slice(0, 8)}"`,
      job_id
    );
    return res.json(logs);
  } catch (error) {
    logger.error(`Failed to retrieve logs for id ${job_id}`, error);
    return res
      .status(500)
      .json({ status: "error", message: "Failed to retrieve logs" });
  }
}
