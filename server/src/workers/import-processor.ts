import { GetObjectCommand } from "@aws-sdk/client-s3";
import { Readable } from "stream";
import csv from "csv-parser";
import { S3Client, S3ClientConfig } from "@aws-sdk/client-s3";
import pg from "../db/pg-query"; // This now contains the { connect } method
import logger from "../utils/logger";
import Config from "../config";

// --- S3 Configuration ---
const customEndpoint = Config.AWS_S3_ENDPOINT;

const config: S3ClientConfig = {
  region: Config.AWS_REGION || "us-east-1",
  credentials: {
    accessKeyId: Config.AWS_ACCESS_KEY_ID || "minioadmin",
    secretAccessKey: Config.AWS_SECRET_ACCESS_KEY || "minioadmin",
  },
};

if (customEndpoint) {
  config.endpoint = customEndpoint;
  config.forcePathStyle = true;
}

export const s3Client = new S3Client(config);

// --- Interfaces ---

// THIS IS THE EXACT ROW THAT MUST BE PRESENT ON CSV
interface ImportRow {
  vote_id: string;
  user_id: string;
  vote_value: string;
  timestamp: string;
  comment_id: string;
}

// --- Worker Main Logic ---

export async function processImportJob(payload: {
  jobId: number;
  zid: number;
  s3Key: string;
}) {
  const { jobId, zid, s3Key } = payload;
  const BATCH_SIZE = 1000;
  let processedCount = 0;

  try {
    // 1. Update Status -> Processing
    await pg.queryP(
      "UPDATE byod_import_jobs SET status = 'processing', updated_at = NOW() WHERE id = $1",
      [jobId]
    );

    // 2. Pre-fetch Comment Mapping
    logger.info(`[Worker] Building Comment ID Map for ZID ${zid}...`);
    const commentMap = await buildCommentMap(zid);

    if (commentMap.size === 0) {
      throw new Error(`No comments found for ZID ${zid}. Import aborted.`);
    }

    // 3. Stream & Process
    const command = new GetObjectCommand({
      Bucket: Config.AWS_S3_BUCKET_NAME || "polis-delphi",
      Key: s3Key,
    });

    const response = await s3Client.send(command);
    if (!response.Body) throw new Error("Empty body from S3");

    const stream = response.Body as Readable;
    let batch: any[] = [];

    await new Promise<void>((resolve, reject) => {
      stream
        .pipe(csv())
        .on("data", (row: ImportRow) => {
          try {
            const mappedRow = mapRowData(row, zid, commentMap);
            batch.push(mappedRow);
          } catch (e) {
            logger.warn(`Skipping row: ${(e as Error).message}`);
          }

          if (batch.length >= BATCH_SIZE) {
            stream.pause();
            flushBatchToDb(batch)
              .then(() => {
                processedCount += batch.length;
                batch = [];
                stream.resume();
              })
              .catch((err) => stream.destroy(err));
          }
        })
        .on("end", async () => {
          if (batch.length > 0) {
            await flushBatchToDb(batch);
            processedCount += batch.length;
          }
          resolve();
        })
        .on("error", (err) => reject(err));
    });

    // 4. Finalize
    logger.info(`[Worker] Refreshing votes_latest_unique for ZID ${zid}...`);
    await refreshVotesLatestUnique(zid);

    // 5. Mark Complete
    await pg.queryP(
      "UPDATE byod_import_jobs SET status = 'completed', stage = 'finished', updated_at = NOW() WHERE id = $1",
      [jobId]
    );
    logger.info(
      `[Worker] Job ${jobId} Completed. Processed ${processedCount} rows.`
    );
  } catch (err) {
    logger.error(`[Worker] Job ${jobId} Failed`, err);
    await markJobAsFailedInDb(
      jobId,
      err instanceof Error ? err.message : "Unknown Error"
    );
    throw err;
  }
}

// --- Helper Functions ---

async function markJobAsFailedInDb(jobId: number, errorMessage: string) {
  const query = `
    UPDATE byod_import_jobs 
    SET status = 'failed', error_message = $2, updated_at = NOW()
    WHERE id = $1
  `;
  try {
    await pg.queryP(query, [jobId, errorMessage]);
  } catch (dbErr) {
    const msg = dbErr instanceof Error ? dbErr.message : "Unknown DB Error";
    logger.error(
      `CRITICAL DOUBLE FAULT: Failed to mark job ${jobId} as failed. Original error: ${errorMessage}. DB Error: ${msg}`
    );
  }
}

async function buildCommentMap(zid: number): Promise<Map<string, number>> {
  const query = `SELECT tid, original_id FROM comments WHERE zid = $1 AND original_id IS NOT NULL`;
  const result = await pg.queryP(query, [zid]);
  const map = new Map<string, number>();
  // @ts-expect-error unknown return type
  result.forEach((row: any) => map.set(row.original_id, row.tid));
  return map;
}

function mapRowData(
  row: ImportRow,
  zid: number,
  commentMap: Map<string, number>
) {
  const internalTid = commentMap.get(row.comment_id);
  if (internalTid === undefined)
    throw new Error(`Comment UUID ${row.comment_id} not found`);

  let ts = Date.now();
  if (row.timestamp) {
    const parsed = Date.parse(row.timestamp);
    if (!isNaN(parsed)) ts = parsed;
  }

  return [zid, internalTid, row.user_id, parseInt(row.vote_value, 10), ts];
}

async function flushBatchToDb(rows: any[][]) {
  if (rows.length === 0) return;

  const zids = rows.map((r) => r[0]);
  const tids = rows.map((r) => r[1]);
  const usernames = rows.map((r) => r[2]);
  const votes = rows.map((r) => r[3]);
  const timestamps = rows.map((r) => r[4]);

  // CHANGED: We now await the connection to get a dedicated client
  const client = await pg.connect();

  try {
    // We must use 'client.query' here, NOT 'pg.query'
    // This ensures all commands happen on the same borrowed connection
    await client.query("BEGIN");

    // 1. Users
    await client.query(
      `
      INSERT INTO users (username, email, created)
      SELECT DISTINCT unnest($1::text[]), unnest($1::text[]) || '@import.local', $2::bigint
      ON CONFLICT (email) DO NOTHING
    `,
      [usernames, timestamps[0]]
    );

    // 2. Participants
    await client.query(
      `
      INSERT INTO participants (uid, zid, created)
      SELECT DISTINCT u.uid, $1::int, $2::bigint
      FROM unnest($3::text[]) AS input_username
      JOIN users u ON u.username = input_username
      ON CONFLICT (zid, uid) DO NOTHING
    `,
      [zids[0], timestamps[0], usernames]
    );

    // 3. Votes
    await client.query(
      `
      INSERT INTO votes (zid, pid, tid, vote, created)
      SELECT data.zid, p.pid, data.tid, data.vote, data.created
      FROM (
        SELECT 
          unnest($1::int[]) as zid,
          unnest($2::int[]) as tid,
          unnest($3::text[]) as username,
          unnest($4::int[]) as vote,
          unnest($5::bigint[]) as created
      ) as data
      JOIN users u ON u.username = data.username
      JOIN participants p ON p.uid = u.uid AND p.zid = data.zid
      WHERE NOT EXISTS (
        SELECT 1 FROM votes v 
        WHERE v.zid = data.zid AND v.pid = p.pid AND v.tid = data.tid
      )
    `,
      [zids, tids, usernames, votes, timestamps]
    );

    await client.query("COMMIT");
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
}

async function refreshVotesLatestUnique(zid: number) {
  const query = `
    INSERT INTO votes_latest_unique (zid, pid, tid, vote, modified)
    SELECT DISTINCT ON (pid, tid)
      zid,
      pid,
      tid,
      vote,
      created
    FROM votes
    WHERE zid = $1
    ORDER BY pid, tid, created DESC
    ON CONFLICT (zid, pid, tid)
    DO UPDATE SET
      vote = EXCLUDED.vote,
      modified = EXCLUDED.modified;
  `;
  await pg.queryP(query, [zid]);
}
