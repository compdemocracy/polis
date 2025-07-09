import { Request, Response } from "express";
import logger from "../../../utils/logger";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, QueryCommand } from "@aws-sdk/lib-dynamodb";
import { getZidFromReport } from "../../../utils/parameter";
import Config from "../../../config";

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
const client = new DynamoDBClient(dynamoDBConfig);
const docClient = DynamoDBDocumentClient.from(client, {
  marshallOptions: {
    convertEmptyValues: true,
    removeUndefinedValues: true,
  },
});

/**
 * Handler for feeds directory listing - shows available feeds for a report
 */
export async function handle_GET_feeds_directory(req: Request, res: Response) {
  const requestReportId = req.params.reportId;

  if (!requestReportId) {
    return res.status(400).send(`
      <html><head><title>Error</title></head><body>
        <h1>Error</h1>
        <p>report_id is required</p>
      </body></html>
    `);
  }

  try {
    // Validate report exists
    const zid = await getZidFromReport(requestReportId);
    if (zid === null || zid === undefined) {
      return res.status(404).send(`
        <html><head><title>Report Not Found</title></head><body>
          <h1>Report Not Found</h1>
          <p>Report ID: ${requestReportId}</p>
        </body></html>
      `);
    }

    // Check if we have any narrative reports or topic data
    const narrativeTableName = "Delphi_NarrativeReports";
    const narrativeGsiName = "ReportIdTimestampIndex";

    const narrativeQueryParams = {
      TableName: narrativeTableName,
      IndexName: narrativeGsiName,
      KeyConditionExpression: "report_id = :rid",
      ExpressionAttributeValues: { ":rid": requestReportId },
      Limit: 1,
    };

    const narrativeResult = await docClient.send(
      new QueryCommand(narrativeQueryParams)
    );
    const hasNarrativeData =
      narrativeResult.Items && narrativeResult.Items.length > 0;

    // Check for topic data (simplified - in real implementation would check Delphi topics table)
    const hasTopicData = hasNarrativeData; // For now, assume if we have narrative data we have topics

    const feeds = [];

    if (hasNarrativeData) {
      feeds.push({
        title: "Consensus Updates",
        url: `/feeds/${requestReportId}/consensus`,
        description: "Cross-group consensus changes and updates",
        type: "consensus",
      });
    }

    if (hasTopicData) {
      feeds.push({
        title: "Topic Hierarchy",
        url: `/feeds/${requestReportId}/topics`,
        description: "Hierarchical clustering results and topic organization",
        type: "topics",
      });
    }

    // Return HTML directory listing
    const feedLinks = feeds
      .map(
        (feed) =>
          `<li><a href="${feed.url}">${feed.title}</a> - ${feed.description}</li>`
      )
      .join("\n          ");

    res.set("Content-Type", "text/html");
    res.send(`
      <html>
        <head>
          <title>RSS Feeds - Report ${requestReportId}</title>
          <style>
            body { font-family: Arial, sans-serif; max-width: 800px; margin: 0 auto; padding: 20px; }
            .feed-list { margin: 20px 0; }
            .feed-list li { margin: 10px 0; }
            .meta { color: #666; font-size: 0.9em; }
          </style>
        </head>
        <body>
          <h1>Available RSS Feeds</h1>
          <p class="meta">Report ID: ${requestReportId}</p>
          
          ${
            feeds.length > 0
              ? `
            <h2>Available Feeds</h2>
            <ul class="feed-list">
              ${feedLinks}
            </ul>
          `
              : `
            <p>No feeds available yet. This report needs to be processed by Delphi to generate RSS feeds.</p>
          `
          }
          
          <h2>What are these feeds?</h2>
          <ul>
            <li><strong>Consensus Updates</strong> - Shows when new cross-group consensus emerges in the conversation</li>
            <li><strong>Topic Hierarchy</strong> - Shows the hierarchical clustering structure from coarse to fine-grained topics</li>
          </ul>
          
          <p class="meta">
            These feeds are updated when new analysis is run on the conversation data.
            Subscribe to them in your RSS reader to get notified of consensus changes and topic updates.
          </p>
        </body>
      </html>
    `);
  } catch (err: any) {
    logger.error(`Error in feeds directory: ${err.message}`);
    res.status(500).send(`
      <html><head><title>Error</title></head><body>
        <h1>Error</h1>
        <p>Error processing request: ${err.message}</p>
      </body></html>
    `);
  }
}

/**
 * Handler for consensus RSS feed
 */
export async function handle_GET_consensus_feed(req: Request, res: Response) {
  const requestReportId = req.params.reportId;

  if (!requestReportId) {
    return res.status(400).set("Content-Type", "application/rss+xml").send(`
      <?xml version="1.0" encoding="UTF-8"?>
      <rss version="2.0">
        <channel>
          <title>Error</title>
          <description>report_id is required</description>
        </channel>
      </rss>
    `);
  }

  try {
    // Validate report exists
    const zid = await getZidFromReport(requestReportId);
    if (zid === null || zid === undefined) {
      return res.status(404).set("Content-Type", "application/rss+xml").send(`
        <?xml version="1.0" encoding="UTF-8"?>
        <rss version="2.0">
          <channel>
            <title>Report Not Found</title>
            <description>Report ${requestReportId} not found</description>
          </channel>
        </rss>
      `);
    }

    // Fetch narrative reports
    const tableName = "Delphi_NarrativeReports";
    const gsiName = "ReportIdTimestampIndex";

    const queryParams = {
      TableName: tableName,
      IndexName: gsiName,
      KeyConditionExpression: "report_id = :rid",
      ExpressionAttributeValues: { ":rid": requestReportId },
    };

    const queryResult = await docClient.send(new QueryCommand(queryParams));
    const items = queryResult.Items || [];

    // Filter for consensus-related reports
    const consensusItems = items.filter((item) => {
      const ridSectionModel = item.rid_section_model || "";
      const parts = ridSectionModel.split("#");
      const section = parts.length >= 2 ? parts[1] : "";
      return (
        section.includes("consensus") ||
        section.includes("global_group_informed_consensus")
      );
    });

    // Sort by timestamp (most recent first)
    consensusItems.sort((a, b) =>
      (b.timestamp || "").localeCompare(a.timestamp || "")
    );

    // Build rich RSS items with full narrative structure
    const rssItems = consensusItems
      .slice(0, 10)
      .map((item) => {
        const ridSectionModel = item.rid_section_model || "";
        const parts = ridSectionModel.split("#");
        const section = parts.length >= 2 ? parts[1] : "unknown";
        const model = parts.length > 2 ? parts[2] : "unknown";

        const title = `Cross-Group Consensus Analysis`;
        const pubDate = item.timestamp
          ? new Date(item.timestamp).toUTCString()
          : new Date().toUTCString();
        const guid = `${requestReportId}-${section}-${item.timestamp}`;
        const link = `https://pol.is/report/${requestReportId}#consensus-${section}`;

        // Parse and reconstruct the full narrative structure
        let contentHtml = "<p>Consensus analysis available</p>";
        let citationIds: number[] = [];

        try {
          if (item.report_data && typeof item.report_data === "string") {
            const data = JSON.parse(item.report_data);

            if (data.paragraphs && Array.isArray(data.paragraphs)) {
              // Build HTML content from structured narrative
              let htmlSections: string[] = [];

              data.paragraphs.forEach((paragraph: any) => {
                if (paragraph.title) {
                  htmlSections.push(`<h3>${paragraph.title}</h3>`);
                }

                if (paragraph.sentences && Array.isArray(paragraph.sentences)) {
                  paragraph.sentences.forEach((sentence: any) => {
                    let sentenceText = "";
                    let sentenceCitations: number[] = [];

                    if (sentence.clauses && Array.isArray(sentence.clauses)) {
                      sentence.clauses.forEach((clause: any) => {
                        sentenceText += clause.text || "";

                        if (
                          clause.citations &&
                          Array.isArray(clause.citations)
                        ) {
                          clause.citations.forEach((citation: any) => {
                            if (typeof citation === "number") {
                              sentenceCitations.push(citation);
                              citationIds.push(citation);
                            }
                          });
                        }
                      });
                    }

                    // Add citations as superscript
                    if (sentenceCitations.length > 0) {
                      sentenceText += `<sup>[${sentenceCitations.join(
                        ", "
                      )}]</sup>`;
                    }

                    htmlSections.push(`<p>${sentenceText}</p>`);
                  });
                }
              });

              contentHtml = htmlSections.join("\n");
            }
          }
        } catch (e) {
          logger.warn(`Error parsing consensus report data: ${e}`);
        }

        // Remove duplicates from citations
        citationIds = [...new Set(citationIds)];

        // Add citation references to content
        if (citationIds.length > 0) {
          contentHtml += `\n<h4>Referenced Comments</h4>`;
          contentHtml += `<p>This analysis references ${
            citationIds.length
          } comments: [${citationIds.join(", ")}]</p>`;
          contentHtml += `<p><em>Full comment details and voting patterns available at: <a href="${link}">View Full Report</a></em></p>`;
        }

        return `
        <item>
          <title><![CDATA[${title}]]></title>
          <description><![CDATA[${contentHtml}]]></description>
          <link>${link}</link>
          <guid>${guid}</guid>
          <pubDate>${pubDate}</pubDate>
          <category>consensus</category>
          <source>model:${model}</source>
        </item>`;
      })
      .join("\n");

    const rssContent = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0">
  <channel>
    <title>Pol.is Consensus Updates - Report ${requestReportId}</title>
    <description>Cross-group consensus changes and updates for conversation ${requestReportId}</description>
    <link>https://pol.is/report/${requestReportId}</link>
    <lastBuildDate>${new Date().toUTCString()}</lastBuildDate>
    <generator>Pol.is RSS Generator</generator>
    <language>en-us</language>
    ${rssItems}
  </channel>
</rss>`;

    res.set("Content-Type", "application/rss+xml");
    res.send(rssContent);
  } catch (err: any) {
    logger.error(`Error generating consensus feed: ${err.message}`);
    res.status(500).set("Content-Type", "application/rss+xml").send(`
      <?xml version="1.0" encoding="UTF-8"?>
      <rss version="2.0">
        <channel>
          <title>Error</title>
          <description>Error generating consensus feed: ${err.message}</description>
        </channel>
      </rss>
    `);
  }
}

/**
 * Handler for topics hierarchy RSS feed
 */
export async function handle_GET_topics_feed(req: Request, res: Response) {
  const requestReportId = req.params.reportId;

  if (!requestReportId) {
    return res.status(400).set("Content-Type", "application/rss+xml").send(`
      <?xml version="1.0" encoding="UTF-8"?>
      <rss version="2.0">
        <title>Error</title>
        <description>report_id is required</description>
      </rss>
    `);
  }

  try {
    // Validate report exists
    const zid = await getZidFromReport(requestReportId);
    if (zid === null || zid === undefined) {
      return res.status(404).set("Content-Type", "application/rss+xml").send(`
        <?xml version="1.0" encoding="UTF-8"?>
        <rss version="2.0">
          <channel>
            <title>Report Not Found</title>
            <description>Report ${requestReportId} not found</description>
          </channel>
        </rss>
      `);
    }

    // Fetch topic data from the same endpoint that CommentsReport uses
    const topicsTableName = "Delphi_CommentClustersLLMTopicNames";
    const conversationId = zid.toString();

    logger.info(`Fetching topics for conversation_id: ${conversationId}`);

    // Query the topics table
    const allItems: any[] = [];
    let lastEvaluatedKey;

    do {
      const topicsParams: any = {
        TableName: topicsTableName,
        KeyConditionExpression: "conversation_id = :cid",
        ExpressionAttributeValues: { ":cid": conversationId },
        ExclusiveStartKey: lastEvaluatedKey,
      };

      const topicsResult = await docClient.send(new QueryCommand(topicsParams));
      if (topicsResult.Items) {
        allItems.push(...topicsResult.Items);
      }
      lastEvaluatedKey = topicsResult.LastEvaluatedKey;
    } while (lastEvaluatedKey);

    if (allItems.length === 0) {
      return res.set("Content-Type", "application/rss+xml").send(`
        <?xml version="1.0" encoding="UTF-8"?>
        <rss version="2.0">
          <channel>
            <title>Pol.is Topic Hierarchy - Report ${requestReportId}</title>
            <description>No topics available yet for conversation ${requestReportId}</description>
            <link>https://pol.is/report/${requestReportId}</link>
            <lastBuildDate>${new Date().toUTCString()}</lastBuildDate>
          </channel>
        </rss>
      `);
    }

    // Group by runs (model + date) like the delphi.ts endpoint does
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

    // Get the most recent run
    const sortedRunKeys = Object.keys(runGroups).sort((a, b) => {
      const runA = runGroups[a][0];
      const runB = runGroups[b][0];
      const dateA = new Date(runA.created_at || 0);
      const dateB = new Date(runB.created_at || 0);
      return dateB.getTime() - dateA.getTime();
    });

    if (sortedRunKeys.length === 0) {
      return res.set("Content-Type", "application/rss+xml").send(`
        <?xml version="1.0" encoding="UTF-8"?>
        <rss version="2.0">
          <channel>
            <title>Pol.is Topic Hierarchy - Report ${requestReportId}</title>
            <description>No topic runs available for conversation ${requestReportId}</description>
          </channel>
        </rss>
      `);
    }

    // Process the most recent run
    const latestRunKey = sortedRunKeys[0];
    const latestRunItems = runGroups[latestRunKey];

    // Group by layers
    const topicsByLayer: Record<string, Record<string, any>> = {};
    latestRunItems.forEach((item) => {
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

    // Create RSS items for each individual topic
    const rssItems: string[] = [];

    Object.keys(topicsByLayer)
      .sort((a, b) => parseInt(a) - parseInt(b)) // Sort layers numerically (0, 1, 2...)
      .forEach((layer) => {
        const layerClusters = topicsByLayer[layer];

        Object.entries(layerClusters).forEach(([clusterId, topic]) => {
          const topicData = topic as any;
          const title = topicData.topic_name || `Topic ${clusterId}`;
          const pubDate = new Date(topicData.created_at).toUTCString();
          const guid = `${requestReportId}-${layer}-${clusterId}-${topicData.created_at}`;
          const link = `https://pol.is/report/${requestReportId}#topic-${layer}-${clusterId}`;

          rssItems.push(`
        <item>
          <title><![CDATA[${title}]]></title>
          <description></description>
          <link>${link}</link>
          <guid>${guid}</guid>
          <pubDate>${pubDate}</pubDate>
          <category>layer-${layer}</category>
          <custom:layer>${layer}</custom:layer>
          <custom:cluster>${clusterId}</custom:cluster>
        </item>`);
        });
      });

    const rssItemsString = rssItems.join("\n");

    const rssContent = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:custom="https://pol.is/rss/custom">
  <channel>
    <title>Pol.is Topic Hierarchy - Report ${requestReportId}</title>
    <description>Hierarchical clustering results and topic organization for conversation ${requestReportId}</description>
    <link>https://pol.is/report/${requestReportId}</link>
    <lastBuildDate>${new Date().toUTCString()}</lastBuildDate>
    <generator>Pol.is Delphi RSS Generator</generator>
    <language>en-us</language>
    ${rssItemsString}
  </channel>
</rss>`;

    res.set("Content-Type", "application/rss+xml");
    res.send(rssContent);
  } catch (err: any) {
    logger.error(`Error generating topics feed: ${err.message}`);
    res.status(500).set("Content-Type", "application/rss+xml").send(`
      <?xml version="1.0" encoding="UTF-8"?>
      <rss version="2.0">
        <channel>
          <title>Error</title>
          <description>Error generating topics feed: ${err.message}</description>
        </channel>
      </rss>
    `);
  }
}
