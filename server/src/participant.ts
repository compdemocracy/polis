import _ from "underscore";
import { encrypt } from "./session";
import { getPidPromise } from "./user";
import pg from "./db/pg-query";
import { sql_participants_extended } from "./db/sql";
import async from "async";
import Config from "./config";
import logger from "./utils/logger";
import LruCache from "lru-cache";

const socialParticipantsCache = new LruCache({
  maxAge: 1000 * 30, // 30 seconds
  max: 999,
});

async function addExtendedParticipantInfo(
  zid: number,
  uid?: number,
  data?: Record<string, any>
): Promise<void> {
  if (!data || !_.keys(data).length) {
    return;
  }

  const params = Object.assign({}, data, {
    zid: zid,
    uid: uid,
    // Use JavaScript timestamp instead of hacky string replacement
    modified: Date.now(),
  });

  const qUpdate = sql_participants_extended
    .update(params)
    .where(sql_participants_extended.zid.equals(zid))
    .and(sql_participants_extended.uid.equals(uid));

  await pg.queryP(qUpdate.toString(), []);
}

function saveParticipantMetadataChoices(
  zid: number,
  pid: number,
  answers: any[],
  callback: { (err: any): void; (arg0: number): void }
) {
  // answers is a list of pmaid
  if (!answers || !answers.length) {
    // nothing to save
    return callback(0);
  }

  const q =
    "select * from participant_metadata_answers where zid = ($1) and pmaid in (" +
    answers.join(",") +
    ");";

  pg.query(
    q,
    [zid],
    function (err: any, qa_results: { [x: string]: { pmqid: any } }) {
      if (err) {
        logger.error("polis_err_getting_participant_metadata_answers", err);
        return callback(err);
      }

      qa_results = qa_results.rows;
      qa_results = _.indexBy(qa_results, "pmaid");
      // construct an array of params arrays
      answers = answers.map(function (pmaid: string | number) {
        const pmqid = qa_results[pmaid].pmqid;
        return [zid, pid, pmaid, pmqid];
      });
      // make simultaneous requests to insert the choices
      async.map(
        answers,
        function (x: any, cb: (arg0: number) => void) {
          pg.query(
            "INSERT INTO participant_metadata_choices (zid, pid, pmaid, pmqid) VALUES ($1,$2,$3,$4);",
            x,
            function (err: any) {
              if (err) {
                logger.error(
                  "polis_err_saving_participant_metadata_choices",
                  err
                );
                return cb(err);
              }
              cb(0);
            }
          );
        },
        function (err: any) {
          if (err) {
            logger.error("polis_err_saving_participant_metadata_choices", err);
            return callback(err);
          }
          // finished with all the inserts
          callback(0);
        }
      );
    }
  );
}

function saveParticipantMetadataChoicesP(
  zid: number,
  pid: number,
  answers: any
) {
  return new Promise(function (
    resolve: (arg0: number) => void,
    reject: (arg0: any) => void
  ) {
    saveParticipantMetadataChoices(zid, pid, answers, function (err: any) {
      if (err) {
        reject(err);
      } else {
        resolve(0);
      }
    });
  });
}

function tryToJoinConversation(
  zid: number,
  uid?: number,
  info?: any,
  pmaid_answers?: string | any[]
) {
  function doAddExtendedParticipantInfo() {
    if (info && _.keys(info).length > 0) {
      addExtendedParticipantInfo(zid, uid, info);
    }
  }

  function saveMetadataChoices(pid?: number) {
    if (pmaid_answers && pmaid_answers.length) {
      saveParticipantMetadataChoicesP(zid, pid, pmaid_answers);
    }
  }

  return addParticipant(zid, uid).then(function (rows: any[]) {
    const ptpt = rows[0];

    doAddExtendedParticipantInfo();

    if (pmaid_answers && pmaid_answers.length) {
      saveMetadataChoices();
    }
    return ptpt;
  });
}

// Before migration 000043, the pid_auto trigger took the conversation's
// participant lock as a SESSION advisory lock, and pid_auto_unlock gave it back
// only after an INSERT that succeeded (server/postgres/migrations). A
// participants INSERT that failed after taking it (a lost pid race, an existing
// (zid, uid), a lock timeout) left the lock on its connection, and ROLLBACK did
// not release it. So a connection that saw any error here is closed instead of
// being returned to the pool: the lock ends with its session, rather than
// making every later joiner of the conversation wait on it. Since 000043 the
// lock is held to COMMIT or ROLLBACK and never outlives the transaction;
// closing the connection is kept for a database without 000043.
//
// Every lock wait in the transaction is bounded, so a lock held elsewhere (a
// server still running code that leaks it, for example) answers the joiner
// with an error instead of holding a read-write connection indefinitely.
const PARTICIPANT_INSERT_LOCK_TIMEOUT = "5s";
// SQLSTATE raised when lock_timeout expires.
const LOCK_NOT_AVAILABLE = "55P03";

// extendedRow: false creates the participants row alone, without the
// participants_extended row a join through votes, comments or participationInit
// creates: what an invite accept (src/invites/treevites.ts) has always created.
type ParticipantInsertOptions = { extendedRow?: boolean };

async function insertParticipant(
  zid: number,
  uid?: number,
  { extendedRow = true }: ParticipantInsertOptions = {}
): Promise<any> {
  // Use a dedicated client (not pool-level queries) so all statements in the
  // transaction run on the same connection. Without this, pg.query() grabs a
  // random connection from the pool for each call, breaking transaction
  // isolation under concurrent load. See: concurrent-same-participant.test.ts.
  const client = await pg.connect();
  // Set when any statement on this connection failed; release(true) then
  // closes the connection instead of pooling it.
  let discard = false;
  try {
    await client.query("BEGIN");
    await client.query(
      `SET LOCAL lock_timeout = '${PARTICIPANT_INSERT_LOCK_TIMEOUT}';`
    );

    if (extendedRow) {
      // First insert into participants_extended (ignore duplicates)
      await client.query(
        "INSERT INTO participants_extended (zid, uid) VALUES ($1, $2) ON CONFLICT (zid, uid) DO NOTHING;",
        [zid, uid]
      );
      logger.debug("participants_extended insert/skip successful", {
        zid,
        uid,
      });
    }

    // Second insert into participants table.
    // The pid_auto trigger acquires the conversation's participant lock and
    // assigns pid = MAX(pid)+1; since migration 000043 the lock is held until
    // this transaction commits or rolls back.
    try {
      const partResult = await client.query(
        "INSERT INTO participants (pid, zid, uid, created) VALUES (NULL, $1, $2, default) RETURNING *;",
        [zid, uid]
      );
      await client.query("COMMIT");
      logger.debug("participants insert successful", {
        zid,
        uid,
        pid: partResult.rows[0]?.pid,
      });
      return partResult.rows;
    } catch (partErr: any) {
      discard = true;
      await client.query("ROLLBACK");
      if (partErr.code === "23505") {
        // Duplicate key — participant was created by a concurrent request.
        // Fetch and return the existing record. This runs after ROLLBACK,
        // on the same client connection, so isolation is correct.
        logger.debug("Participant already exists, fetching existing record", {
          zid,
          uid,
          constraint: partErr.constraint,
        });
        const selectResult = await client.query(
          "SELECT * FROM participants WHERE zid = $1 AND uid = $2;",
          [zid, uid]
        );
        if (selectResult.rows && selectResult.rows.length > 0) {
          logger.debug("Found existing participant", {
            zid,
            uid,
            pid: selectResult.rows[0].pid,
          });
          return selectResult.rows;
        }
        // No row for this uid: another joiner was given the same pid.
        throw partErr;
      }
      logger.error("participants insert failed", {
        zid,
        uid,
        error: partErr.message,
        code: partErr.code,
        constraint: partErr.constraint,
      });
      throw partErr;
    }
  } catch (err) {
    discard = true;
    // Ensure rollback on any unexpected error
    try {
      await client.query("ROLLBACK");
    } catch (_rollbackErr) {
      // ignore rollback errors
    }
    throw err;
  } finally {
    client.release(discard);
  }
}

async function addParticipant(
  zid: number,
  uid?: number,
  options: ParticipantInsertOptions = {}
): Promise<any> {
  logger.debug("addParticipant starting", { zid, uid });
  try {
    return await insertParticipant(zid, uid, options);
  } catch (err: any) {
    if (err?.code !== "23505") {
      throw err;
    }
    // Another joiner was given the same pid: before migration 000043, pid_auto
    // could compute MAX(pid) + 1 before that joiner's row was committed. It is
    // committed by the time this INSERT fails, so one more attempt, on a new
    // connection, gets the next pid. With 000043 the lock is held to commit and
    // this does not happen; the retry is kept for a database without it.
    logger.info("participant pid collision; retrying once", {
      zid,
      uid,
      constraint: err.constraint,
    });
    return insertParticipant(zid, uid, options);
  }
}

function joinConversation(
  zid: number,
  uid?: number,
  info?: {},
  pmaid_answers?: any
) {
  function tryJoin() {
    return tryToJoinConversation(zid, uid, info, pmaid_answers);
  }

  function retryJoin(err: any) {
    // A lock timeout means the conversation's participant lock is held
    // elsewhere; another attempt would only wait out the same timeout again.
    if (err?.code === LOCK_NOT_AVAILABLE) {
      throw err;
    }
    return tryJoin();
  }

  function doJoin() {
    // retry up to 10 times
    // NOTE: Shouldn't be needed, since we have an advisory lock in the insert trigger.
    //       However, that doesn't seem to be preventing duplicate pid constraint errors.
    //       Doing this retry in JS for now since it's quick and easy, rather than try to
    //       figure what's wrong with the postgres locks.
    const promise = tryJoin()
      .catch(retryJoin)
      .catch(retryJoin)
      .catch(retryJoin)
      .catch(retryJoin)
      .catch(retryJoin)
      .catch(retryJoin)
      .catch(retryJoin)
      .catch(retryJoin)
      .catch(retryJoin);
    return promise;
  }

  return getPidPromise(zid, uid).then(function (pid: number) {
    if (pid >= 0) {
      // already a ptpt, so don't create another
      return;
    } else {
      return doJoin();
    }
  }, doJoin);
}

// The referrer is the URL of the page that sent the request. For an embedded
// conversation that is the iframe's own URL, whose query string carries the
// participant's xid and whatever else the embedding page appended. Only the
// origin and path are stored; the query string and fragment are dropped.
function referrerWithoutQuery(referrer: string): string {
  return referrer.split(/[?#]/, 1)[0];
}

function addParticipantAndMetadata(
  zid: number,
  uid?: number,
  req?: {
    p: { parent_url?: any; [key: string]: any };
    headers?: { [x: string]: any };
  }
) {
  const info: { [key: string]: string } = {};
  const parent_url = req?.p?.parent_url;
  const referer = req?.headers?.["referer"] || req?.headers?.["referrer"];
  if (parent_url) {
    info.parent_url = parent_url;
  }
  if (referer) {
    info.referrer = referrerWithoutQuery(referer);
  }

  // These fields only exist on the PolisWebServer deployment.
  if (Config.applicationName === "PolisWebServer") {
    const x_forwarded_for = req?.headers?.["x-forwarded-for"];
    let ip: string | null = null;
    if (x_forwarded_for) {
      let ips = x_forwarded_for;
      ips = ips && ips.split(", ");
      ip = ips.length && ips[0];
      info.encrypted_ip_address = encrypt(ip);
      info.encrypted_x_forwarded_for = encrypt(x_forwarded_for);
    }
  }

  if (req?.headers?.["origin"]) {
    info.origin = req?.headers?.["origin"];
  }
  return addParticipant(zid, uid).then((rows: any[]) => {
    addExtendedParticipantInfo(zid, uid, info);

    return rows;
  });
}

function getSocialParticipants(
  zid: number,
  uid?: number,
  limit?: any,
  mod?: number,
  math_tick?: any,
  authorUids?: any[]
) {
  // NOTE ignoring authorUids as part of cacheKey for now, just because.
  const cacheKey = [zid, limit, mod, math_tick].join("_");
  if (socialParticipantsCache.get(cacheKey)) {
    return socialParticipantsCache.get(cacheKey);
  }

  const authorsQueryParts = (authorUids || []).map(function (authorUid?: any) {
    return "select " + Number(authorUid) + " as uid, 900 as priority";
  });
  let authorsQuery: string | null =
    "(" + authorsQueryParts.join(" union ") + ")";
  if (!authorUids || authorUids.length === 0) {
    authorsQuery = null;
  }

  const q =
    "with " +
    "p as (select uid, pid, mod from participants where zid = ($1) and vote_count >= 1), " +
    "xids_subset as (select * from xids where owner in (select org_id from conversations where zid = ($1)) and x_profile_image_url is not null), " +
    "xid_ptpts as (select p.uid, 100 as priority from p inner join xids_subset on xids_subset.uid = p.uid where p.mod >= ($4)), " +
    "self as (select CAST($2 as INTEGER) as uid, 1000 as priority), " +
    (authorsQuery ? "authors as " + authorsQuery + ", " : "") +
    "pptpts as (select prioritized_ptpts.uid, max(prioritized_ptpts.priority) as priority " +
    "from ( " +
    "select * from self " +
    (authorsQuery ? "union " + "select * from authors " : "") +
    "union " +
    "select * from xid_ptpts " +
    ") as prioritized_ptpts " +
    "inner join p on prioritized_ptpts.uid = p.uid " +
    "group by prioritized_ptpts.uid order by priority desc, prioritized_ptpts.uid asc), " +
    // force inclusion of participants with high mod values
    "mod_pptpts as (select asdfasdjfioasjdfoi.uid, max(asdfasdjfioasjdfoi.priority) as priority " +
    "from ( " +
    "select * from pptpts " +
    "union all " +
    "select uid, 999 as priority from p where mod >= 2) as asdfasdjfioasjdfoi " +
    "group by asdfasdjfioasjdfoi.uid order by priority desc, asdfasdjfioasjdfoi.uid asc), " +
    // without blocked
    "final_set as (select * from mod_pptpts " +
    // "where uid not in (select uid from p where mod < 0) "+ // remove from twitter set intead.
    "limit ($3) " +
    ") " + // in invisible_uids
    "select " +
    "final_set.priority, " +
    "xids_subset.x_profile_image_url as x_profile_image_url, " +
    "xids_subset.xid as xid, " +
    "xids_subset.x_name as x_name, " +
    "xids_subset.x_email as x_email, " +
    // "final_set.uid " +
    "p.pid " +
    "from final_set " +
    "left join xids_subset on final_set.uid = xids_subset.uid " +
    "left join p on final_set.uid = p.uid " +
    ";";

  return pg
    .queryP_metered_readOnly("getSocialParticipants", q, [zid, uid, limit, mod])
    .then(function (response: any) {
      socialParticipantsCache.set(cacheKey, response);
      return response;
    });
}

async function getParticipantByPermanentCookie(
  zid: number,
  permanentCookie: string
): Promise<{ uid: number; pid: number } | null> {
  return new Promise((resolve) => {
    pg.query(
      `SELECT pe.uid, p.pid 
       FROM participants_extended pe
       INNER JOIN participants p ON pe.uid = p.uid AND pe.zid = p.zid
       WHERE pe.zid = $1 AND pe.permanent_cookie = $2`,
      [zid, permanentCookie],
      (err: any, results: { rows: any[] }) => {
        if (err) {
          logger.error("Error looking up participant by permanent cookie", err);
          resolve(null);
          return;
        }

        if (results && results.rows && results.rows.length > 0) {
          resolve({
            uid: results.rows[0].uid,
            pid: results.rows[0].pid,
          });
        } else {
          resolve(null);
        }
      }
    );
  });
}

export {
  addExtendedParticipantInfo,
  addParticipant,
  addParticipantAndMetadata,
  getParticipantByPermanentCookie,
  getSocialParticipants,
  joinConversation,
  referrerWithoutQuery,
};
