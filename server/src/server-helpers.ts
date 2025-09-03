import _ from "underscore";
import LruCache from "lru-cache";

import { failJson } from "./utils/fail";
import { getBidsForPids } from "./routes/math";
import { getConversationHasMetadata } from "./routes/metadata";
import { getConversationInfo } from "./conversation";
import { getPca } from "./utils/pca";
import { getSocialParticipants } from "./participant";
import { getUserInfoForUid2 } from "./user";
import { getZinvite, getZinvites } from "./utils/zinvite";
import { ifDefinedFirstElseSecond, polisTypes } from "./utils/common";
import { MPromise } from "./utils/metered";
import { PcaCacheItem } from "./utils/pca";
import { sendTextEmail } from "./email/senders";
import { UserInfo } from "./d";
import Config from "./config";
import logger from "./utils/logger";
import pg from "./db/pg-query";

// TODO consider "p2a24a2dadadu15" format
const votesForZidPidCache = new LruCache({
  max: 5000,
});

function browserSupportsPushState(req: { headers?: { [x: string]: string } }) {
  return !/MSIE [23456789]/.test(req?.headers?.["user-agent"] || "");
}

/**
 * Safely converts a database timestamp value to Unix milliseconds
 * Handles various formats returned by PostgreSQL and always falls back to current time for invalid timestamps
 * @param timestamp - Raw timestamp value from database (could be string, number, Date, or null)
 * @returns Unix timestamp in milliseconds (always a valid number)
 */
function safeTimestampToMillis(timestamp: any): number {
  // Handle undefined/null
  if (_.isUndefined(timestamp) || timestamp === null) {
    return Date.now();
  }

  // If already a Date object, validate it
  if (timestamp instanceof Date) {
    const time = timestamp.getTime();
    if (Number.isFinite(time) && time > 0) {
      return time;
    }
    logger.warn("Invalid Date object received", {
      timestamp,
      time,
    });
    return Date.now();
  }

  // Handle numeric timestamps (Unix timestamps in milliseconds or seconds)
  if (typeof timestamp === "number") {
    if (!Number.isFinite(timestamp) || timestamp <= 0) {
      logger.warn("Invalid numeric timestamp", { timestamp });
      return Date.now();
    }

    // If timestamp looks like Unix seconds (less than year 2100 in milliseconds)
    const timestampMs =
      timestamp < 4102444800000 && timestamp > 1000000000
        ? timestamp * 1000
        : timestamp;
    const date = new Date(timestampMs);
    const time = date.getTime();

    if (Number.isFinite(time) && time > 0) {
      return time;
    }
    logger.warn("Numeric timestamp resulted in invalid Date", {
      timestamp,
      timestampMs,
      time,
    });
    return Date.now();
  }

  // Handle string timestamps
  if (typeof timestamp === "string") {
    if (timestamp.trim() === "") {
      return Date.now();
    }

    // Try parsing as number first (for string numbers)
    const numericValue = parseFloat(timestamp);
    if (!isNaN(numericValue) && Number.isFinite(numericValue)) {
      return safeTimestampToMillis(numericValue);
    }

    // Try parsing as ISO date string
    const date = new Date(timestamp);
    const time = date.getTime();
    if (Number.isFinite(time) && time > 0) {
      return time;
    }

    logger.warn("String timestamp could not be parsed", {
      timestamp,
      time,
    });
    return Date.now();
  }

  // Handle any other type
  logger.warn("Unexpected timestamp type", {
    timestamp,
    type: typeof timestamp,
  });
  return Date.now();
}

function getAnswersForConversation(
  zid: number,
  callback: (err: any, available_answers?: any) => void
) {
  pg.query_readOnly(
    "SELECT * from participant_metadata_answers WHERE zid = ($1) AND alive=TRUE;",
    [zid],
    function (err: any, x: { rows: any }) {
      if (err) {
        callback(err);
        return;
      }
      callback(null, x.rows);
    }
  );
}

function userHasAnsweredZeQuestions(zid: number, answers: string | any[]) {
  return MPromise(
    "userHasAnsweredZeQuestions",
    function (
      resolve: (value: unknown) => void,
      reject: (reason?: any) => void
    ) {
      getAnswersForConversation(
        zid,
        function (err: any, available_answers: any) {
          if (err) {
            reject(err);
            return;
          }

          const q2a = _.indexBy(available_answers, "pmqid");
          const a2q = _.indexBy(available_answers, "pmaid");
          for (let i = 0; i < answers.length; i++) {
            const pmqid = a2q[answers[i]].pmqid;
            delete q2a[pmqid];
          }
          const remainingKeys = _.keys(q2a);
          const missing = remainingKeys && remainingKeys.length > 0;
          if (missing) {
            return reject(
              new Error(
                "polis_err_metadata_not_chosen_pmqid_" + remainingKeys[0]
              )
            );
          } else {
            return resolve(true);
          }
        }
      );
    }
  );
}

function addConversationIds(a: any[]) {
  const zids = [];
  for (let i = 0; i < a.length; i++) {
    if (a[i].zid) {
      zids.push(a[i].zid);
    }
  }
  if (!zids.length) {
    return Promise.resolve(a);
  }
  return getZinvites(zids).then(function (zid2conversation_id: {
    [x: string]: any;
  }) {
    return a.map(function (o: { conversation_id: any; zid: string | number }) {
      o.conversation_id = zid2conversation_id[o.zid];
      return o;
    });
  });
}

function addConversationId(
  o: { zid?: number; conversation_id?: string },
  dontUseCache: any
) {
  if (!o.zid) {
    // if no zid, resolve without fetching zinvite.
    return Promise.resolve(o);
  }
  return getZinvite(o.zid, dontUseCache).then(function (
    conversation_id: string
  ) {
    o.conversation_id = conversation_id;
    return o;
  });
}

function finishOne(
  res: {
    status: (arg0: any) => {
      (): any;
      new (): any;
      json: { (arg0: any): void; new (): any };
    };
  },
  o: { url?: string; zid?: number; currentPid?: number },
  dontUseCache?: boolean | undefined,
  altStatusCode?: number | undefined
) {
  addConversationId(o, dontUseCache)
    .then(
      function (item: { zid: number }) {
        // ensure we don't expose zid
        if (item.zid) {
          delete item.zid;
        }
        const statusCode = altStatusCode || 200;
        res.status(statusCode).json(item);
      },
      function (err: any) {
        failJson(res, 500, "polis_err_finishing_responseA", err);
      }
    )
    .catch(function (err: any) {
      failJson(res, 500, "polis_err_finishing_response", err);
    });
}

function finishArray(
  res: {
    status: (arg0: number) => {
      (): any;
      new (): any;
      json: { (arg0: any): void; new (): any };
    };
  },
  a: any
) {
  addConversationIds(a)
    .then(
      function (items: string | any[]) {
        // ensure we don't expose zid
        if (items) {
          for (let i = 0; i < items.length; i++) {
            if (items[i].zid) {
              delete items[i].zid;
            }
          }
        }
        res.status(200).json(items);
      },
      function (err: any) {
        failJson(res, 500, "polis_err_finishing_response2A", err);
      }
    )
    .catch(function (err: any) {
      failJson(res, 500, "polis_err_finishing_response2", err);
    });
}

function doFamousQuery(o?: {
  uid?: number;
  zid: number;
  math_tick: any;
  ptptoiLimit: any;
}) {
  const uid = o?.uid;
  const zid = o?.zid;
  const math_tick = o?.math_tick;

  // NOTE: if this API is running slow, it's probably because fetching the PCA from pg is slow, and PCA caching is disabled

  // let softLimit = 26;
  const hardLimit = _.isUndefined(o?.ptptoiLimit) ? 30 : o?.ptptoiLimit;
  // let ALLOW_NON_FRIENDS_WHEN_EMPTY_SOCIAL_RESULT = true;
  const mod = 0; // for now, assume all conversations will show unmoderated and approved participants.

  function getAuthorUidsOfFeaturedComments() {
    return getPca(zid, 0).then((pcaResult: PcaCacheItem | unknown) => {
      if (
        !pcaResult ||
        typeof pcaResult !== "object" ||
        pcaResult === null ||
        !("asPOJO" in pcaResult)
      ) {
        return [];
      }

      interface PcaData {
        consensus?: {
          agree?: Array<{ tid: number }>;
          disagree?: Array<{ tid: number }>;
        };
        repness?: {
          [gid: string]: Array<{ tid: number }>;
        };
      }

      const pcaData = (pcaResult as { asPOJO: PcaData }).asPOJO;
      pcaData.consensus = pcaData.consensus || {};
      pcaData.consensus.agree = pcaData.consensus.agree || [];
      pcaData.consensus.disagree = pcaData.consensus.disagree || [];
      const consensusTids = _.union(
        _.pluck(pcaData.consensus.agree, "tid"),
        _.pluck(pcaData.consensus.disagree, "tid")
      );

      let groupTids: number[] = [];
      for (const gid in pcaData.repness) {
        const commentData = pcaData.repness[gid];
        groupTids = _.union(groupTids, _.pluck(commentData, "tid"));
      }
      let featuredTids = _.union(consensusTids, groupTids);
      featuredTids.sort();
      featuredTids = _.uniq(featuredTids);

      if (featuredTids.length === 0) {
        return [];
      }
      const q =
        "with " +
        "authors as (select distinct(uid) from comments where zid = ($1) and tid in (" +
        featuredTids.join(",") +
        ") order by uid) " +
        "select authors.uid from authors inner join xids on xids.uid = authors.uid " +
        "order by uid;";

      return pg.queryP_readOnly(q, [zid]).then(function (comments: any) {
        let uids = _.pluck(comments, "uid");
        uids = _.uniq(uids);
        return uids;
      });
    });
  }
  return Promise.all([
    getConversationInfo(zid),
    getAuthorUidsOfFeaturedComments(),
  ]).then(function (a: any[]) {
    const conv = a[0];
    const authorUids = a[1];

    if (conv.is_anon) {
      return {};
    }

    return Promise.all([
      getSocialParticipants(zid, uid, hardLimit, mod, math_tick, authorUids),
    ]).then(function (stuff: any[]) {
      let participantsWithSocialInfo: any[] = stuff[0] || [];

      participantsWithSocialInfo = participantsWithSocialInfo.map(function (p: {
        priority: number;
      }) {
        const x = pullXInfoIntoSubObjects(p);

        if (p.priority === 1000) {
          x.isSelf = true;
        }
        return x;
      });

      let pids = participantsWithSocialInfo.map(function (p: { pid: number }) {
        return p.pid;
      });

      const pidToData = _.indexBy(participantsWithSocialInfo, "pid"); // TODO this is extra work, probably not needed after some rethinking

      pids.sort(function (a: number, b: number) {
        return a - b;
      });
      pids = _.uniq(pids, true);

      return getVotesForZidPidsWithTimestampCheck(zid, pids, math_tick).then(
        function (vectors: any) {
          // TODO parallelize with above query
          return getBidsForPids(zid, -1, pids).then(
            function (pidsToBids: { [x: string]: any }) {
              _.each(vectors, function (value: any, pid: number) {
                const bid = pidsToBids[pid];
                const notInBucket = _.isUndefined(bid);
                const isSelf = pidToData[pid].isSelf;
                if (notInBucket && !isSelf) {
                  // pidToData[pid].ignore = true;
                  // if the participant isn't in a bucket, they probably haven't voted enough
                  // for the math worker to bucketize them.
                  delete pidToData[pid];
                } else if (pidToData[pid]) {
                  // no separator, like this "adupuuauuauupuuu";
                  pidToData[pid].votes = value;
                  pidToData[pid].bid = bid;
                }
              });
              return pidToData;
            },
            function () {
              // looks like there is no pca yet, so nothing to return.
              return {};
            }
          );
        }
      );
    });
  });
} // end doFamousQuery

function updateConversationModifiedTime(zid: number, t?: Date | number) {
  // If no timestamp provided, use the database's now_as_millis() function
  if (_.isUndefined(t)) {
    const query =
      "update conversations set modified = now_as_millis() where zid = ($1);";
    return pg.queryP(query, [zid]);
  }

  // Use the safe timestamp conversion utility
  const timestampInMillis = safeTimestampToMillis(t);

  const query =
    "update conversations set modified = ($2) where zid = ($1) and modified < ($2);";
  return pg.queryP(query, [zid, timestampInMillis]);
}

function updateLastInteractionTimeForConversation(zid: number, uid?: number) {
  return pg.queryP(
    "update participants set last_interaction = now_as_millis(), nsli = 0 where zid = ($1) and uid = ($2);",
    [zid, uid]
  );
}

function updateVoteCount(zid: number, pid: number) {
  return pg.queryP(
    "update participants set vote_count = (select count(*) from votes where zid = ($1) and pid = ($2)) where zid = ($1) and pid = ($2)",
    [zid, pid]
  );
}

function addStar(
  zid: number,
  tid: number,
  pid: number,
  starred: number,
  created?: Date | number
) {
  starred = starred ? 1 : 0;

  if (_.isUndefined(created)) {
    const query =
      "INSERT INTO stars (pid, zid, tid, starred, created) VALUES ($1, $2, $3, $4, default) RETURNING created;";
    const params = [pid, zid, tid, starred];
    return pg.queryP(query, params);
  }

  // Use the safe timestamp conversion utility
  const timestampInMillis = safeTimestampToMillis(created);

  const query =
    "INSERT INTO stars (pid, zid, tid, starred, created) VALUES ($1, $2, $3, $4, $5) RETURNING created;";
  const params = [pid, zid, tid, starred, timestampInMillis];
  return pg.queryP(query, params);
}

// NOTE: only call this in response to a vote. Don't call this from a poll, like /api/v3/nextComment
function addNoMoreCommentsRecord(zid: number, pid: number) {
  return pg.queryP(
    "insert into event_ptpt_no_more_comments (zid, pid, votes_placed) values ($1, $2, " +
      "(select count(*) from votes where zid = ($1) and pid = ($2)))",
    [zid, pid]
  );
}

function pullXInfoIntoSubObjects(ptptoiRecord: any) {
  const p = ptptoiRecord;
  if (p.x_profile_image_url || p.xid || p.x_email) {
    p.xInfo = {};
    p.xInfo.x_profile_image_url = p.x_profile_image_url;
    p.xInfo.xid = p.xid;
    p.xInfo.x_name = p.x_name;
    // p.xInfo.x_email = p.x_email;
    delete p.x_profile_image_url;
    delete p.xid;
    delete p.x_name;
    delete p.x_email;
  }
  return p;
}

// returns {pid -> "adadddadpupuuuuuuuu"}
function getVotesForZidPidsWithTimestampCheck(
  zid: number,
  pids: number[],
  math_tick: any
) {
  let cachedVotes = pids.map(function (pid: number) {
    return {
      pid: pid,
      votes: getVotesForZidPidWithTimestampCheck(zid, pid, math_tick),
    };
  });
  const uncachedPids = cachedVotes
    .filter(function (o: { votes: any }) {
      return !o.votes;
    })
    .map(function (o: { pid: number }) {
      return o.pid;
    });
  cachedVotes = cachedVotes.filter(function (o: { votes: any }) {
    return !!o.votes;
  });

  function toObj(items: string | any[]) {
    const o = {};
    for (let i = 0; i < items.length; i++) {
      o[items[i].pid] = items[i].votes;
    }
    return o;
  }

  if (uncachedPids.length === 0) {
    return Promise.resolve(toObj(cachedVotes));
  }
  return getVotesForPids(zid, uncachedPids).then(function (votesRows: any) {
    const newPidToVotes = aggregateVotesToPidVotesObj(votesRows);
    _.each(newPidToVotes, function (votes: any, pidStr: string) {
      const pid = Number(pidStr);
      cacheVotesForZidPidWithTimestamp(zid, pid, math_tick, votes);
    });
    const cachedPidToVotes = toObj(cachedVotes);
    return Object.assign(newPidToVotes, cachedPidToVotes);
  });
}

function getVotesForZidPidWithTimestampCheck(
  zid: number,
  pid: number,
  math_tick: number
): string | null {
  const key = zid + "_" + pid;
  const cachedVotes = votesForZidPidCache.get(key) as string | undefined;
  if (cachedVotes) {
    const pair = cachedVotes.split(":");
    const cachedTime = Number(pair[0]);
    const votes = pair[1];
    if (cachedTime >= math_tick) {
      return votes;
    }
  }
  return null;
}

function getVotesForPids(zid: number, pids: number[]): Promise<any[]> {
  if (pids.length === 0) {
    return Promise.resolve([]);
  }
  return pg
    .queryP_readOnly(
      "select * from votes where zid = ($1) and pid in (" +
        pids.join(",") +
        ") order by pid, tid, created;",
      [zid]
    )
    .then(function (votesRows: any[]) {
      for (let i = 0; i < votesRows.length; i++) {
        votesRows[i].weight = votesRows[i].weight / 32767;
      }
      return votesRows;
    });
}

function createEmptyVoteVector(greatestTid: number): string[] {
  const a: string[] = [];
  for (let i = 0; i <= greatestTid; i++) {
    a[i] = "u"; // (u)nseen
  }
  return a;
}

function aggregateVotesToPidVotesObj(votes: any[]): { [key: string]: string } {
  let i = 0;
  let greatestTid = 0;
  for (i = 0; i < votes.length; i++) {
    if (votes[i].tid > greatestTid) {
      greatestTid = votes[i].tid;
    }
  }

  // use arrays or strings?
  const vectors: { [key: string]: string[] } = {}; // pid -> sparse array
  for (i = 0; i < votes.length; i++) {
    const v = votes[i];
    // set up a vector for the participant, if not there already
    vectors[v.pid] = vectors[v.pid] || createEmptyVoteVector(greatestTid);
    // assign a vote value at that location
    const vote = v.vote;
    if (polisTypes.reactions.push === vote) {
      vectors[v.pid][v.tid] = "d";
    } else if (polisTypes.reactions.pull === vote) {
      vectors[v.pid][v.tid] = "a";
    } else if (polisTypes.reactions.pass === vote) {
      vectors[v.pid][v.tid] = "p";
    } else {
      logger.error("unknown vote value");
      // let it stay 'u'
    }
  }
  const vectors2: { [key: string]: string } = {};
  _.each(vectors, function (val: string[], key: string) {
    vectors2[key] = val.join("");
  });
  return vectors2;
}

function cacheVotesForZidPidWithTimestamp(
  zid: number,
  pid: number,
  math_tick: string,
  votes: string
) {
  const key = zid + "_" + pid;
  const val = math_tick + ":" + votes;
  votesForZidPidCache.set(key, val);
}

function sendEmailByUid(uid?: any, subject?: string, body?: string | number) {
  return getUserInfoForUid2(uid).then(function (userInfo: UserInfo) {
    return sendTextEmail(
      Config.polisFromAddress,
      userInfo.hname ? `${userInfo.hname} <${userInfo.email}>` : userInfo.email,
      subject,
      body
    );
  });
}

function getConversationTranslations(zid: number, lang: string) {
  const firstTwoCharsOfLang = lang.substr(0, 2);
  return pg.queryP(
    "select * from conversation_translations where zid = ($1) and lang = ($2);",
    [zid, firstTwoCharsOfLang]
  );
}

function getConversationTranslationsMinimal(zid: number, lang: string) {
  if (!lang) {
    return Promise.resolve([]);
  }
  return getConversationTranslations(zid, lang).then(function (
    rows: string | any[]
  ) {
    for (let i = 0; i < rows.length; i++) {
      delete rows[i].zid;
      delete rows[i].created;
      delete rows[i].modified;
      delete rows[i].src;
    }
    return rows;
  });
}

function getOneConversation(zid: number, uid?: number, lang?: string) {
  return new Promise(function (resolve: any, _reject: any) {
    Promise.all([
      pg.queryP_readOnly(
        "select * from conversations left join  (select uid, site_id from users) as u on conversations.owner = u.uid where conversations.zid = ($1);",
        [zid]
      ),
      getConversationHasMetadata(zid),
      _.isUndefined(uid) ? Promise.resolve({}) : getUserInfoForUid2(uid),
      getConversationTranslationsMinimal(zid, lang),
    ]).then(function (results: any[]) {
      const conv = results[0] && results[0][0];
      const convHasMetadata = results[1];
      const requestingUserInfo = results[2];
      const translations = results[3];

      conv.auth_opt_allow_3rdparty = ifDefinedFirstElseSecond(
        conv.auth_opt_allow_3rdparty,
        true
      );

      conv.translations = translations;

      return getUserInfoForUid2(conv.owner).then(function (
        ownerInfo: UserInfo
      ) {
        const ownername = ownerInfo.hname;
        if (convHasMetadata) {
          conv.hasMetadata = true;
        }
        if (!_.isUndefined(ownername) && conv.context !== "hongkong2014") {
          conv.ownername = ownername;
        }
        conv.is_mod =
          uid !== undefined && conv.site_id === requestingUserInfo.site_id;
        conv.is_owner = uid !== undefined && conv.owner === uid;
        delete conv.uid; // conv.owner is what you want, uid shouldn't be returned.
        resolve(conv);
      });
    });
  });
}

function buildConversationUrl(req: any, zinvite: string | null) {
  return Config.getServerNameWithProtocol(req) + "/" + zinvite;
}

export {
  addConversationIds,
  addNoMoreCommentsRecord,
  addStar,
  browserSupportsPushState,
  buildConversationUrl,
  doFamousQuery,
  finishArray,
  finishOne,
  getOneConversation,
  pullXInfoIntoSubObjects,
  safeTimestampToMillis,
  sendEmailByUid,
  updateConversationModifiedTime,
  updateLastInteractionTimeForConversation,
  updateVoteCount,
  userHasAnsweredZeQuestions,
};
