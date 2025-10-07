import { Request, Response } from "express";
import logger from "../../utils/logger";
import { getZidFromReport } from "../../utils/parameter";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, QueryCommand } from "@aws-sdk/lib-dynamodb";
import { S3Client, ListObjectsV2Command } from "@aws-sdk/client-s3";
import Config from "../../config";
// import { datetime } from "aws-sdk/clients/redshiftdata";

const dynamoDBConfig: any = {
  region: Config.AWS_REGION || "us-east-1",
};

// If dynamoDbEndpoint is set, we're running locally
if (Config.dynamoDbEndpoint) {
  dynamoDBConfig.endpoint = Config.dynamoDbEndpoint;
  // Use dummy credentials for local DynamoDB
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
 * Handler for Delphi API route that retrieves visualization information
 */
export async function handle_GET_delphi_visualizations(
  req: Request,
  res: Response
) {
  logger.info("Delphi visualizations API request received");

  try {
    // Get report_id from request
    const report_id = req.query.report_id as string;
    const jobId = req.query.job_id as string;

    if (!report_id) {
      return res.status(400).json({
        status: "error",
        message: "report_id is required",
      });
    }

    // Extract zid from report_id
    let zid;
    try {
      zid = await getZidFromReport(report_id);
    } catch (err: any) {
      logger.error(`Error getting zid from report: ${err.message || err}`);
      return res.status(404).json({
        status: "error",
        message: "Could not find conversation for report_id",
        report_id,
      });
    }

    if (!zid) {
      return res.status(404).json({
        status: "error",
        message: "Could not find conversation for report_id",
        report_id,
      });
    }

    const conversation_id = zid.toString();
    logger.info(
      `Fetching visualizations for report_id: ${report_id}, conversation_id: ${conversation_id}`
    );

    // Configure S3 client
    const s3Config: any = {
      region: Config.AWS_REGION || "us-east-1",
      endpoint: Config.AWS_S3_ENDPOINT,
      credentials: {
        accessKeyId: Config.AWS_ACCESS_KEY_ID || "minioadmin",
        secretAccessKey: Config.AWS_SECRET_ACCESS_KEY || "minioadmin",
      },
      forcePathStyle: true, // Required for MinIO
    };

    logger.info(`S3 Config: 
      Endpoint: ${s3Config.endpoint}
      Region: ${s3Config.region}
      Bucket: ${Config.AWS_S3_BUCKET_NAME || "polis-delphi"}
    `);

    // Create S3 client
    const s3Client = new S3Client(s3Config);
    const bucketName = Config.AWS_S3_BUCKET_NAME || "polis-delphi";

    // Define S3 path prefix to search using report_id to avoid exposing ZIDs
    const prefix = jobId
      ? `visualizations/${report_id}/${jobId}/`
      : `visualizations/${report_id}/`;

    // Fetch job metadata using the optimized function
    const jobMetadata = await fetchJobMetadata(conversation_id);

    // List objects in the bucket
    let s3Response;
    try {
      const listObjectsParams = {
        Bucket: bucketName,
        Prefix: prefix,
        MaxKeys: 1000,
      };
      logger.info(
        `Listing S3 objects with params: ${JSON.stringify(listObjectsParams)}`
      );
      s3Response = await s3Client.send(
        new ListObjectsV2Command(listObjectsParams)
      );
      logger.info(
        `S3 listing successful. Found ${
          s3Response.Contents?.length || 0
        } objects.`
      );
    } catch (err: any) {
      logger.error(`Error listing S3 objects: ${err.message || err}`);
      return res.status(500).json({
        status: "error",
        message: "Error listing visualizations",
        error: err.message || String(err),
        report_id,
      });
    }

    // Check if files were found
    if (!s3Response.Contents || s3Response.Contents.length === 0) {
      return res.json({
        status: "success",
        message: "No visualizations found",
        report_id,
        visualizations: [],
        jobs: Object.values(jobMetadata), // Return job metadata even if no visualizations
      });
    }

    // Group visualizations by job
    const visualizationsByJob: Record<string, any[]> = {};

    for (const obj of s3Response.Contents) {
      const key = obj.Key || "";
      const keyParts = key.split("/");
      if (keyParts.length < 4) continue;

      const currentJobId = keyParts[2];
      const fileName = keyParts[3];

      if (
        !fileName.endsWith(".html") &&
        !fileName.endsWith(".png") &&
        !fileName.endsWith(".svg")
      ) {
        continue;
      }

      const layerMatch = fileName.match(/layer_(\d+)/);
      const layerId = layerMatch ? parseInt(layerMatch[1]) : null;
      if (layerId === null) continue;

      let url;
      try {
        const publicEndpoint =
          Config.AWS_S3_PUBLIC_ENDPOINT ||
          Config.AWS_S3_ENDPOINT ||
          "https://polis-delphi.s3.us-east-1.amazonaws.com";
        const cleanEndpoint = publicEndpoint
          .replace(/^https?:\/\//, "")
          .replace(/\/$/, "");
        const protocol = publicEndpoint.startsWith("https") ? "https" : "http";
        url = publicEndpoint.startsWith("https://polis-delphi")
          ? `${publicEndpoint}/${key}`
          : `${protocol}://${cleanEndpoint}/${bucketName}/${key}`;
      } catch (err: any) {
        logger.error(
          `Error generating signed URL for ${key}: ${err.message || err}`
        );
        continue;
      }

      let type = "unknown";
      if (fileName.includes("datamapplot.html")) type = "interactive";
      else if (fileName.includes("static.png")) type = "static_png";
      else if (fileName.includes("presentation.png")) type = "presentation_png";
      else if (fileName.includes("static.svg")) type = "static_svg";

      if (!visualizationsByJob[currentJobId]) {
        visualizationsByJob[currentJobId] = [];
      }
      visualizationsByJob[currentJobId].push({
        key,
        url,
        layerId,
        type,
        lastModified: obj.LastModified,
        size: obj.Size,
      });
    }

    Object.values(visualizationsByJob).forEach((visArray) => {
      visArray.sort((a, b) => (a.layerId || 0) - (b.layerId || 0));
    });

    const jobsWithVisualizations = Object.keys(jobMetadata).map((jobId) => ({
      ...(jobMetadata[jobId] || { jobId, status: "unknown", createdAt: null }),
      visualizations: visualizationsByJob[jobId] || [], // Associate visualizations or provide empty array
    }));

    // Add jobs found in S3 but not in metadata (edge case)
    Object.keys(visualizationsByJob).forEach((jobId) => {
      if (!jobMetadata[jobId]) {
        jobsWithVisualizations.push({
          jobId,
          status: "metadata_not_found",
          createdAt: null,
          visualizations: visualizationsByJob[jobId],
        });
      }
    });

    jobsWithVisualizations.sort((a, b) => {
      const dateA = a.createdAt ? new Date(a.createdAt).getTime() : 0;
      const dateB = b.createdAt ? new Date(b.createdAt).getTime() : 0;
      return dateB - dateA;
    });

    return res.json({
      status: "success",
      message: "Visualizations retrieved successfully",
      report_id,
      jobs: jobsWithVisualizations,
    });
  } catch (err: any) {
    logger.error(`Error in delphi visualizations endpoint: ${err.message}`);
    logger.error(err.stack);
    return res.status(500).json({
      status: "error",
      message: "Error processing request",
      error: err.message,
      report_id: req.query.report_id as string,
    });
  }
}

/**
 * Fetch job metadata from DynamoDB using a GSI Query, with support for pagination.
 * @param conversation_id The conversation ID to query for jobs.
 */
async function fetchJobMetadata(
  conversation_id: string
): Promise<Record<string, any>> {
  try {
    logger.info(
      `Querying GSI 'ConversationIndex' for all job pages with conversation_id: ${conversation_id}`
    );

    const allItems: any[] = [];
    let lastEvaluatedKey;

    do {
      const queryParams: any = {
        TableName: "Delphi_JobQueue",
        IndexName: "ConversationIndex",
        KeyConditionExpression: "conversation_id = :cid",
        ExpressionAttributeValues: {
          ":cid": conversation_id,
        },
        // For subsequent requests, start from where the last one left off.
        ExclusiveStartKey: lastEvaluatedKey,
      };

      const queryResponse = await docClient.send(new QueryCommand(queryParams));

      // Add the items from the current page to our accumulator array.
      if (queryResponse.Items) {
        allItems.push(...queryResponse.Items);
      }

      // Set the key for the next iteration. If it's undefined, the loop will terminate.
      lastEvaluatedKey = queryResponse.LastEvaluatedKey;

      if (lastEvaluatedKey) {
        logger.info("More job items to fetch, continuing with next page...");
      }
    } while (lastEvaluatedKey);

    // After the loop, allItems contains all items from all pages.
    if (allItems.length === 0) {
      logger.info(`No jobs found for conversation ${conversation_id}`);
      return {};
    }

    logger.info(
      `Found a total of ${allItems.length} jobs across all pages for conversation ${conversation_id}`
    );

    // Process the complete list of items.
    return processJobItems(allItems);
  } catch (err: any) {
    logger.error(`Error fetching job metadata via GSI Query: ${err.message}`);
    // Return an empty object so the main handler can continue without metadata if needed.
    return {};
  }
}

/**
 * Process job items from DynamoDB into a map of job metadata.
 */
function processJobItems(items: any[]): Record<string, any> {
  const jobMap: Record<string, any> = {};

  for (const item of items) {
    const job_id = item.job_id;

    let jobResults = null;
    try {
      if (item.job_results) {
        jobResults = JSON.parse(item.job_results);
      }
    } catch (e) {
      logger.warn(
        `Failed to parse job_results for job_id ${job_id}: ${item.job_results}`
      );
    }

    jobMap[job_id] = {
      jobId: job_id,
      status: item.status || "unknown",
      createdAt: item.created_at || null,
      startedAt: item.started_at || null,
      completedAt: item.completed_at || null,
      results: jobResults,
    };
  }

  return jobMap;
}
