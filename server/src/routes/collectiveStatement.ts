import { Request, Response } from "express";
import logger from "../utils/logger";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  DynamoDBDocumentClient,
  PutCommand,
  GetCommand,
  QueryCommand,
} from "@aws-sdk/lib-dynamodb";
import { getZidFromReport } from "../utils/parameter";
import Config from "../config";
import Anthropic from "@anthropic-ai/sdk";
import { v4 as uuidv4 } from "uuid";
import pgQuery from "../db/pg-query";

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

const anthropic = Config.anthropicApiKey
  ? new Anthropic({
      apiKey: Config.anthropicApiKey,
    })
  : null;

/**
 * Generate a collective statement for a topic using Claude
 */
async function generateCollectiveStatement(
  zid: number,
  topicKey: string,
  topicName: string,
  commentsData: any
): Promise<any> {
  if (!anthropic) {
    throw new Error("Anthropic API key not configured");
  }

  // Format comments data for the XML prompt
  const formattedComments = commentsData.map((comment: any) => ({
    comment_id: comment.comment_id,
    comment_text: comment.comment_text,
    voters_who_agreed_with_comment_text: comment.agrees || 0,
    voters_who_disagreed_with_comment_text: comment.disagrees || 0,
    voters_who_clicked_pass_instead_of_agree_or_disagree_on_comment_text:
      comment.passes || 0,
    total_voters_on_comment_text: comment.total_votes || 0,
    group_consensus_on_comment_text: comment.group_consensus || null,
  }));

  // Build the XML prompt
  const systemPrompt = `You are a professional facilitator analyzing voting patterns across different participant groups. Your primary focus is on understanding how different groups voted on comments - looking for patterns of agreement within and between groups. Use the voting data to identify shared perspectives and create collective statements that reflect the actual voting consensus.`;

  const userPrompt = `<task>
Analyze the voting patterns in this topic to write a collective statement. 

IMPORTANT CONTEXT: All comments provided have already been filtered to meet strict criteria:
- Each has ≥80% consensus (normalized group-aware consensus)
- Each has ≥5% participation from EVERY group
- These represent the highest consensus comments from the topic

Since all comments already meet high consensus thresholds, focus on synthesizing them into a coherent statement rather than filtering further.

CRITICAL WRITING RULES:
- Write ONLY in first person plural ("We found consensus on...", "We agree...", "We support...")
- NEVER say "of participants", "of those voting", "of those who expressed an opinion"
- DO NOT include percentages or voting statistics in the text
- DO NOT qualify statements with voting data
- Trust that only high-consensus comments are being provided
- Let the citations [number] handle the reference to specific data
- Maintain the collective voice throughout - write as if everyone agrees because this is a candidate statement supported by votes that are transparently available

GOOD: "We strongly believe cities should include nature in their designs[81]"
BAD: "97% of participants believe cities should include nature[81]"
BAD: "We believe cities should include nature, with 97% agreeing[81]"

Base your analysis on the voting data, but express the results as collective statements without the statistics. Ensure results match the statistics however, as they should align with voters_who_agreed_with_comment_text, voters_who_disagreed_with_comment_text, and voters_who_clicked_pass_instead_of_agree_or_disagree values. This alignment is the most critically important result. Double check your work.
</task>

<topic>
${topicName}
</topic>

<data>
${JSON.stringify(formattedComments, null, 2)}
</data>

<instructions>
- Focus on comments with high agreement rates (more agrees than disagrees)
- Write 2-3 paragraphs that synthesize the consensus views
- Each claim must be supported by specific comment citations
- Be inclusive of different perspectives while highlighting common ground
- Keep the tone constructive and forward-looking
</instructions>

<responseFormat>
<condensedJSONSchema>
{
  "id": "collective_statement",
  "title": "Collective Statement: ${topicName}",
  "paragraphs": [
    {
      "id": "string", // e.g. "shared_values"
      "title": "string", // e.g. "Our Shared Values"
      "sentences": [
        {
          "clauses": [
            {
              "text": "string", // The actual text content
              "citations": [123] // Required: ID of the comment
            }
          ]
        }
      ]
    }
  ]
}
</condensedJSONSchema>
</responseFormat>

You MUST respond with valid JSON that follows the exact schema above. Each clause must have at least one citation.`;

  try {
    const response = await anthropic.messages.create({
      model: "claude-opus-4-20250514",
      max_tokens: 3000,
      temperature: 0.7,
      system: systemPrompt,
      messages: [
        {
          role: "user",
          content: userPrompt,
        },
        {
          role: "assistant",
          content: "{",
        },
      ],
    });

    // Parse the JSON response
    const responseText =
      "{" +
      (response.content[0].type === "text" ? response.content[0].text : "");

    try {
      const statementData = JSON.parse(responseText);

      // Return both the structured data and the original comments for citation display
      return {
        statementData,
        commentsData: formattedComments,
      };
    } catch (parseError) {
      logger.error(`Error parsing Claude response: ${parseError}`);
      logger.error(`Response text: ${responseText.substring(0, 500)}...`);

      // Fallback: If JSON parsing fails, return a simple text response
      return {
        statementData: {
          id: "collective_statement",
          title: `Collective Statement: ${topicName}`,
          paragraphs: [
            {
              id: "fallback",
              title: "Generated Statement",
              sentences: [
                {
                  clauses: [
                    {
                      text: responseText,
                      citations: [],
                    },
                  ],
                },
              ],
            },
          ],
        },
        commentsData: formattedComments,
      };
    }
  } catch (error) {
    logger.error(`Error generating collective statement: ${error}`);
    throw error;
  }
}

/**
 * Handler for POST /api/v3/collectiveStatement
 */
export async function handle_POST_collectiveStatement(
  req: Request,
  res: Response
) {
  logger.info("CollectiveStatement API request received");

  const { report_id, topic_key, topic_name, qualifying_tids } = req.body;

  if (!report_id || !topic_key || !topic_name) {
    return res.status(400).json({
      status: "error",
      message: "report_id, topic_key, and topic_name are required",
    });
  }

  try {
    if (!req.p.delphiEnabled) {
      throw new Error("Unauthorized");
    }
    const zid = await getZidFromReport(report_id);
    if (!zid) {
      return res.status(404).json({
        status: "error",
        message: "Could not find conversation for report_id",
      });
    }

    // Generate unique key for this statement
    const statementKey = `${zid}#${topic_key}#${uuidv4()}`;

    // Get comments for this topic with voting data
    const topicComments = await getCommentsForTopic(zid, topic_key);

    logger.info(
      `Found ${topicComments.length} comments for topic ${topic_key}`
    );

    if (topicComments.length === 0) {
      return res.json({
        status: "error",
        message: "No comments found for this topic",
      });
    }

    // Filter comments based on client-side validation
    const groupConsensus = req.body.group_consensus;
    let filteredComments = topicComments;

    if (qualifying_tids && qualifying_tids.length > 0) {
      // Use the pre-filtered qualifying comment IDs from the client
      // These have already passed the 0.8 consensus threshold and 5% group participation requirement
      const qualifyingSet = new Set(qualifying_tids);
      filteredComments = topicComments.filter((comment) =>
        qualifyingSet.has(comment.comment_id)
      );

      // Add group consensus to filtered comments
      filteredComments = filteredComments.map((comment) => ({
        ...comment,
        group_consensus: groupConsensus[comment.comment_id] || 0,
      }));

      // Sort by group consensus (descending) to prioritize highest consensus comments
      filteredComments.sort((a, b) => b.group_consensus - a.group_consensus);

      logger.info(
        `Using ${filteredComments.length} pre-qualified comments from client (from ${topicComments.length} total)`
      );

      if (filteredComments.length > 0) {
        logger.info(
          `Consensus range: ${filteredComments[0].group_consensus.toFixed(
            3
          )} to ${filteredComments[
            filteredComments.length - 1
          ].group_consensus.toFixed(3)}`
        );
      }

      // Validate minimum comment requirement (should match client-side threshold)
      const MIN_COMMENTS = 3;
      if (filteredComments.length < MIN_COMMENTS) {
        return res.json({
          status: "error",
          message: `Not enough qualifying comments. Need at least ${MIN_COMMENTS} comments with ≥0.8 consensus and ≥5% participation from every group. Only ${filteredComments.length} qualify.`,
        });
      }
    } else if (groupConsensus && Object.keys(groupConsensus).length > 0) {
      // Fallback to old logic if no qualifying_tids provided (for backwards compatibility)
      logger.warn(`No qualifying_tids provided, using legacy filtering logic`);

      // Add group consensus to each comment
      filteredComments = topicComments.map((comment) => ({
        ...comment,
        group_consensus: groupConsensus[comment.comment_id] || 0,
      }));

      // Filter out comments with less than 20 votes
      filteredComments = filteredComments.filter((c) => c.total_votes >= 20);

      // Sort by group consensus (descending)
      filteredComments.sort((a, b) => b.group_consensus - a.group_consensus);

      // Take top quartile
      const quartileSize = Math.ceil(filteredComments.length / 4);
      filteredComments = filteredComments.slice(0, quartileSize);

      logger.info(
        `Filtered from ${topicComments.length} to ${filteredComments.length} comments (min 20 votes, top quartile by consensus)`
      );
    }

    // Generate the collective statement
    const result = await generateCollectiveStatement(
      zid,
      topic_key,
      topic_name,
      filteredComments
    );

    // Store in DynamoDB
    const item = {
      zid_topic_jobid: statementKey,
      zid: zid.toString(),
      topic_key: topic_key,
      topic_name: topic_name,
      statement_data: JSON.stringify(result.statementData),
      comments_data: JSON.stringify(result.commentsData),
      created_at: new Date().toISOString(),
      model: "claude-opus-4-20250514",
    };

    await docClient.send(
      new PutCommand({
        TableName: "Delphi_CollectiveStatement",
        Item: item,
      })
    );

    return res.json({
      status: "success",
      statementData: result.statementData,
      commentsData: result.commentsData,
      id: statementKey,
    });
  } catch (err: any) {
    logger.error(`Error in handle_POST_collectiveStatement: ${err.message}`);
    logger.error(`Error stack: ${err.stack}`);

    return res.status(500).json({
      status: "error",
      message: "Error generating collective statement",
      error: err.message,
    });
  }
}

/**
 * Handler for GET /api/v3/collectiveStatement
 * Can get a single statement by ID or all statements for a report
 */
export async function handle_GET_collectiveStatement(
  req: Request,
  res: Response
) {
  const { statement_id, report_id } = req.query;

  // If report_id is provided, get all statements for that conversation
  if (report_id) {
    try {
      const zid = await getZidFromReport(report_id as string);
      if (!zid) {
        return res.status(404).json({
          status: "error",
          message: "Could not find conversation for report_id",
        });
      }

      // Query all items where zid matches
      const params = {
        TableName: "Delphi_CollectiveStatement",
        IndexName: "zid-created_at-index",
        KeyConditionExpression: "zid = :zid",
        ExpressionAttributeValues: {
          ":zid": zid.toString(),
        },
      };

      const statements: any[] = [];
      let lastEvaluatedKey;

      do {
        const command: any = {
          ...params,
          ExclusiveStartKey: lastEvaluatedKey,
        };

        const data = await docClient.send(new QueryCommand(command));
        if (data.Items) {
          statements.push(...data.Items);
        }
        lastEvaluatedKey = data.LastEvaluatedKey;
      } while (lastEvaluatedKey);

      // Deduplicate by layer_cluster - keep only the most recent statement for each topic
      const deduplicated = new Map();
      statements.forEach((stmt) => {
        // Extract layer_cluster from topic_key (e.g., "0_5" or from topic_name like "0_5: Topic Name")
        let layerCluster = null;

        // Try to extract from topic_key first
        if (stmt.topic_key) {
          // Handle both formats: "uuid#0#5" or "0_5"
          if (stmt.topic_key.includes("#")) {
            const parts = stmt.topic_key.split("#");
            if (parts.length >= 3) {
              layerCluster = `${parts[1]}_${parts[2]}`;
            }
          } else if (stmt.topic_key.includes("_")) {
            layerCluster = stmt.topic_key;
          }
        }

        // Fallback: try to extract from topic_name (e.g., "0_5: Topic Name")
        if (!layerCluster && stmt.topic_name) {
          const match = stmt.topic_name.match(/^(\d+_\d+):/);
          if (match) {
            layerCluster = match[1];
          }
        }

        if (layerCluster) {
          // Keep the most recent statement for this layer_cluster
          if (
            !deduplicated.has(layerCluster) ||
            new Date(stmt.created_at) >
              new Date(deduplicated.get(layerCluster).created_at)
          ) {
            deduplicated.set(layerCluster, stmt);
          }
        } else {
          // If we can't extract layer_cluster, keep the statement with full key
          deduplicated.set(stmt.zid_topic_jobid, stmt);
        }
      });

      const uniqueStatements = Array.from(deduplicated.values());

      // Parse the JSON data in each unique statement
      const parsedStatements = uniqueStatements.map((stmt) => ({
        ...stmt,
        statement_data: stmt.statement_data
          ? JSON.parse(stmt.statement_data)
          : null,
        comments_data: stmt.comments_data
          ? JSON.parse(stmt.comments_data)
          : null,
      }));

      return res.json({
        status: "success",
        statements: parsedStatements,
        count: parsedStatements.length,
      });
    } catch (err: any) {
      logger.error(`Error getting statements for report: ${err.message}`);
      return res.status(500).json({
        status: "error",
        message: "Error retrieving collective statements",
        error: err.message,
      });
    }
  }

  // Original single statement logic
  if (!statement_id) {
    return res.status(400).json({
      status: "error",
      message: "statement_id or report_id is required",
    });
  }

  try {
    const result = await docClient.send(
      new GetCommand({
        TableName: "Delphi_CollectiveStatement",
        Key: {
          zid_topic_jobid: statement_id as string,
        },
      })
    );

    if (!result.Item) {
      return res.status(404).json({
        status: "error",
        message: "Statement not found",
      });
    }

    return res.json({
      status: "success",
      statement: result.Item,
    });
  } catch (err: any) {
    logger.error(`Error in handle_GET_collectiveStatement: ${err.message}`);

    return res.status(500).json({
      status: "error",
      message: "Error retrieving collective statement",
      error: err.message,
    });
  }
}

// Helper function to get comments for a specific topic
async function getCommentsForTopic(
  zid: number,
  topicKey: string
): Promise<any[]> {
  try {
    // First, get comment IDs assigned to this topic from DynamoDB
    const conversation_id = zid.toString();

    // Parse topic key to get layer and cluster
    let layer: number, cluster: number;

    if (topicKey.includes("#")) {
      // New format: uuid#layer#cluster
      const parts = topicKey.split("#");
      if (parts.length >= 3) {
        layer = parseInt(parts[1]);
        cluster = parseInt(parts[2]);
      } else {
        throw new Error(`Invalid topic key format: ${topicKey}`);
      }
    } else if (topicKey.includes("_")) {
      // Old format: layer0_5
      const parts = topicKey.split("_");
      if (parts.length >= 2 && parts[0].startsWith("layer")) {
        layer = parseInt(parts[0].replace("layer", ""));
        cluster = parseInt(parts[1]);
      } else {
        throw new Error(`Invalid topic key format: ${topicKey}`);
      }
    } else {
      throw new Error(`Invalid topic key format: ${topicKey}`);
    }

    // Query DynamoDB for comment assignments
    const assignmentsParams = {
      TableName: "Delphi_CommentHierarchicalClusterAssignments",
      KeyConditionExpression: "conversation_id = :cid",
      ExpressionAttributeValues: {
        ":cid": conversation_id,
      },
    };

    const allAssignments: any[] = [];
    let lastEvaluatedKey;

    do {
      const params: any = {
        ...assignmentsParams,
        ExclusiveStartKey: lastEvaluatedKey,
      };

      const data = await docClient.send(new QueryCommand(params));
      if (data.Items) {
        allAssignments.push(...data.Items);
      }
      lastEvaluatedKey = data.LastEvaluatedKey;
    } while (lastEvaluatedKey);

    // Log first assignment to see structure
    if (allAssignments.length > 0) {
      logger.info(
        `Sample assignment structure: ${JSON.stringify(allAssignments[0])}`
      );
    }

    // Filter comments for this specific topic
    const commentIds: number[] = [];
    allAssignments.forEach((assignment) => {
      const clusterId = assignment[`layer${layer}_cluster_id`];
      // Convert to number for comparison since cluster is a number
      if (clusterId !== undefined && parseInt(clusterId) === cluster) {
        commentIds.push(parseInt(assignment.comment_id));
      }
    });

    logger.info(
      `Topic ${topicKey} - Layer: ${layer}, Cluster: ${cluster}, Found ${commentIds.length} comment assignments`
    );

    // Debug: Log the comment IDs found
    if (commentIds.length > 0) {
      logger.info(
        `Comment IDs for topic ${topicKey}: ${JSON.stringify(
          commentIds.slice(0, 20)
        )}`
      );
    }

    if (commentIds.length === 0) {
      return [];
    }

    // Get full comment data with voting information
    const commentsQuery = `
      SELECT 
        c.tid as comment_id,
        c.txt as comment_text,
        COALESCE(COUNT(DISTINCT v.pid), 0) as total_votes,
        COALESCE(SUM(CASE WHEN v.vote = 1 THEN 1 ELSE 0 END), 0) as disagrees,
        COALESCE(SUM(CASE WHEN v.vote = -1 THEN 1 ELSE 0 END), 0) as agrees,
        COALESCE(SUM(CASE WHEN v.vote = 0 THEN 1 ELSE 0 END), 0) as passes
      FROM comments c
      LEFT JOIN votes_latest_unique v ON c.tid = v.tid AND c.zid = v.zid
      WHERE c.zid = $1 AND c.tid = ANY($2::int[])
      GROUP BY c.tid, c.txt
      ORDER BY total_votes DESC
    `;

    const commentsData = (await pgQuery.queryP(commentsQuery, [
      zid,
      commentIds,
    ])) as any[];

    // Debug: Log the results
    logger.info(
      `SQL query returned ${commentsData.length} comments for topic ${topicKey}`
    );
    if (commentsData.length !== commentIds.length) {
      logger.warn(
        `Mismatch: Found ${commentIds.length} comment IDs in DynamoDB but only ${commentsData.length} in PostgreSQL`
      );
    }

    // Return comments with basic voting data
    // Group-level analysis would require participant_group_associations table which doesn't exist yet
    return commentsData;
  } catch (error) {
    logger.error(`Error getting comments for topic: ${error}`);
    throw error;
  }
}
