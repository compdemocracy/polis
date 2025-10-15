import pg from "../db/pg-query";
import logger from "./logger";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, QueryCommand } from "@aws-sdk/lib-dynamodb";
import Config from "../config";
import LruCache from "lru-cache";

/**
 * Interface for comment with cluster assignments
 * Note: Cluster layers are dynamic - EVōC determines the number of layers
 * based on the data structure (typically 3-4 layers, but can vary)
 *
 * Cluster IDs can be -1, indicating an outlier/noise point that EVōC could not
 * confidently assign to any cluster at that layer.
 */
export interface CommentWithClusters {
  tid: number;
  txt: string;
  pid: number;
  created: string;
  mod: number;
  active: boolean;
  is_outlier: boolean | null;
  // Dynamic cluster assignments by layer (cluster_id can be -1 for outliers)
  cluster_assignments: Record<string, number>; // e.g., {"0": -1, "1": 2, "2": 0}
  // Distance to centroid for each layer
  distances: Record<string, number>; // e.g., {"0": 0.123, "1": 0.456}
  // Confidence scores for each layer
  confidences: Record<string, number>; // e.g., {"0": 0.95, "1": 0.87}
}

/**
 * DynamoDB cluster assignment item structure
 * Note: layerN_cluster_id fields are dynamic - any number of layers can exist
 */
interface ClusterAssignment {
  conversation_id: string;
  comment_id: number;
  is_outlier?: boolean;
  distance_to_centroid?: Record<string, number>;
  cluster_confidence?: Record<string, number>;
  // Dynamic layer cluster IDs (accessed via indexing)
  [key: string]: string | number | boolean | Record<string, number> | undefined;
}

/**
 * LRU Cache for cluster assignments
 * - Key: zid (conversation ID)
 * - Value: Map<comment_id, ClusterAssignment>
 * - TTL: 5 minutes (configurable via CLUSTER_CACHE_TTL_MS in config)
 * - Max size: 1000 conversations (configurable via CLUSTER_CACHE_MAX_SIZE in config)
 *
 * Used only by nextComment.ts for high-frequency reads where stale data is acceptable.
 * Reports and exports bypass the cache for accuracy.
 */
const clusterAssignmentsCache = new LruCache<
  number,
  Map<number, ClusterAssignment>
>({
  max: 1000, // lru-cache v3 API - just max size
  maxAge: 5 * 60 * 1000, // 5 minutes TTL (lru-cache v3 uses maxAge instead of ttl)
});

/**
 * Initialize DynamoDB client following the pattern from collectiveStatement.ts
 */
function createDynamoDBClient(): DynamoDBDocumentClient {
  const dynamoDBConfig: {
    region: string;
    endpoint?: string;
    credentials?: {
      accessKeyId: string;
      secretAccessKey: string;
    };
  } = {
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
  return DynamoDBDocumentClient.from(client, {
    marshallOptions: {
      convertEmptyValues: true,
      removeUndefinedValues: true,
    },
  });
}

/**
 * Query all cluster assignments from DynamoDB for a conversation
 * Returns a Map of comment_id -> ClusterAssignment for efficient lookups
 *
 * This is the central function that queries Delphi_CommentHierarchicalClusterAssignments.
 * All other functions in this module and other modules should use this or the helper
 * functions below rather than querying DynamoDB directly.
 *
 * @param zid - Conversation ID
 * @param useCache - Whether to use LRU cache (default: false for accuracy)
 *                   Set to true for high-frequency reads where stale data is acceptable (e.g., nextComment)
 * @returns Map of comment_id to cluster assignment data
 */
export async function getClusterAssignments(
  zid: number,
  useCache = false
): Promise<Map<number, ClusterAssignment>> {
  // Check cache if enabled
  if (useCache) {
    const cached = clusterAssignmentsCache.get(zid);
    if (cached) {
      logger.debug(`Cache hit for cluster assignments: conversation ${zid}`);
      return cached;
    }
    logger.debug(`Cache miss for cluster assignments: conversation ${zid}`);
  }
  const docClient = createDynamoDBClient();
  const conversation_id = zid.toString();
  const assignments = new Map<number, ClusterAssignment>();

  try {
    const params = {
      TableName: "Delphi_CommentHierarchicalClusterAssignments",
      KeyConditionExpression: "conversation_id = :cid",
      ExpressionAttributeValues: {
        ":cid": conversation_id,
      },
    };

    let lastEvaluatedKey;

    // Query with pagination
    do {
      const queryParams: {
        TableName: string;
        KeyConditionExpression: string;
        ExpressionAttributeValues: { ":cid": string };
        ExclusiveStartKey?: Record<string, unknown>;
      } = {
        ...params,
        ExclusiveStartKey: lastEvaluatedKey,
      };

      const data = await docClient.send(new QueryCommand(queryParams));

      if (data.Items) {
        for (const item of data.Items) {
          const assignment = item as ClusterAssignment;
          assignments.set(Number(assignment.comment_id), assignment);
        }
      }

      lastEvaluatedKey = data.LastEvaluatedKey;
    } while (lastEvaluatedKey);

    logger.info(
      `Retrieved ${assignments.size} cluster assignments for conversation ${zid}`
    );

    // Store in cache if caching is enabled
    if (useCache && assignments.size > 0) {
      clusterAssignmentsCache.set(zid, assignments);
      logger.debug(`Cached cluster assignments for conversation ${zid}`);
    }

    return assignments;
  } catch (error: unknown) {
    // If table doesn't exist or other DynamoDB error, log and return empty map
    const message = error instanceof Error ? error.message : String(error);
    logger.warn(
      `Could not retrieve cluster assignments for conversation ${zid}: ${message}`
    );
    return assignments;
  }
}

/**
 * Extract all layer-specific cluster IDs from assignment
 * Dynamically detects layers by looking for layerN_cluster_id fields
 *
 * Note: Cluster IDs can be -1, which indicates an outlier (noise point)
 * that EVōC could not confidently assign to any cluster. This is valid
 * data and should be preserved in the output.
 */
function extractClusterAssignments(
  assignment: ClusterAssignment
): Record<string, number> {
  const clusters: Record<string, number> = {};

  // Find all layer cluster ID fields
  for (const key of Object.keys(assignment)) {
    const match = key.match(/^layer(\d+)_cluster_id$/);
    if (match) {
      const layerId = match[1];
      const clusterId = assignment[key];
      // Include all valid cluster IDs, including -1 (outliers)
      if (clusterId !== undefined && clusterId !== null) {
        clusters[layerId] = Number(clusterId);
      }
    }
  }

  return clusters;
}

/**
 * Extract all layer-specific distance values from distance_to_centroid object
 */
function extractDistances(
  distanceObj: Record<string, number> | undefined
): Record<string, number> {
  if (!distanceObj) return {};

  const distances: Record<string, number> = {};
  for (const key of Object.keys(distanceObj)) {
    const match = key.match(/^layer(\d+)$/);
    if (match) {
      const layerId = match[1];
      distances[layerId] = Number(distanceObj[key]);
    }
  }

  return distances;
}

/**
 * Extract all layer-specific confidence values from cluster_confidence object
 */
function extractConfidences(
  confidenceObj: Record<string, number> | undefined
): Record<string, number> {
  if (!confidenceObj) return {};

  const confidences: Record<string, number> = {};
  for (const key of Object.keys(confidenceObj)) {
    const match = key.match(/^layer(\d+)$/);
    if (match) {
      const layerId = match[1];
      confidences[layerId] = Number(confidenceObj[key]);
    }
  }

  return confidences;
}

/**
 * Get all comments for a conversation with their cluster assignments
 *
 * Performance notes:
 * - Uses read-only PostgreSQL pool for better scalability
 * - Queries DynamoDB with pagination to avoid memory issues
 * - Returns all comments (both active and inactive)
 *
 * Future optimization opportunities:
 * 1. Cache cluster assignments in PostgreSQL as a materialized view
 * 2. Store cluster assignments directly in a PostgreSQL table with foreign key
 * 3. Add composite index on (zid, tid) if moving to PostgreSQL
 * 4. Consider adding cluster_updated_at timestamp for incremental updates
 *
 * @param zid - Conversation ID
 * @returns Array of comments with cluster assignments
 */
export async function getCommentsWithClusters(
  zid: number
): Promise<CommentWithClusters[]> {
  logger.info(`Fetching comments with clusters for conversation ${zid}`);

  // Step 1: Get all comments from PostgreSQL
  const comments = (await pg.queryP_readOnly(
    "SELECT tid, txt, pid, created, mod, active FROM comments WHERE zid = ($1) ORDER BY tid",
    [zid]
  )) as Array<{
    tid: number;
    txt: string;
    pid: number;
    created: string;
    mod: number;
    active: boolean;
  }>;

  logger.info(`Retrieved ${comments.length} comments from PostgreSQL`);

  // Step 2: Get cluster assignments from DynamoDB
  const clusterMap = await getClusterAssignments(zid);

  // Step 3: Combine comments with cluster data
  const commentsWithClusters: CommentWithClusters[] = comments.map(
    (comment) => {
      const assignment = clusterMap.get(comment.tid);

      // If no cluster assignment exists, return comment with empty cluster data
      if (!assignment) {
        return {
          ...comment,
          is_outlier: null,
          cluster_assignments: {},
          distances: {},
          confidences: {},
        };
      }

      // Dynamically extract all cluster assignments, distances, and confidences
      return {
        ...comment,
        is_outlier:
          assignment.is_outlier !== undefined ? assignment.is_outlier : null,
        cluster_assignments: extractClusterAssignments(assignment),
        distances: extractDistances(assignment.distance_to_centroid),
        confidences: extractConfidences(assignment.cluster_confidence),
      };
    }
  );

  logger.info(
    `Processed ${commentsWithClusters.length} comments with cluster data`
  );

  return commentsWithClusters;
}

/**
 * Get comment IDs (tids) that belong to a specific cluster at a specific layer
 *
 * @param zid - Conversation ID
 * @param layerId - Layer ID (typically 0-3, but dynamically determined by EVōC)
 * @param clusterId - Cluster ID within that layer
 * @param useCache - Whether to use LRU cache (default: false)
 * @returns Array of comment IDs (tids) in that cluster
 */
export async function getCommentIdsForCluster(
  zid: number,
  layerId: number,
  clusterId: number,
  useCache = false
): Promise<number[]> {
  const assignments = await getClusterAssignments(zid, useCache);
  const commentIds: number[] = [];

  for (const [tid, assignment] of assignments.entries()) {
    const layerKey = `layer${layerId}_cluster_id`;
    const layerClusterId = assignment[layerKey];
    if (
      layerClusterId !== undefined &&
      layerClusterId !== null &&
      Number(layerClusterId) === clusterId
    ) {
      commentIds.push(tid);
    }
  }

  logger.info(
    `Found ${commentIds.length} comments in layer ${layerId}, cluster ${clusterId} for conversation ${zid}`
  );

  return commentIds;
}

/**
 * Get comment IDs for multiple layer/cluster combinations
 * Useful for topic agenda selection where a participant selects multiple topics
 *
 * @param zid - Conversation ID
 * @param clusterSpecs - Array of {layerId, clusterId} specifications
 * @param useCache - Whether to use LRU cache (default: false)
 * @returns Array of unique comment IDs across all specified clusters
 */
export async function getCommentIdsForClusters(
  zid: number,
  clusterSpecs: Array<{ layerId: number; clusterId: number }>,
  useCache = false
): Promise<number[]> {
  const assignments = await getClusterAssignments(zid, useCache);
  const tidSet = new Set<number>();

  for (const [tid, assignment] of assignments.entries()) {
    for (const spec of clusterSpecs) {
      const layerKey = `layer${spec.layerId}_cluster_id`;
      const layerClusterId = assignment[layerKey];
      if (
        layerClusterId !== undefined &&
        layerClusterId !== null &&
        Number(layerClusterId) === spec.clusterId
      ) {
        tidSet.add(tid);
        break; // No need to check other specs for this comment
      }
    }
  }

  logger.info(
    `Found ${tidSet.size} unique comments across ${clusterSpecs.length} cluster specifications for conversation ${zid}`
  );

  return Array.from(tidSet);
}

/**
 * Get a simple map of comment_id to cluster assignments for all layers
 * Useful when you need to process all comments and their clusters together
 *
 * @param zid - Conversation ID
 * @returns Map where key is comment_id (as number) and value is object with cluster info for all layers
 */
export async function getClusterAssignmentsSimple(
  zid: number
): Promise<Map<number, Record<string, number>>> {
  const assignments = await getClusterAssignments(zid);
  const simpleMap = new Map<number, Record<string, number>>();

  for (const [tid, assignment] of assignments.entries()) {
    // Dynamically extract cluster IDs for all layers
    const clusters = extractClusterAssignments(assignment);
    simpleMap.set(tid, clusters);
  }

  return simpleMap;
}

/**
 * Invalidate cached cluster assignments for a conversation
 * Useful when Delphi completes a job and cluster assignments have been updated
 *
 * @param zid - Conversation ID to invalidate
 */
export function invalidateClusterCache(zid: number): void {
  clusterAssignmentsCache.del(zid); // lru-cache v3 uses del() not delete()
  logger.info(`Invalidated cluster cache for conversation ${zid}`);
}

/**
 * Clear all cached cluster assignments
 * Useful for testing or manual cache management
 */
export function clearClusterCache(): void {
  clusterAssignmentsCache.reset(); // lru-cache v3 uses reset() not clear()
  logger.info("Cleared entire cluster assignments cache");
}

/**
 * Get cache statistics for monitoring
 *
 * @returns Object with cache size and max age
 */
export function getClusterCacheStats(): {
  itemCount: number;
  maxAge: number;
} {
  return {
    itemCount: clusterAssignmentsCache.itemCount, // lru-cache v3 uses itemCount
    maxAge: clusterAssignmentsCache.maxAge || 0,
  };
}
