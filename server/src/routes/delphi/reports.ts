import { resultClient } from "../../utils/delphiResults";
import { Request, Response } from "express";
import logger from "../../utils/logger";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, QueryCommand } from "@aws-sdk/lib-dynamodb";
import { getZidFromReport } from "../../utils/parameter";
import Config from "../../config";

const dynamoDBConfig: any = {
  region: Config.AWS_REGION || "us-east-1",
};
if (Config.dynamoDbEndpoint) {
  dynamoDBConfig.endpoint = Config.dynamoDbEndpoint;
  dynamoDBConfig.credentials = {
    accessKeyId: "DUMMYIDEXAMPLE",
    secretAccessKey: "DUMMYEXAMPLEKEY",
  };
  logger.info(`Using local DynamoDB at endpoint: ${Config.dynamoDbEndpoint}`);
} else {
  if (Config.AWS_ACCESS_KEY_ID && Config.AWS_SECRET_ACCESS_KEY) {
    dynamoDBConfig.credentials = {
      accessKeyId: Config.AWS_ACCESS_KEY_ID,
      secretAccessKey: Config.AWS_SECRET_ACCESS_KEY,
    };
    logger.info(`Using production DynamoDB with AWS credentials`);
  } else {
    logger.info(`Using default AWS credential provider chain`);
  }
}
const docClient = resultClient(() => DynamoDBDocumentClient.from(new DynamoDBClient(dynamoDBConfig), {
  marshallOptions: {
    convertEmptyValues: true,
    removeUndefinedValues: true,
  },
}));

/**
 * Handler for Delphi API route that retrieves LLM-generated reports from DynamoDB
 */
export async function handle_GET_delphi_reports(req: Request, res: Response) {
  logger.info("Delphi Reports API request received");

  const requestReportId = req.query.report_id as string;
  const sectionFilter = req.query.section as string;
  const topicKeyFilter = req.query.topic_key as string;
  const requestedJobId = req.query.job_id as string | undefined; // New: Accept job_id query param

  if (!requestReportId) {
    return res.json({
      status: "error",
      message: "report_id (requestReportId) is required",
    });
  }

  let gsiQueryableReportId: string;

  try {
    // The GSI uses report_id as the partition key, so we should query with the original report_id
    // rather than converting to zid. Keep zid lookup for validation purposes.
    const zid = await getZidFromReport(requestReportId);
    if (zid === null || zid === undefined) {
      logger.error(
        `Could not resolve requestReportId '${requestReportId}' to a ZID for validation.`
      );
      return res.json({
        status: "error",
        message:
          "Could not find a valid identifier for the report_id to query DynamoDB.",
        request_report_id: requestReportId,
      });
    }
    // Use the original report_id for GSI query since that's what's stored in DynamoDB
    gsiQueryableReportId = requestReportId;
    logger.info(
      `Fetching Delphi reports for GSI report_id: ${gsiQueryableReportId} (original requestReportId, validated against ZID: ${zid})`
    );
  } catch (err: any) {
    logger.error(
      `Error resolving requestReportId '${requestReportId}' via getZidFromReport: ${err.message}`
    );
    return res.json({
      status: "error",
      message: "Error resolving report identifier.",
      request_report_id: requestReportId,
      error_details: err.message,
    });
  }

  const tableName = "Delphi_NarrativeReports";
  const gsiName = "ReportIdTimestampIndex";

  try {
    logger.info(
      `Querying GSI '${gsiName}' on table '${tableName}' for GSI report_id: '${gsiQueryableReportId}'`
    );
    const allItems: any[] = [];
    let lastEvaluatedKeyGSI;
    do {
      const queryParams: any = {
        TableName: tableName,
        IndexName: gsiName,
        KeyConditionExpression: "report_id = :gsi_rid",
        ExpressionAttributeValues: { ":gsi_rid": gsiQueryableReportId },
        ExclusiveStartKey: lastEvaluatedKeyGSI,
      };
      const queryResult = await docClient.send(new QueryCommand(queryParams));
      if (queryResult.Items) {
        allItems.push(...queryResult.Items);
      }
      lastEvaluatedKeyGSI = queryResult.LastEvaluatedKey;
    } while (lastEvaluatedKeyGSI);

    logger.info(
      `GSI Query found ${allItems.length} total items for GSI report_id: '${gsiQueryableReportId}'`
    );

    if (allItems.length === 0) {
      return res.json({
        status: "success",
        message: "No reports found for the given report identifier.",
        request_report_id: requestReportId,
        queried_gsi_report_id: gsiQueryableReportId,
        reports: {},
      });
    }

    // --- Processing Logic ---
    // Group items by their actual job_id
    const reportsByJobId: Record<string, any[]> = {};
    allItems.forEach((item) => {
      const itemJobId =
        item.job_id ||
        `unknown_job_${item.timestamp?.substring(0, 10) || "nodate"}`;
      if (!reportsByJobId[itemJobId]) {
        reportsByJobId[itemJobId] = [];
      }
      reportsByJobId[itemJobId].push(item);
    });

    // Sort job runs by the latest timestamp within each job group (most recent job first)
    const sortedJobIds = Object.keys(reportsByJobId).sort((jobA, jobB) => {
      const latestTimestampA = reportsByJobId[jobA].reduce(
        (latest, item) => (item.timestamp > latest ? item.timestamp : latest),
        ""
      );
      const latestTimestampB = reportsByJobId[jobB].reduce(
        (latest, item) => (item.timestamp > latest ? item.timestamp : latest),
        ""
      );
      return latestTimestampB.localeCompare(latestTimestampA);
    });

    if (sortedJobIds.length === 0) {
      return res.json({
        status: "success",
        message: "No report runs found after grouping.",
        request_report_id: requestReportId,
        queried_gsi_report_id: gsiQueryableReportId,
        reports: {},
        available_runs: [],
      });
    }

    let itemsToProcess: any[];
    let currentRunJobId: string;

    if (requestedJobId) {
      if (reportsByJobId[requestedJobId]) {
        itemsToProcess = reportsByJobId[requestedJobId];
        currentRunJobId = requestedJobId;
        logger.info(`Processing requested job_id: ${requestedJobId}`);
      } else {
        logger.warn(
          `Requested job_id '${requestedJobId}' not found for report '${gsiQueryableReportId}'. Returning empty.`
        );
        itemsToProcess = [];
        currentRunJobId = requestedJobId; // Still indicate what was requested
      }
    } else {
      // Default to the most recent job run
      currentRunJobId = sortedJobIds[0];
      itemsToProcess = reportsByJobId[currentRunJobId] || [];
      logger.info(`Processing most recent job_id: ${currentRunJobId}`);
    }

    const mostRecentRunKey =
      itemsToProcess[0]?.timestamp?.substring(0, 16) ||
      "unknown_timestamp_prefix"; // For compatibility if needed, but job_id is primary
    logger.info(
      `Found ${
        Object.keys(reportsByJobId).length
      } report runs, using most recent from ${mostRecentRunKey}`
    );

    const reportsBySection: Record<string, any> = {};
    itemsToProcess.forEach((item) => {
      const rid_section_model = item.rid_section_model || "";
      const parts = rid_section_model.split("#");
      if (parts.length >= 2) {
        const section = parts[1];
        const model = parts.length > 2 ? parts[2] : "unknown";
        // This populates reportsBySection where each key is a section name,
        // and the value is the report object for that section from the most recent run.
        reportsBySection[section] = {
          section: section,
          model: model,
          timestamp: item.timestamp || "",
          report_data: item.report_data || "",
          errors: item.errors,
          job_id: item.job_id, // Include job_id in the response for clarity
          metadata: item.metadata || null,
        };
      }
    });

    const allRunsList = sortedJobIds.map((jobId) => {
      const runItems = reportsByJobId[jobId];
      const latestTimestampInJob = runItems.reduce(
        (latest, item) => (item.timestamp > latest ? item.timestamp : latest),
        ""
      );
      const modelFromSample = runItems[0]?.model || "unknown";
      return {
        job_id: jobId,
        latest_timestamp: latestTimestampInJob,
        model: modelFromSample,
        sectionCount: runItems.length,
        isCurrent: jobId === currentRunJobId,
      };
    });

    // --- Filtering logic ---
    let filteredReports = reportsBySection;

    if (sectionFilter && topicKeyFilter) {
      // Attempt to access reportsBySection[sectionFilter][topicKeyFilter]
      if (
        reportsBySection[sectionFilter] &&
        reportsBySection[sectionFilter][topicKeyFilter]
      ) {
        return res.json({
          status: "success",
          message: "Topic report retrieved successfully",
          request_report_id: requestReportId,
          queried_gsi_report_id: gsiQueryableReportId,
          section: sectionFilter,
          topic_key: topicKeyFilter,
          data: reportsBySection[sectionFilter][topicKeyFilter],
        });
      } else {
        return res.json({
          status: "error",
          message: "Topic report not found",
          request_report_id: requestReportId,
          queried_gsi_report_id: gsiQueryableReportId,
          section: sectionFilter,
          topic_key: topicKeyFilter,
        });
      }
    } else if (sectionFilter) {
      filteredReports = {
        [sectionFilter]:
          reportsBySection[sectionFilter] ||
          reportsBySection[
            Object.keys(reportsBySection).find((k) => k.includes(sectionFilter))
          ] ||
          {},
      };
    }

    return res.json({
      status: "success",
      message: "Reports retrieved successfully",
      request_report_id: requestReportId,
      queried_gsi_report_id: gsiQueryableReportId,
      reports: filteredReports,
      current_job_id: currentRunJobId,
      available_runs: allRunsList,
    });
  } catch (err: any) {
    logger.error(
      `Error during DynamoDB operation or report processing: ${err.message}`
    );
    if (err.stack) {
      logger.error(err.stack);
    }
    return res.json({
      status: "error",
      message: `Error processing request: ${err.message}`,
      request_report_id: requestReportId,
      queried_gsi_report_id: gsiQueryableReportId,
      reports: {},
    });
  }
}
