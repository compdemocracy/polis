import _ from "underscore";
import LruCache from "lru-cache";

import pg from "./db/pg-query";

import {
  createXidRecord,
  getXidRecord,
  getConversationInfo,
  isXidWhitelisted,
} from "./conversation";
import logger from "./utils/logger";
import { UserInfo, XidInfo } from "./d";
import Config from "./config";

interface UserResponse {
  uid: number;
  email?: string;
  hname?: string;
  hasXid: boolean;
  xInfo?: any;
  finishedTutorial: boolean;
  site_ids: number[];
  created: number;
}

const pidCache: LruCache<string, number> = new LruCache({
  max: 9000,
});

async function getUserInfoForUid2(uid: number): Promise<UserInfo> {
  return new Promise((resolve, reject) => {
    pg.query_readOnly(
      "SELECT * from users where uid = $1",
      [uid],
      function (err: any, results: { rows: UserInfo[] }) {
        if (err) {
          return reject(err);
        }
        if (!results.rows || !results.rows.length) {
          return reject(new Error("User not found"));
        }
        resolve(results.rows[0]);
      }
    );
  });
}

async function getUser(
  uid: number,
  zid_optional?: number,
  xid_optional?: string,
  owner_uid_optional?: number
): Promise<UserResponse | {}> {
  if (!uid) {
    // this api may be called by a new user, so we don't want to trigger a failure here.
    return {};
  }

  let xidInfoPromise: Promise<XidInfo[] | null> = Promise.resolve(null);

  if (zid_optional && xid_optional) {
    xidInfoPromise = getXidRecord(xid_optional, zid_optional);
  } else if (xid_optional && owner_uid_optional) {
    xidInfoPromise = getXidRecordByXidOwnerId(
      xid_optional,
      owner_uid_optional,
      zid_optional,
      null,
      null,
      null,
      false
    );
  }

  const [info, xInfo] = await Promise.all([
    getUserInfoForUid2(uid),
    xidInfoPromise,
  ]);

  const hasXid = xInfo && xInfo.length && xInfo[0];

  if (hasXid) {
    delete xInfo[0].owner;
    delete xInfo[0].created;
  }

  return {
    uid: uid,
    email: info.email,
    hname: info.hname,
    hasXid: !!hasXid,
    xInfo: xInfo && xInfo[0],
    finishedTutorial: !!info.tut,
    site_ids: [info.site_id],
    created: Number(info.created),
  };
}

async function createAnonUser(): Promise<number> {
  return new Promise((resolve, reject) => {
    pg.query(
      "INSERT INTO users (created) VALUES (default) RETURNING uid;",
      [],
      function (err: any, results: { rows: { uid: number }[] }) {
        if (err || !results || !results.rows || !results.rows.length) {
          logger.error("polis_err_create_empty_user", err);
          reject(new Error("polis_err_create_empty_user"));
          return;
        }
        resolve(results.rows[0].uid);
      }
    );
  });
}

// returns a pid of -1 if it's missing
function getPid(
  zid: number,
  uid: number,
  callback: (err: any, pid: number) => void
): void {
  const cacheKey = zid + "_" + uid;
  const cachedPid = pidCache.get(cacheKey);
  if (!_.isUndefined(cachedPid)) {
    callback(null, cachedPid);
    return;
  }
  pg.query_readOnly(
    "SELECT pid FROM participants WHERE zid = ($1) AND uid = ($2);",
    [zid, uid],
    function (err: any, docs: { rows: { pid: number }[] }) {
      let pid = -1;
      if (docs && docs.rows && docs.rows[0]) {
        pid = docs.rows[0].pid;
        pidCache.set(cacheKey, pid);
      }
      callback(err, pid);
    }
  );
}

// returns a pid of -1 if it's missing
async function getPidPromise(
  zid: number,
  uid: number,
  usePrimary?: boolean
): Promise<number> {
  const cacheKey = zid + "_" + uid;
  const cachedPid = pidCache.get(cacheKey);

  if (!_.isUndefined(cachedPid)) {
    return cachedPid;
  }

  return new Promise((resolve, reject) => {
    const queryFunction = usePrimary ? pg.query : pg.query_readOnly;
    queryFunction(
      "SELECT pid FROM participants WHERE zid = ($1) AND uid = ($2);",
      [zid, uid],
      function (err: any, results: { rows: { pid: number }[] }) {
        if (err) {
          logger.error("getPidPromise query error", {
            zid: zid,
            uid: uid,
            error: err,
          });
          return reject(err);
        }
        if (!results || !results.rows || !results.rows.length) {
          resolve(-1);
          return;
        }
        const pid = results.rows[0].pid;
        pidCache.set(cacheKey, pid);
        resolve(pid);
      }
    );
  });
}

// must follow auth and need('zid'...) middleware
function getPidForParticipant(
  assigner: (req: any, key: string, value: any) => void
) {
  return function (
    req: { p: { zid: string; uid: string } },
    res: any,
    next: (err?: string) => void
  ) {
    const zid = Number(req.p.zid);
    const uid = Number(req.p.uid);

    function finish(pid: number) {
      assigner(req, "pid", pid);
      next();
    }

    getPidPromise(zid, uid).then(
      function (pid: number) {
        if (pid === -1) {
          const msg = "polis_err_get_pid_for_participant_missing";
          logger.error(msg, {
            zid,
            uid,
            p: req.p,
          });
          next(msg);
          return;
        }
        finish(pid);
      },
      function (err: any) {
        logger.error("polis_err_get_pid_for_participant", err);
        next(err);
      }
    );
  };
}

async function getXidRecordByXidOwnerId(
  xid: string,
  owner: number,
  zid_optional?: number,
  x_profile_image_url?: string,
  x_name?: string,
  x_email?: string,
  createIfMissing?: boolean
): Promise<XidInfo[] | null> {
  const rows = (await pg.queryP(
    "select * from xids where xid = ($1) and owner = ($2);",
    [xid, owner]
  )) as XidInfo[];

  if (!rows || !rows.length) {
    logger.warn("getXidRecordByXidOwnerId: no xInfo yet");
    if (!createIfMissing) {
      return null;
    }

    const shouldCreateXidEntry = !zid_optional
      ? true
      : await getConversationInfo(zid_optional).then((conv) => {
          return conv.use_xid_whitelist ? isXidWhitelisted(owner, xid) : true;
        });

    if (!shouldCreateXidEntry) {
      return null;
    }

    const newUid = await createAnonUser();
    await createXidRecord(
      owner,
      newUid,
      xid,
      x_profile_image_url || null,
      x_name || null,
      x_email || null
    );

    return [
      {
        uid: newUid,
        owner: owner,
        xid: xid,
        x_profile_image_url: x_profile_image_url,
        x_name: x_name,
        x_email: x_email,
      },
    ];
  }

  return rows;
}

async function getXidStuff(
  xid: string,
  zid: number
): Promise<string | (XidInfo & { pid: number })> {
  const rows = await getXidRecord(xid, zid);

  if (!rows || !rows.length) {
    return "noXidRecord";
  }

  const xidRecordForPtpt = rows[0];
  if (xidRecordForPtpt) {
    const pidForXid = await getPidPromise(zid, xidRecordForPtpt.uid, true);
    return {
      ...xidRecordForPtpt,
      pid: pidForXid,
    };
  }

  return xidRecordForPtpt as XidInfo & { pid: number };
}

/**
 * Get or create a user ID based on Auth0 subject (sub)
 * This function handles the Auth0 → local user mapping using the auth0_user_mappings table
 * Uses database-level upsert operations to handle race conditions more robustly
 */
async function getOrCreateUserIDFromAuth0Sub(
  auth0Sub: string,
  auth0User: any
): Promise<number> {
  // Extract email from either standard claims or custom namespace claims
  const namespace = Config.authNamespace;
  const email = auth0User.email || auth0User[`${namespace}email`];
  const name =
    auth0User.name || auth0User[`${namespace}name`] || auth0User.nickname;

  // Validate required fields upfront
  if (!email) {
    throw new Error(
      `Auth0 user missing email. Sub: ${auth0Sub}, User: ${JSON.stringify(
        auth0User
      )}`
    );
  }

  const displayName = name || auth0User.nickname || email.split("@")[0];
  const username = auth0User.nickname || email.split("@")[0];

  // Use a single transaction to handle the entire user creation/mapping process
  // This prevents race conditions by ensuring atomicity
  try {
    const result = await new Promise<number>((resolve, reject) => {
      pg.query("BEGIN", [], (beginErr: any) => {
        if (beginErr) {
          logger.error("Failed to begin transaction:", beginErr);
          return reject(beginErr);
        }

        // First, try to get existing mapping
        pg.query(
          "SELECT uid FROM auth0_user_mappings WHERE auth0_sub = $1",
          [auth0Sub],
          (mappingErr: any, mappingResult: { rows: any[] }) => {
            if (mappingErr) {
              return pg.query("ROLLBACK", [], () => reject(mappingErr));
            }

            if (mappingResult.rows.length > 0) {
              // Mapping exists, commit and return
              const uid = mappingResult.rows[0].uid;
              return pg.query("COMMIT", [], (commitErr: any) => {
                if (commitErr) return reject(commitErr);
                resolve(uid);
              });
            }

            // No mapping exists, so we need to create user and/or mapping
            // Use improved upsert approach that handles constraint violations better
            const upsertUserQuery = `
              INSERT INTO users (email, hname, username, is_owner, created) 
              VALUES ($1, $2, $3, $4, now_as_millis())
              ON CONFLICT (email) DO UPDATE SET
                hname = EXCLUDED.hname,
                username = EXCLUDED.username
              RETURNING uid
            `;

            pg.query(
              upsertUserQuery,
              [email, displayName, username, true],
              (userErr: any, userResult: { rows: { uid: number }[] }) => {
                if (userErr) {
                  return pg.query("ROLLBACK", [], () => reject(userErr));
                }

                if (!userResult.rows.length) {
                  return pg.query("ROLLBACK", [], () =>
                    reject(new Error("Failed to create or find user"))
                  );
                }

                const uid = userResult.rows[0].uid;

                // Check if this uid already has a mapping to a different auth0_sub
                pg.query(
                  "SELECT auth0_sub FROM auth0_user_mappings WHERE uid = $1",
                  [uid],
                  (
                    existingMappingErr: any,
                    existingMappingResult: { rows: any[] }
                  ) => {
                    if (existingMappingErr) {
                      return pg.query("ROLLBACK", [], () =>
                        reject(existingMappingErr)
                      );
                    }

                    if (existingMappingResult.rows.length > 0) {
                      const existingAuth0Sub =
                        existingMappingResult.rows[0].auth0_sub;
                      if (existingAuth0Sub === auth0Sub) {
                        // Same mapping already exists, just return the uid
                        return pg.query("COMMIT", [], (commitErr: any) => {
                          if (commitErr) return reject(commitErr);
                          logger.info(
                            `Mapping already exists for Auth0 sub ${auth0Sub}: uid ${uid}`
                          );
                          resolve(uid);
                        });
                      } else {
                        // Different Auth0 user is already mapped to this local user
                        // This is a conflict situation - log warning and use existing mapping
                        logger.debug(
                          `Local user ${uid} (${email}) already mapped to Auth0 sub ${existingAuth0Sub}, but ${auth0Sub} is trying to map to it. Using existing mapping.`
                        );
                        return pg.query("COMMIT", [], (commitErr: any) => {
                          if (commitErr) return reject(commitErr);
                          resolve(uid);
                        });
                      }
                    }

                    // No existing mapping for this uid, create new one
                    pg.query(
                      "INSERT INTO auth0_user_mappings (auth0_sub, uid, created) VALUES ($1, $2, now_as_millis()) ON CONFLICT (auth0_sub) DO NOTHING",
                      [auth0Sub, uid],
                      (mappingInsertErr: any) => {
                        if (mappingInsertErr) {
                          return pg.query("ROLLBACK", [], () =>
                            reject(mappingInsertErr)
                          );
                        }

                        // Commit the transaction
                        pg.query("COMMIT", [], (commitErr: any) => {
                          if (commitErr) return reject(commitErr);
                          logger.info(
                            `Successfully created/linked user for Auth0 sub ${auth0Sub}: uid ${uid}`
                          );
                          resolve(uid);
                        });
                      }
                    );
                  }
                );
              }
            );
          }
        );
      });
    });

    return result;
  } catch (error: any) {
    logger.error(
      `Failed to get or create user for Auth0 sub ${auth0Sub}:`,
      error
    );

    // If we still get a constraint violation, it means there was a race condition
    // even with our transaction approach. In this case, make one final attempt
    // to get the existing user and create the mapping
    if (
      error.code === "23505" &&
      (error.constraint === "users_email_key" ||
        error.constraint === "auth0_user_mappings_uid_key")
    ) {
      logger.warn(
        `Constraint violation detected for ${email}, attempting recovery...`
      );

      try {
        // Try to find the existing user and handle mapping conflicts
        const recoveryResult = await new Promise<number>((resolve, reject) => {
          pg.query_readOnly(
            "SELECT uid FROM users WHERE LOWER(email) = LOWER($1)",
            [email],
            (err: any, results: { rows: any[] }) => {
              if (err) return reject(err);
              if (!results.rows.length) {
                return reject(
                  new Error(
                    `User with email ${email} not found during recovery`
                  )
                );
              }

              const uid = results.rows[0].uid;

              // Check if there's already a mapping for this uid
              pg.query_readOnly(
                "SELECT auth0_sub FROM auth0_user_mappings WHERE uid = $1",
                [uid],
                (mappingCheckErr: any, mappingCheckResult: { rows: any[] }) => {
                  if (mappingCheckErr) return reject(mappingCheckErr);

                  if (mappingCheckResult.rows.length > 0) {
                    const existingAuth0Sub =
                      mappingCheckResult.rows[0].auth0_sub;
                    if (existingAuth0Sub === auth0Sub) {
                      // Mapping already exists for this auth0_sub
                      logger.info(
                        `Recovery: mapping already exists for Auth0 sub ${auth0Sub}: uid ${uid}`
                      );
                      resolve(uid);
                    } else {
                      // Different mapping exists - this is expected with test data
                      logger.warn(
                        `Recovery: uid ${uid} already mapped to ${existingAuth0Sub}, not creating new mapping for ${auth0Sub}`
                      );
                      resolve(uid);
                    }
                  } else {
                    // No mapping exists, create one
                    pg.query(
                      "INSERT INTO auth0_user_mappings (auth0_sub, uid, created) VALUES ($1, $2, now_as_millis()) ON CONFLICT (auth0_sub) DO NOTHING",
                      [auth0Sub, uid],
                      (mappingErr: any) => {
                        if (mappingErr) return reject(mappingErr);
                        logger.info(
                          `Recovery successful: linked existing user ${uid} to Auth0 sub ${auth0Sub}`
                        );
                        resolve(uid);
                      }
                    );
                  }
                }
              );
            }
          );
        });

        return recoveryResult;
      } catch (recoveryError) {
        logger.error("Recovery attempt failed:", recoveryError);
        throw new Error(
          `Unable to create or find user for email: ${email}. Original error: ${error.message}, Recovery error: ${recoveryError}`
        );
      }
    }

    throw error;
  }
}

export {
  createAnonUser,
  getOrCreateUserIDFromAuth0Sub,
  getPid,
  getPidForParticipant,
  getPidPromise,
  getUser,
  getUserInfoForUid2,
  getXidStuff,
};
