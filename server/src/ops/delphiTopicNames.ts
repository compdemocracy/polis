// Delphi topic names for the ops topics page, read from the table the report
// and the participation client already read: Delphi_CommentClustersLLMTopicNames,
// partition key conversation_id = String(zid) (src/routes/delphi.ts:63-157).
//
// Per conversation: the newest run, grouped exactly as delphi.ts groups runs
// (model_name + the date part of created_at), then that run's coarsest layer
// (the highest layer_id; layer 0 is the finest), at most MAX_NAMES names in
// cluster order. Only the topic_name strings leave this module.
//
// The client uses the shared credential precedence (src/utils/dynamoClient.ts):
// DynamoDB Local when DYNAMODB_ENDPOINT is set, else configured keys, else the
// instance role. The instance role already has dynamodb:Query on Delphi_*.

import { DynamoDBDocumentClient, QueryCommand } from "@aws-sdk/lib-dynamodb";
import { resultClient } from "../utils/delphiResults";
import { makeDynamoClient } from "../utils/dynamoClient";

export const TOPIC_NAMES_TABLE = "Delphi_CommentClustersLLMTopicNames";
export const MAX_NAMES = 8;
const MAX_PAGES = 10;
const QUERY_TIMEOUT_MS = 3000;
const CONCURRENCY = 4;
const MAX_NAME_LENGTH = 80;

export type TopicItem = {
  model_name?: unknown;
  created_at?: unknown;
  layer_id?: unknown;
  cluster_id?: unknown;
  topic_name?: unknown;
};

// zid -> names ([] when Delphi has none), or null when the read failed.
export type TopicNames = Map<number, string[] | null>;
export type TopicNameReader = (zids: number[]) => Promise<TopicNames>;

function cleanName(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const text = value.replace(/\s+/g, " ").trim();
  if (!text) return null;
  return text.length > MAX_NAME_LENGTH
    ? `${text.slice(0, MAX_NAME_LENGTH - 1)}…`
    : text;
}

function asInt(value: unknown): number | null {
  const n = typeof value === "number" ? value : Number(value);
  return Number.isInteger(n) ? n : null;
}

/** Newest run, coarsest layer, names in cluster order. Pure. */
export function pickTopicNames(items: TopicItem[]): string[] {
  const runs = new Map<string, { newest: string; items: TopicItem[] }>();
  for (const item of items) {
    const model =
      typeof item.model_name === "string" ? item.model_name : "unknown";
    const created = typeof item.created_at === "string" ? item.created_at : "";
    const key = `${model}_${created.substring(0, 10)}`;
    const run = runs.get(key) || { newest: "", items: [] };
    if (created > run.newest) run.newest = created;
    run.items.push(item);
    runs.set(key, run);
  }
  let best: { newest: string; items: TopicItem[] } | null = null;
  for (const run of runs.values()) {
    if (!best || run.newest > best.newest) best = run;
  }
  if (!best) return [];
  const layered = best.items.filter((i) => asInt(i.layer_id) !== null);
  if (layered.length === 0) return [];
  const top = Math.max(...layered.map((i) => asInt(i.layer_id) as number));
  return layered
    .filter((i) => asInt(i.layer_id) === top)
    .sort((a, b) => (asInt(a.cluster_id) ?? 0) - (asInt(b.cluster_id) ?? 0))
    .map((i) => cleanName(i.topic_name))
    .filter((n): n is string => n !== null)
    .slice(0, MAX_NAMES);
}

async function inBatches<T>(
  items: T[],
  size: number,
  work: (item: T) => Promise<void>
) {
  for (let i = 0; i < items.length; i += size) {
    await Promise.all(items.slice(i, i + size).map(work));
  }
}

export function makeDelphiTopicNameReader(): TopicNameReader {
  let doc: DynamoDBDocumentClient | null = null;
  return async (zids) => {
    const out: TopicNames = new Map();
    if (zids.length === 0) return out;
    try {
      doc = doc || resultClient(() => DynamoDBDocumentClient.from(makeDynamoClient()));
    } catch {
      for (const zid of zids) out.set(zid, null);
      return out;
    }
    const client = doc;
    let tableMissing = false;
    await inBatches(zids, CONCURRENCY, async (zid) => {
      if (tableMissing) {
        out.set(zid, []);
        return;
      }
      try {
        const items: TopicItem[] = [];
        let startKey: Record<string, unknown> | undefined;
        let pages = 0;
        do {
          const page = await client.send(
            new QueryCommand({
              TableName: TOPIC_NAMES_TABLE,
              KeyConditionExpression: "conversation_id = :cid",
              ExpressionAttributeValues: { ":cid": String(zid) },
              ExclusiveStartKey: startKey,
            }),
            { abortSignal: AbortSignal.timeout(QUERY_TIMEOUT_MS) }
          );
          items.push(...((page.Items as TopicItem[]) || []));
          startKey = page.LastEvaluatedKey;
          pages += 1;
        } while (startKey && pages < MAX_PAGES);
        out.set(zid, pickTopicNames(items));
      } catch (err) {
        // No Delphi table (a deployment without Delphi): no names, not a
        // failure.
        if ((err as { name?: unknown })?.name === "ResourceNotFoundException") {
          tableMissing = true;
          out.set(zid, []);
        } else {
          out.set(zid, null);
        }
      }
    });
    return out;
  };
}
