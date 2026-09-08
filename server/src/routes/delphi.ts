import { Request, Response } from "express";
import logger from "../utils/logger";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  DynamoDBDocumentClient,
  GetCommand,
  QueryCommand,
} from "@aws-sdk/lib-dynamodb";
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

/**
 * One line of a Delphi job's log, in the shape this route has always returned
 * (a CloudWatch `FilteredLogEvent` subset: epoch-millisecond `timestamp` plus
 * `message`). The client keys log lines by `timestamp` and renders `message`.
 */
interface DelphiJobLogEvent {
  timestamp?: number;
  message?: string;
}

/**
 * Reads the log lines belonging to exactly one Delphi job, from that job's own
 * Delphi_JobQueue row.
 *
 * This route used to scrape CloudWatch with the filter pattern
 * `"[DELPHI JOB <first 8 chars of job_id>"`, which is what
 * `delphi/scripts/job_poller.py:update_job_logs` mirrors to the console. That
 * prefix does not identify a job: every CREATE_NARRATIVE_BATCH job id begins
 * `batch_report_...`, so all of them share the prefix `batch_re` (checker jobs
 * likewise share `batch_ch`), and even random UUID prefixes can collide. Any
 * caller who owned one such job passed the ownership check and then received
 * every other owner's matching events from the shared log group. Authorization
 * has to bind the data that is returned, not just the row that is looked up,
 * so the prefix scrape is gone and is not replaced by a narrower one: there is
 * no way to recover full job identity from prefix-only historical messages, so
 * ambiguous events are never returned.
 *
 * The same `update_job_logs` writes each entry, in full and structured, to the
 * job's own row (`logs` = `{"entries":[{timestamp, level, message}]}`, most
 * recent 50), including every mirrored `[stdout]` line. Reading that row is
 * exact by construction — a Dynamo `GetCommand` on the primary key — and it
 * preserves the completion sentinel the report client watches for
 * ("Results stored in DynamoDB for conversation", printed by
 * `delphi/run_delphi.py` and mirrored into the entries).
 */
function readJobLogEvents(
  item: Record<string, any>,
  job_id: string
): DelphiJobLogEvent[] {
  const raw = item?.logs;
  if (raw === undefined || raw === null) {
    return [];
  }

  let parsed: any;
  if (typeof raw === "string") {
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      logger.warn(`Unparseable logs on delphi job ${job_id}`, err);
      return [];
    }
  } else {
    parsed = raw;
  }

  const entries = parsed?.entries;
  if (!Array.isArray(entries)) {
    return [];
  }

  return entries.map((entry: any) => {
    // Stored as an ISO-8601 string; the response has always carried epoch
    // millis, so keep that and drop unparseable values rather than emitting
    // NaN.
    const parsedTime = Date.parse(entry?.timestamp);
    const level = entry?.level ? `${entry.level}` : "INFO";
    return {
      timestamp: Number.isNaN(parsedTime) ? undefined : parsedTime,
      // The full job id, never a truncated prefix, so a line is always
      // attributable to the job it was authorized against.
      message: `[DELPHI JOB ${job_id}] ${level}: ${entry?.message ?? ""}`,
    };
  });
}

/**
 * Fetches one Delphi_JobQueue row by its primary key.
 *
 * @returns the row, or null when no such job exists.
 */
async function getDelphiJob(
  job_id: string
): Promise<Record<string, any> | null> {
  const result = await docClient.send(
    new GetCommand({
      TableName: "Delphi_JobQueue",
      Key: { job_id },
    })
  );

  return result.Item ?? null;
}

/**
 * Resolves the conversation a Delphi job belongs to, as a numeric zid.
 *
 * Delphi_JobQueue rows store `conversation_id` as a string that is either the
 * numeric zid (the topicAgenda/ConversationIndex convention) or the public
 * conversation_id (zinvite) that the job was submitted with, so both are
 * accepted here.
 *
 * @returns the zid, or null when it cannot be resolved.
 */
async function getZidForDelphiJob(
  item: Record<string, any>,
  job_id: string
): Promise<number | null> {
  const raw = item?.conversation_id;
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

  if (!job_id || typeof job_id !== "string") {
    return res
      .status(400)
      .json({ status: "error", message: "job_id is required" });
  }

  // Logs may contain conversation content, so reading them requires ownership
  // of the conversation the job was run for.
  let item: Record<string, any> | null;
  try {
    item = await getDelphiJob(job_id);
  } catch (error) {
    logger.error(`Failed to look up delphi job ${job_id}`, error);
    return res
      .status(500)
      .json({ status: "error", message: "Failed to retrieve logs" });
  }

  if (item === null) {
    return res.status(404).json({ status: "error", message: "Job not found" });
  }

  const zid = await getZidForDelphiJob(item, job_id);
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
    // Read from the authorized row itself, so every line returned belongs to
    // the job that was authorized.
    return res.json(readJobLogEvents(item, job_id));
  } catch (error) {
    logger.error(`Failed to retrieve logs for id ${job_id}`, error);
    return res
      .status(500)
      .json({ status: "error", message: "Failed to retrieve logs" });
  }
}
