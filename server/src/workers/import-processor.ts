import { GetObjectCommand, DeleteObjectCommand } from "@aws-sdk/client-s3";
import { Readable } from "stream";
import { parse } from "csv-parse";
import { S3Client, S3ClientConfig } from "@aws-sdk/client-s3";
import pg from "../db/pg-query";
import logger from "../utils/logger";
import Config from "../config";
import { sendTextEmail } from "../email/senders";

const customEndpoint = Config.AWS_S3_ENDPOINT;
const config: S3ClientConfig = {
  region: Config.AWS_REGION || "us-east-1",
};

if (customEndpoint) {
  config.credentials = {
    accessKeyId: Config.AWS_ACCESS_KEY_ID,
    secretAccessKey: Config.AWS_SECRET_ACCESS_KEY,
  };
  config.endpoint = customEndpoint;
  config.forcePathStyle = true;
}

export const s3Client = new S3Client(config);

interface ImportRow {
  vote_id: string;
  user_id: string;
  vote_value: string;
  timestamp: string;
  comment_id: string;
}

export async function processImportJob(payload: {
  jobId: number;
  zid: number;
  s3Key: string;
  email: string;
}) {
  const { jobId, zid, s3Key, email } = payload;
  const BATCH_SIZE = 1000;
  let processedCount = 0;

  try {
    await pg.queryP(
      "UPDATE byod_import_jobs SET status = 'processing', updated_at = NOW() WHERE id = $1",
      [jobId]
    );

    logger.info(`[Worker] Building Comment ID Map for ZID ${zid}...`);
    const commentMap = await buildCommentMap(zid);

    if (commentMap.size === 0) {
      throw new Error(`No comments found for ZID ${zid}. Import aborted.`);
    }

    const command = new GetObjectCommand({
      Bucket: Config.AWS_S3_BUCKET_NAME || "polis-delphi",
      Key: s3Key,
    });
    const response = await s3Client.send(command);
    if (!response.Body) throw new Error("Empty body from S3");
    const stream = response.Body as Readable;
    let batch: any[] = [];

    await new Promise<void>((resolve, reject) => {
      const parser = stream.pipe(
        parse({
          columns: true,
          trim: true,
          skip_empty_lines: true,
        })
      );

      parser
        .on("data", (row: ImportRow) => {
          try {
            const mappedRow = mapRowData(row, zid, commentMap);
            batch.push(mappedRow);
          } catch (e) {
            logger.warn(`Skipping row: ${(e as Error).message}`);
          }

          if (batch.length >= BATCH_SIZE) {
            stream.pause();
            parser.pause();
            flushBatchToDb(batch)
              .then(() => {
                processedCount += batch.length;
                batch = [];
                parser.resume();
                stream.resume();
              })
              .catch((err) => {
                parser.destroy(err);
                reject(err);
              });
          }
        })
        .on("end", async () => {
          if (batch.length > 0) {
            try {
              await flushBatchToDb(batch);
              processedCount += batch.length;
              resolve();
            } catch (err) {
              reject(err);
            }
          } else {
            resolve();
          }
        })
        .on("error", (err) => reject(err));
    });

    logger.info(`[Worker] Refreshing votes_latest_unique for ZID ${zid}...`);
    await refreshVotesLatestUnique(zid);
    logger.info(`[Worker] Syncing participant stats for ZID ${zid}...`);
    await syncParticipantStats(zid);
    logger.info(`[Worker] Triggering Math Engine Recalc for ZID ${zid}...`);
    await triggerMathRecalc(zid);

    await pg.queryP(
      "UPDATE byod_import_jobs SET status = 'completed', stage = 'finished', updated_at = NOW() WHERE id = $1",
      [jobId]
    );
    logger.info(
      `[Worker] Job ${jobId} Completed. Processed ${processedCount} rows.`
    );

    try {
      logger.info(`[Worker] Deleting S3 Object: ${s3Key}...`);
      await s3Client.send(
        new DeleteObjectCommand({
          Bucket: Config.AWS_S3_BUCKET_NAME || "polis-delphi",
          Key: s3Key,
        })
      );
      logger.info(`[Worker] S3 Object Deleted.`);
    } catch (s3Err) {
      logger.error(`[Worker] Failed to delete S3 Object: ${s3Key}`, s3Err);
    }
    if (email) {
      try {
        logger.info(`[Worker] Sending success email to ${email}...`);
        await sendTextEmail(
          Config.polisFromAddress,
          email,
          "Import Successful: Your Data is Ready",
          `Your import for conversation ${zid} has completed successfully.\n\nProcessed ${processedCount} votes.`
        );
      } catch (emailErr) {
        logger.error(`[Worker] Failed to send success email`, emailErr);
      }
    }
  } catch (err) {
    logger.error(`[Worker] Job ${jobId} Failed`, err);
    await markJobAsFailedInDb(
      jobId,
      err instanceof Error ? err.message : "Unknown Error"
    );
    if (email) {
      try {
        logger.info(`[Worker] Sending failure email to ${email}...`);
        await sendTextEmail(
          Config.polisFromAddress,
          email,
          "Import Failed: Something went wrong",
          `Your import for conversation ${zid} failed.\n\nError: ${err?.message}`
        );
      } catch (emailErr) {
        logger.error(`[Worker] Failed to send failure email`, emailErr);
      }
    }
    throw err;
  }
}

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
  // @ts-expect-error queryp unknown
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
  // INTETNIONAL VOTE FLIPPING, REMOVE AFTER VOTES REFACTOR
  let voteValue = parseInt(row.vote_value, 10);
  if (voteValue === 1) {
    voteValue = -1;
  } else if (voteValue === -1) {
    voteValue = 1;
  }

  return [zid, internalTid, row.user_id, voteValue, ts];
}

async function flushBatchToDb(rows: any[][]) {
  if (rows.length === 0) return;

  const zids = rows.map((r) => r[0]);
  const tids = rows.map((r) => r[1]);
  const usernames = rows.map((r) => r[2]);
  const votes = rows.map((r) => r[3]);
  const timestamps = rows.map((r) => r[4]);

  const client = await pg.connect();

  try {
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

    // 3. Resolve PIDs
    const pidResult = await client.query(
      `
      SELECT p.pid, u.username 
      FROM participants p
      JOIN users u ON p.uid = u.uid
      WHERE p.zid = $1 
      AND u.username = ANY($2::text[])
    `,
      [zids[0], usernames]
    );

    const pidMap = new Map<string, number>();
    pidResult.rows.forEach((row: any) => pidMap.set(row.username, row.pid));

    // 4. Re-map data
    const votePids: number[] = [];
    const voteTids: number[] = [];
    const voteValues: number[] = [];
    const voteTimestamps: any[] = [];

    for (let i = 0; i < rows.length; i++) {
      const u = usernames[i];
      const pid = pidMap.get(u);

      if (pid !== undefined) {
        votePids.push(pid);
        voteTids.push(tids[i]);
        voteValues.push(votes[i]);
        voteTimestamps.push(timestamps[i]);
      }
    }

    // 5. Insert Votes
    if (votePids.length > 0) {
      await client.query(
        `
        INSERT INTO votes (zid, pid, tid, vote, created)
        SELECT $1::int, unnest($2::int[]), unnest($3::int[]), unnest($4::int[]), unnest($5::bigint[])
        `,
        [zids[0], votePids, voteTids, voteValues, voteTimestamps]
      );
    }

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

async function triggerMathRecalc(zid: number) {
  const query = `
    INSERT INTO math_ticks (zid, math_env, math_tick, modified)
    VALUES ($1, 'prod', 1, (EXTRACT(EPOCH FROM NOW()) * 1000)::bigint)
    ON CONFLICT (zid, math_env) 
    DO UPDATE SET 
      math_tick = math_ticks.math_tick + 1,
      modified = (EXTRACT(EPOCH FROM NOW()) * 1000)::bigint;
  `;
  await pg.queryP(query, [zid]);
  await pg.queryP(
    "UPDATE conversations SET modified = (EXTRACT(EPOCH FROM NOW()) * 1000)::bigint WHERE zid = $1",
    [zid]
  );
}

async function syncParticipantStats(zid: number) {
  const query = `
    WITH ptpt_stats AS (
        SELECT 
            pid, 
            COUNT(*) as actual_vote_count,
            MAX(created) as last_active
        FROM votes
        WHERE zid = $1
        GROUP BY pid
    )
    UPDATE participants p
    SET 
        vote_count = ps.actual_vote_count,
        last_interaction = ps.last_active
    FROM ptpt_stats ps
    WHERE p.zid = $1 
    AND p.pid = ps.pid;
  `;
  await pg.queryP(query, [zid]);
}
