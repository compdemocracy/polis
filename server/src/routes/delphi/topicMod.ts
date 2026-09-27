import { Request, Response } from "express";
import logger from "../../utils/logger";
import { DynamoDBClient, DynamoDBClientConfig } from "@aws-sdk/client-dynamodb";
import {
  DynamoDBDocumentClient,
  QueryCommand,
  UpdateCommand,
} from "@aws-sdk/lib-dynamodb";
import Config from "../../config";
import p from "../../db/pg-query";
import { getClusterAssignmentsSimple } from "../../utils/commentClusters";
import { isModerator } from "../../utils/common";
import { failJson } from "../../utils/fail";

// DynamoDB configuration (reuse from topics.ts)
const dynamoDBConfig: DynamoDBClientConfig = {
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

/**
 * Two of the tables this file reads have never existed in any environment.
 *
 * `delphi/create_dynamodb_tables.py` — the bootstrap the Delphi container runs
 * on every start, and the only thing that creates Delphi tables locally —
 * defines eighteen tables, and neither of these is among them. Nothing in
 * `delphi/` writes them either, so no pipeline has ever produced their data.
 * The deployed account holds the same eighteen plus `report_narrative_store`;
 * a read-only `list-tables` confirms both names are absent there too.
 *
 * They are not a rename of a live table: `Delphi_CommentClusters` is queried on
 * (conversation_id, topic_key) with `comment_text`/`umap_x`/`umap_y` attributes,
 * and no existing table has that key or shape. The comparable live data is
 * assembled instead from `Delphi_CommentClustersLLMTopicNames` (topic_key ->
 * layer_id/cluster_id) plus `Delphi_CommentHierarchicalClusterAssignments`
 * (comment_id -> per-layer cluster), the way `nextComment.ts` and
 * `handle_GET_topicMod_proximity` below already do it. So this is a feature
 * that was written against a storage design that was never built, not drift.
 *
 * Until it is either built out or removed (see the P-034 notes), every read of
 * these two names raises ResourceNotFoundException on every call. Handle that
 * explicitly: degrade where the route has real content of its own to return,
 * and answer with a stable error code where it does not. Never surface the raw
 * AWS message, and never let the missing table discard work that Postgres
 * could have accepted.
 */
const TOPIC_MODERATION_STATUS_TABLE = "Delphi_TopicModerationStatus";
const TOPIC_COMMENT_CLUSTERS_TABLE = "Delphi_CommentClusters";

function isResourceNotFoundException(err: unknown): boolean {
  return (
    !!err &&
    typeof err === "object" &&
    "name" in err &&
    (err as { name?: string }).name === "ResourceNotFoundException"
  );
}

/**
 * Answer a request that depends on one of the absent stores.
 *
 * Deliberately not `failJson`: that helper logs at error, and these tables are
 * absent on every call, so it would emit an error event per request for a
 * condition that is known, permanent and already described here. The store
 * being unbuilt is not an incident. The response body keeps `failJson`'s shape
 * so callers see one error contract, and the hint stays product-facing — the
 * table names belong in the log line and the P-034 notes, not in an admin
 * console.
 */
function failMissingStore(
  res: Response,
  clientVisibleErrorString: string,
  logDetail: string,
  additionalData: Record<string, unknown>
) {
  logger.warn(`${clientVisibleErrorString}: ${logDetail}`);
  return res.status(503).json({
    error: clientVisibleErrorString,
    message: clientVisibleErrorString,
    status: 503,
    ...additionalData,
  });
}

/**
 * GET /api/v3/topicMod/topics
 * Retrieves topics with moderation status
 */
export async function handle_GET_topicMod_topics(req: Request, res: Response) {
  try {
    const job_id = req.query.job_id as string;
    const zid = req.p.zid as number;
    const conversation_zid = zid.toString();
    logger.info(`Fetching TopicMod topics for zid: ${conversation_zid}`);

    // Query topics from existing table
    const topicsParams = {
      TableName: "Delphi_CommentClustersLLMTopicNames",
      KeyConditionExpression: "conversation_id = :cid",
      ExpressionAttributeValues: {
        ":cid": conversation_zid,
      },
    };

    // Filter by job_id if provided
    if (job_id) {
      topicsParams.KeyConditionExpression +=
        " AND begins_with(topic_key, :job_id)";
      topicsParams.ExpressionAttributeValues[":job_id"] = `${job_id}#`;
    }

    const topicsData = await docClient.send(new QueryCommand(topicsParams));

    if (!topicsData.Items || topicsData.Items.length === 0) {
      return res.json({
        status: "success",
        message: "No topics found for this conversation",
        topics: [],
      });
    }

    // Query moderation status for each topic. The topics themselves come from a
    // live table, so a failure here must not take the list down with it: the
    // status decorates the response, it is not the response.
    const moderationParams = {
      TableName: TOPIC_MODERATION_STATUS_TABLE,
      KeyConditionExpression: "conversation_id = :cid",
      ExpressionAttributeValues: {
        ":cid": conversation_zid,
      },
    };

    let moderationData;
    let moderationAvailable = true;
    try {
      moderationData = await docClient.send(new QueryCommand(moderationParams));
    } catch (err: unknown) {
      moderationAvailable = false;
      moderationData = { Items: [] };
      if (isResourceNotFoundException(err)) {
        logger.warn(
          `Topic moderation status unavailable: ${TOPIC_MODERATION_STATUS_TABLE} does not exist; reporting every topic as pending`
        );
      } else {
        const message = err instanceof Error ? err.message : String(err);
        logger.warn(
          `Topic moderation status lookup failed, reporting every topic as pending: ${message}`
        );
      }
    }

    // Create moderation status map
    const moderationMap = new Map();
    moderationData.Items?.forEach((item) => {
      moderationMap.set(item.topic_key, {
        status: item.moderation_status,
        moderator: item.moderator,
        moderated_at: item.moderated_at,
        comment_count: item.comment_count || 0,
      });
    });

    // Combine topics with moderation status
    type ModerationInfo = {
      status: string;
      moderator: unknown;
      moderated_at: unknown;
      comment_count: number;
    };
    type TopicWithStatus = {
      topic_name: string;
      model_name?: string;
      created_at?: unknown;
      topic_key: string;
      layer_id?: string;
      cluster_id?: string;
      moderation: ModerationInfo;
    };

    const topicsWithStatus: TopicWithStatus[] = topicsData.Items.map(
      (topic) => {
        const moderation = moderationMap.get(topic.topic_key) || {
          status: "pending",
          moderator: null,
          moderated_at: null,
          comment_count: 0,
        };

        return {
          topic_name: topic.topic_name,
          model_name: topic.model_name,
          created_at: topic.created_at,
          topic_key: topic.topic_key,
          layer_id: topic.layer_id,
          cluster_id: topic.cluster_id,
          moderation: moderation,
        };
      }
    );

    // Group by layer for hierarchical display
    const topicsByLayer: Record<string, TopicWithStatus[]> = {};
    topicsWithStatus.forEach((topic) => {
      const layerId = topic.layer_id || "0";
      if (!topicsByLayer[layerId]) {
        topicsByLayer[layerId] = [];
      }
      topicsByLayer[layerId].push(topic);
    });

    // Sort topics within each layer by cluster_id
    Object.keys(topicsByLayer).forEach((layerId) => {
      topicsByLayer[layerId].sort((a, b) => {
        return parseInt(a.cluster_id || "0") - parseInt(b.cluster_id || "0");
      });
    });

    return res.json({
      status: "success",
      message: "Topics retrieved successfully",
      topics_by_layer: topicsByLayer,
      total_topics: topicsWithStatus.length,
      // False means the per-topic `moderation` blocks are placeholders, not
      // read state: no caller should present "pending" as a recorded decision.
      moderation_available: moderationAvailable,
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error(`Error in handle_GET_topicMod_topics: ${message}`);
    return res.json({
      status: "error",
      message: "Error retrieving topics",
      error: message,
    });
  }
}

/**
 * GET /api/v3/topicMod/topics/:topicKey/comments
 * Retrieves comments for a specific topic
 */
export async function handle_GET_topicMod_comments(
  req: Request,
  res: Response
) {
  try {
    const topic_key = req.params.topicKey;

    if (!topic_key) {
      return res.json({
        status: "error",
        message: "topic_key is required",
      });
    }

    const zid = req.p.zid as number;
    const comment_conversation_id = zid.toString();
    logger.info(
      `Fetching comments for topic ${topic_key} in conversation ${comment_conversation_id}`
    );

    // Query comments from topic clusters table
    const params = {
      TableName: TOPIC_COMMENT_CLUSTERS_TABLE,
      KeyConditionExpression: "conversation_id = :cid AND topic_key = :tk",
      ExpressionAttributeValues: {
        ":cid": comment_conversation_id,
        ":tk": topic_key,
      },
    };

    let data;
    try {
      data = await docClient.send(new QueryCommand(params));
    } catch (err: unknown) {
      if (isResourceNotFoundException(err)) {
        // This route has no other source of comments, so there is nothing to
        // degrade to. Say so with a stable code rather than reporting an empty
        // topic (which reads as "no comments here") or echoing the raw AWS
        // "Requested resource not found" back to the admin console.
        return failMissingStore(
          res,
          "polis_err_topicMod_comments_store_missing",
          `${TOPIC_COMMENT_CLUSTERS_TABLE} does not exist`,
          {
            hint: "Per-topic comment listing is not available for this conversation.",
          }
        );
      }
      throw err;
    }

    if (!data.Items || data.Items.length === 0) {
      return res.json({
        status: "success",
        message: "No comments found for this topic",
        comments: [],
      });
    }

    // Get comment details from main comments table
    const comments = data.Items.map((item) => ({
      comment_id: item.comment_id,
      comment_text: item.comment_text,
      umap_x: item.umap_x,
      umap_y: item.umap_y,
      cluster_id: item.cluster_id,
      layer_id: item.layer_id,
      moderation_status: item.moderation_status || "pending",
    }));

    return res.json({
      status: "success",
      message: "Comments retrieved successfully",
      comments: comments,
      total_comments: comments.length,
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error(`Error in handle_GET_topicMod_comments: ${message}`);
    return res.json({
      status: "error",
      message: "Error retrieving comments",
      error: message,
    });
  }
}

/**
 * POST /api/v3/topicMod/moderate
 * Applies moderation actions to topics or individual comments
 */
export async function handle_POST_topicMod_moderate(
  req: Request,
  res: Response
) {
  try {
    // Note: any `moderator` field in the request body is deliberately ignored.
    // The acting moderator is derived from the authenticated user only.
    const { topic_key, comment_ids, action } = req.body;

    if (!action) {
      return res.json({
        status: "error",
        message: "action is required",
      });
    }

    if (!["accept", "reject", "meta"].includes(action)) {
      return res.json({
        status: "error",
        message: "action must be 'accept', 'reject', or 'meta'",
      });
    }

    const zid = req.p.zid as number;
    const uid = req.p.uid as number | undefined;

    // Only a conversation owner/site moderator may moderate this conversation.
    const isMod = await isModerator(zid, uid);
    if (!isMod) {
      return failJson(res, 403, "polis_err_topicMod_moderate_auth");
    }

    const moderator = String(uid);
    const moderate_conversation_id = zid.toString();
    const now = new Date().toISOString();

    const moderationStatus =
      action === "accept" ? 1 : action === "reject" ? -1 : 0;
    const isMeta = action === "meta";

    // Count comments this request actually moderated, not ids it was handed.
    // Postgres executes an UPDATE that matches nothing perfectly happily, so a
    // stale, foreign or repeated tid would otherwise be reported as a moderated
    // comment. `RETURNING tid` reports what the `zid`-scoped predicate matched,
    // and the set collapses duplicates and any overlap between the explicit ids
    // and the topic's own comments below.
    const moderatedTids = new Set<number>();

    const applyModeration = async (tid: unknown): Promise<void> => {
      // `modified` is stamped in the same statement as the moderation state.
      // Both math pollers discover moderation only through a strict
      // `modified > watermark` query, and nothing else maintains the column on
      // UPDATE, so a topic moderation that left it alone would be invisible to
      // the engine for any comment already past the watermark. See the same
      // note on `moderateCommentQuery` in `routes/comments.ts`.
      const updated = (await p.queryP(
        "UPDATE comments SET mod = ($1), is_meta = ($2), modified = now_as_millis() WHERE zid = ($3) AND tid = ($4) RETURNING tid",
        [moderationStatus, isMeta, zid, tid]
      )) as Array<{ tid: number }>;
      for (const row of updated || []) {
        moderatedTids.add(Number(row.tid));
      }
    };

    // Explicit comment ids are backed entirely by Postgres, so apply them
    // first. The topic branch below reads two tables that do not exist; doing
    // it first meant a request carrying both lost the ids it could have
    // applied, exactly the failure #2707 removed from the topic-agenda writes.
    const requestedIds: unknown[] =
      comment_ids && Array.isArray(comment_ids) ? comment_ids : [];
    if (requestedIds.length > 0) {
      logger.info(
        `Moderating ${requestedIds.length} individual comments as ${action}`
      );

      for (const comment_id of requestedIds) {
        await applyModeration(comment_id);
      }
    }

    // Ids the caller named that no comment in this conversation matched. Named
    // separately so a partial result is legible rather than a silent shortfall.
    const unmatchedIds = requestedIds.filter(
      (id) => !moderatedTids.has(Number(id))
    );
    if (unmatchedIds.length > 0) {
      logger.warn(
        `Ignored ${unmatchedIds.length} comment id(s) not present in conversation ${zid}`
      );
    }

    // If topic_key is provided, moderate entire topic
    if (topic_key) {
      logger.info(`Moderating entire topic ${topic_key} as ${action}`);

      // Record the topic-level decision. UpdateCommand already upserts, so the
      // only thing a ResourceNotFoundException can mean here is that the table
      // itself is absent — which the previous PutCommand fallback could not fix
      // either, since it wrote to the same missing table and threw again.
      const topicParams = {
        TableName: TOPIC_MODERATION_STATUS_TABLE,
        Key: {
          conversation_id: moderate_conversation_id,
          topic_key: topic_key,
        },
        UpdateExpression:
          "SET moderation_status = :status, moderator = :mod, moderated_at = :time",
        ExpressionAttributeValues: {
          ":status": action,
          ":mod": moderator,
          ":time": now,
        },
        ReturnValues: "ALL_NEW" as const,
      };

      // Enumerate the topic's comments so the decision reaches Postgres too.
      const commentsParams = {
        TableName: TOPIC_COMMENT_CLUSTERS_TABLE,
        KeyConditionExpression: "conversation_id = :cid AND topic_key = :tk",
        ExpressionAttributeValues: {
          ":cid": moderate_conversation_id,
          ":tk": topic_key,
        },
      };

      let commentsData;
      try {
        await docClient.send(new UpdateCommand(topicParams));
        commentsData = await docClient.send(new QueryCommand(commentsParams));
      } catch (err: unknown) {
        if (isResourceNotFoundException(err)) {
          // Neither store exists, so the topic decision was not recorded and
          // its comments could not be enumerated. Report that instead of the
          // "applied successfully" this used to answer with, which told the
          // admin console a moderation had taken effect when none had.
          return failMissingStore(
            res,
            "polis_err_topicMod_moderate_topic_store_missing",
            `${TOPIC_MODERATION_STATUS_TABLE} and ${TOPIC_COMMENT_CLUSTERS_TABLE} do not exist`,
            {
              hint: "Whole-topic moderation is not available for this conversation. Moderate the topic's comments by id instead.",
              comments_moderated: moderatedTids.size,
              unmatched_comment_ids: unmatchedIds,
            }
          );
        }
        throw err;
      }

      for (const comment of commentsData.Items || []) {
        await applyModeration(comment.comment_id);
      }
    }

    return res.json({
      status: "success",
      message: `Moderation action '${action}' applied successfully`,
      moderated_at: now,
      comments_moderated: moderatedTids.size,
      unmatched_comment_ids: unmatchedIds,
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error(`Error in handle_POST_topicMod_moderate: ${message}`);
    return res.json({
      status: "error",
      message: "Error applying moderation action",
      error: message,
    });
  }
}

/**
 * GET /api/v3/topicMod/proximity
 * Retrieves UMAP proximity data for visualization
 */
export async function handle_GET_topicMod_proximity(
  req: Request,
  res: Response
) {
  try {
    const layer_id = (req.query.layer_id as string) || "all";
    const zid = req.p.zid as number;
    const proximity_conversation_id = zid.toString();
    logger.info(
      `Fetching proximity data for conversation ${proximity_conversation_id}, layer ${layer_id}`
    );

    // Get ALL UMAP coordinates from Delphi_UMAPGraph
    // Node positions are stored where source_id = target_id
    const umapParams = {
      TableName: "Delphi_UMAPGraph",
      KeyConditionExpression: "conversation_id = :cid",
      FilterExpression: "source_id = target_id", // Only nodes, not edges
      ExpressionAttributeValues: {
        ":cid": proximity_conversation_id,
      },
    };

    const umapData = await docClient.send(new QueryCommand(umapParams));

    if (!umapData.Items || umapData.Items.length === 0) {
      return res.json({
        status: "success",
        message: "No UMAP coordinates found",
        proximity_data: [],
      });
    }

    logger.info(`Found ${umapData.Items.length} UMAP coordinate points`);

    // If layer_id is "all", return all coordinates with cluster info from all layers
    if (layer_id === "all") {
      // Get ALL cluster assignments for all layers using centralized utility
      const commentToClustersByLayer = await getClusterAssignmentsSimple(zid);

      logger.info(
        `Retrieved cluster assignments for ${commentToClustersByLayer.size} comments`
      );

      // Return ALL comment coordinates with cluster info for all layers
      logger.info(
        `RESPONSE DEBUG: Starting to process ${umapData.Items.length} UMAP items`
      );

      const validUmapItems = umapData.Items.filter((item) => {
        // Filter out items with invalid positions
        const x = item.position?.x;
        const y = item.position?.y;
        const isValid =
          x !== null &&
          x !== undefined &&
          !isNaN(x) &&
          y !== null &&
          y !== undefined &&
          !isNaN(y) &&
          isFinite(x) &&
          isFinite(y);
        return isValid;
      });

      logger.info(
        `RESPONSE DEBUG: ${validUmapItems.length} items have valid UMAP coordinates`
      );

      const proximityData = validUmapItems.map((item, index) => {
        const commentId = item.source_id;
        const clusterInfo = commentToClustersByLayer.get(commentId) || {};

        if (index < 5) {
          logger.info(
            `RESPONSE DEBUG: Processing UMAP item ${index}: comment_id=${commentId}, clusters=${JSON.stringify(
              clusterInfo
            )}`
          );
        }

        const responseItem = {
          comment_id: commentId,
          umap_x: item.position.x,
          umap_y: item.position.y,
          weight: item.weight || 1,
          clusters: clusterInfo, // cluster_id for each layer
        };

        if (index < 3) {
          logger.info(
            `RESPONSE DEBUG: Response item ${index}:`,
            JSON.stringify(responseItem)
          );
        }

        return responseItem;
      });

      // Count how many items actually have cluster assignments
      const itemsWithClusters = proximityData.filter(
        (item) => Object.keys(item.clusters).length > 0
      );
      logger.info(
        `RESPONSE DEBUG: ${itemsWithClusters.length} out of ${proximityData.length} response items have cluster assignments`
      );

      return res.json({
        status: "success",
        message: "All proximity data retrieved successfully",
        proximity_data: proximityData,
        total_points: proximityData.length,
      });
    }

    // If specific layer is requested, filter by that layer
    const clusterParams = {
      TableName: "Delphi_CommentHierarchicalClusterAssignments",
      KeyConditionExpression: "conversation_id = :cid",
      FilterExpression: "layer_id = :lid",
      ExpressionAttributeValues: {
        ":cid": proximity_conversation_id,
        ":lid": parseInt(layer_id),
      },
    };

    const clusterData = await docClient.send(new QueryCommand(clusterParams));

    // Create a map of comment_id to cluster_id for the specified layer
    const commentToCluster = new Map();
    if (clusterData.Items) {
      clusterData.Items.forEach((item) => {
        commentToCluster.set(item.comment_id, item.cluster_id);
      });
    }

    // Filter UMAP coordinates to only include comments in the specified layer
    const proximityData = umapData.Items.filter((item) => {
      const commentId = item.source_id; // For nodes, source_id = target_id = comment_id
      // Check for valid position data
      const x = item.position?.x;
      const y = item.position?.y;
      const hasValidPosition =
        x !== null &&
        x !== undefined &&
        !isNaN(x) &&
        y !== null &&
        y !== undefined &&
        !isNaN(y) &&
        isFinite(x) &&
        isFinite(y);

      return commentToCluster.has(commentId) && hasValidPosition;
    }).map((item) => {
      const commentId = item.source_id;
      const clusterId = commentToCluster.get(commentId);

      return {
        comment_id: commentId,
        cluster_id: clusterId,
        layer_id: parseInt(layer_id),
        umap_x: item.position.x,
        umap_y: item.position.y,
        weight: item.weight || 1,
      };
    });

    return res.json({
      status: "success",
      message: "Proximity data retrieved successfully",
      proximity_data: proximityData,
      total_points: proximityData.length,
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error(`Error in handle_GET_topicMod_proximity: ${message}`);
    return res.json({
      status: "error",
      message: "Error retrieving proximity data",
      error: message,
    });
  }
}

/**
 * GET /api/v3/topicMod/hierarchy
 * Retrieves hierarchical cluster structure for circle pack visualization
 */
export async function handle_GET_topicMod_hierarchy(
  req: Request,
  res: Response
) {
  try {
    const zid = req.p.zid as number;
    const hierarchy_conversation_id = zid.toString();
    logger.info(
      `Fetching hierarchy data for conversation ${hierarchy_conversation_id}`
    );

    // Query cluster structure from DynamoDB
    const params = {
      TableName: "Delphi_CommentClustersStructureKeywords",
      KeyConditionExpression: "conversation_id = :cid",
      ExpressionAttributeValues: {
        ":cid": hierarchy_conversation_id,
      },
    };

    const data = await docClient.send(new QueryCommand(params));

    if (!data.Items || data.Items.length === 0) {
      return res.json({
        status: "success",
        message: "No hierarchy data found",
        hierarchy: null,
      });
    }

    // Process and structure the hierarchy data
    const clusters = data.Items;
    logger.info(`Found ${clusters.length} clusters in DynamoDB`);

    // Debug: log layer distribution
    const layerCounts = {};
    clusters.forEach((cluster) => {
      const layer = cluster.layer_id;
      layerCounts[layer] = (layerCounts[layer] || 0) + 1;
    });
    logger.info(`Layer distribution:`, layerCounts);

    // Debug: log sample clusters from each layer
    Object.keys(layerCounts).forEach((layer) => {
      const sampleCluster = clusters.find(
        (c) => c.layer_id.toString() === layer.toString()
      );
      if (sampleCluster) {
        logger.info(`Sample Layer ${layer} cluster:`, {
          cluster_key: sampleCluster.cluster_key,
          layer_id: sampleCluster.layer_id,
          cluster_id: sampleCluster.cluster_id,
          size: sampleCluster.size,
          has_parent: !!sampleCluster.parent_cluster,
          has_children: !!(
            sampleCluster.child_clusters &&
            sampleCluster.child_clusters.length > 0
          ),
          parent_cluster: sampleCluster.parent_cluster,
          child_clusters: sampleCluster.child_clusters,
        });
      } else {
        logger.error(`No sample cluster found for layer ${layer}`);
      }
    });

    const hierarchyMap = new Map();
    const layers = new Map();

    // First pass: create all nodes
    clusters.forEach((cluster) => {
      const key = cluster.cluster_key;
      const layerId = cluster.layer_id;
      const clusterId = cluster.cluster_id;

      if (!layers.has(layerId)) {
        layers.set(layerId, []);
      }

      const node = {
        id: key,
        name: `Layer ${layerId} Cluster ${clusterId}`,
        layer: layerId,
        clusterId: clusterId,
        size: cluster.size || 0,
        topic_name:
          cluster.topic_name ||
          cluster.llm_topic_name ||
          cluster.keywords_string,
        children: [],
        parentId: null,
        data: cluster,
      };

      hierarchyMap.set(key, node);
      layers.get(layerId).push(node);
    });

    // Second pass: INVERT DynamoDB parent-child relationships for circle pack
    // DynamoDB: Layer 3 has parent Layer 2 (Layer 3 merges INTO Layer 2)
    // Circle pack needs: Layer 2 CONTAINS Layer 3 (Layer 2 is bigger circle containing Layer 3)
    clusters.forEach((cluster) => {
      const key = cluster.cluster_key;
      const node = hierarchyMap.get(key);

      // If this cluster HAS a parent in DynamoDB, make that parent contain THIS cluster as a child
      if (
        cluster.parent_cluster &&
        cluster.parent_cluster.layer_id !== undefined &&
        cluster.parent_cluster.cluster_id !== undefined
      ) {
        const parentKey = `layer${cluster.parent_cluster.layer_id}_${cluster.parent_cluster.cluster_id}`;
        const parentNode = hierarchyMap.get(parentKey);
        if (parentNode) {
          // INVERTED: The "parent" in DynamoDB becomes the container in circle pack
          parentNode.children.push(node);
          node.parentId = parentKey;
        } else {
          logger.warn(`Parent node ${parentKey} not found for child ${key}`);
        }
      }
    });

    // For circle pack: find ALL clusters that have no parents (roots at any level)
    // Some Layer 3, some Layer 2, some Layer 1, and some Layer 0 clusters may be top-level
    // In EVōC: smaller clusters are "parents" of larger (they merge into larger ones)
    // For visualization: we want mixed-level roots showing the true hierarchy
    const roots = Array.from(hierarchyMap.values()).filter(
      (node) => !node.parentId
    );

    // Remove parent references to avoid circular JSON and clean up for D3
    const cleanNode = (node) => {
      const cleaned = {
        id: node.id,
        name: node.name,
        layer: node.layer,
        clusterId: node.clusterId,
        size: node.size,
        topic_name: node.topic_name,
        children: node.children.map(cleanNode),
      };
      return cleaned;
    };

    // Create the hierarchy structure for D3
    const hierarchy = {
      name: "Topics Hierarchy",
      children: roots.map(cleanNode),
      totalClusters: clusters.length,
      layerCounts: Object.fromEntries(
        Array.from(layers.entries()).map(([layerId, nodes]) => [
          layerId,
          nodes.length,
        ])
      ),
    };

    return res.json({
      status: "success",
      message: "Hierarchy data retrieved successfully",
      hierarchy: hierarchy,
      totalClusters: clusters.length,
      layers: Array.from(layers.keys()).sort(),
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error(`Error in handle_GET_topicMod_hierarchy: ${message}`);
    return res.json({
      status: "error",
      message: "Error retrieving hierarchy data",
      error: message,
    });
  }
}

/**
 * GET /api/v3/topicMod/stats
 * Retrieves moderation statistics
 */
export async function handle_GET_topicMod_stats(req: Request, res: Response) {
  try {
    const zid = req.p.zid as number;
    const stats_conversation_id = zid.toString();
    logger.info(
      `Fetching moderation stats for conversation ${stats_conversation_id}`
    );

    // Get moderation status for all topics
    const params = {
      TableName: TOPIC_MODERATION_STATUS_TABLE,
      KeyConditionExpression: "conversation_id = :cid",
      ExpressionAttributeValues: {
        ":cid": stats_conversation_id,
      },
    };

    let data;
    try {
      data = await docClient.send(new QueryCommand(params));
    } catch (err: unknown) {
      if (isResourceNotFoundException(err)) {
        // The store does not exist, so there are no recorded decisions to
        // count. Zeroed counts are the honest answer; `moderation_available`
        // keeps a caller from reading them as "nothing moderated yet".
        logger.warn(
          `Topic moderation stats unavailable: ${TOPIC_MODERATION_STATUS_TABLE} does not exist`
        );
        return res.json({
          status: "success",
          message: "No moderation data available yet",
          moderation_available: false,
          stats: {
            total_topics: 0,
            pending: 0,
            accepted: 0,
            rejected: 0,
            meta: 0,
          },
        });
      }
      throw err;
    }

    // Calculate statistics
    const stats = {
      total_topics: data.Items?.length || 0,
      pending: 0,
      accepted: 0,
      rejected: 0,
      meta: 0,
    };

    data.Items?.forEach((item) => {
      const status = item.moderation_status;
      if (status === "accept") stats.accepted++;
      else if (status === "reject") stats.rejected++;
      else if (status === "meta") stats.meta++;
      else stats.pending++;
    });

    return res.json({
      status: "success",
      message: "Moderation statistics retrieved successfully",
      moderation_available: true,
      stats: stats,
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error(`Error in handle_GET_topicMod_stats: ${message}`);
    return res.json({
      status: "error",
      message: "Error retrieving moderation statistics",
      error: message,
    });
  }
}
