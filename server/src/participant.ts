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

async function addParticipant(zid: number, uid?: number): Promise<any> {
  logger.debug("addParticipant starting", { zid, uid });

  try {
    // First insert into participants_extended
    await pg.queryP(
      "INSERT INTO participants_extended (zid, uid) VALUES ($1, $2);",
      [zid, uid]
    );
    logger.debug("participants_extended insert successful", { zid, uid });
  } catch (extendedError: any) {
    logger.error("participants_extended insert failed", {
      zid,
      uid,
      error: extendedError.message,
      code: extendedError.code,
      constraint: extendedError.constraint,
    });

    // If it's a duplicate key error on participants_extended, that's not critical
    // We can continue with the participants insert
    if (extendedError.code !== "23505") {
      throw extendedError;
    }
    logger.debug("participants_extended duplicate key error ignored", {
      zid,
      uid,
    });
  }

  try {
    // Second insert into participants table
    const result = await pg.queryP(
      "INSERT INTO participants (pid, zid, uid, created) VALUES (NULL, $1, $2, default) RETURNING *;",
      [zid, uid]
    );
    logger.debug("participants insert successful", {
      zid,
      uid,
      resultLength: Array.isArray(result) ? result.length : "unknown",
      result: Array.isArray(result) && result.length > 0 ? result[0] : "empty",
    });
    return result;
  } catch (participantsError: any) {
    logger.error("participants insert failed", {
      zid,
      uid,
      error: participantsError.message,
      code: participantsError.code,
      constraint: participantsError.constraint,
    });
    throw participantsError;
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

  function doJoin() {
    // retry up to 10 times
    // NOTE: Shouldn't be needed, since we have an advisory lock in the insert trigger.
    //       However, that doesn't seem to be preventing duplicate pid constraint errors.
    //       Doing this retry in JS for now since it's quick and easy, rather than try to
    //       figure what's wrong with the postgres locks.
    const promise = tryJoin()
      .catch(tryJoin)
      .catch(tryJoin)
      .catch(tryJoin)
      .catch(tryJoin)
      .catch(tryJoin)
      .catch(tryJoin)
      .catch(tryJoin)
      .catch(tryJoin)
      .catch(tryJoin);
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

function addParticipantAndMetadata(
  zid: number,
  uid?: number,
  req?: {
    p: { parent_url: any };
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
    info.referrer = referer;
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

export {
  addExtendedParticipantInfo,
  addParticipant,
  addParticipantAndMetadata,
  getSocialParticipants,
  joinConversation,
};

export async function getParticipantByPermanentCookie(
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
