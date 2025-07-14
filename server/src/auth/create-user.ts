import _ from "underscore";
import { generateTokenP } from "./generate-token";
import Config from "../config";
import logger from "../utils/logger";
import pg from "../db/pg-query";

function generateAndRegisterZinvite(zid: number, generateShort: any) {
  let len = 10;
  if (generateShort) {
    len = 6;
  }
  return generateTokenP(len, false).then(function (zinvite: string) {
    return pg
      .queryP(
        "INSERT INTO zinvites (zid, zinvite, created, uuid) VALUES ($1, $2, default, gen_random_uuid());",
        [zid, zinvite]
      )
      .then(function (_rows: any) {
        return zinvite;
      });
  });
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
                        // Different Auth0 user is already mapped to this local user.
                        // This can happen if a user changes the email on their social login,
                        // or deletes and recreates their account. We want the new login to win.
                        logger.warn(
                          `Local user ${uid} (${email}) was mapped to old Auth0 sub ${existingAuth0Sub}. Overwriting with new mapping for ${auth0Sub}.`
                        );

                        // To prevent unique constraint violations on either uid or auth0_sub,
                        // we must first remove any existing mappings that would conflict.
                        const cleanupQuery =
                          "DELETE FROM auth0_user_mappings WHERE auth0_sub = $1 OR uid = $2";

                        pg.query(
                          cleanupQuery,
                          [auth0Sub, uid],
                          (deleteErr: any) => {
                            if (deleteErr) {
                              return pg.query("ROLLBACK", [], () =>
                                reject(deleteErr)
                              );
                            }

                            // Now that the coast is clear, insert the new mapping.
                            pg.query(
                              "INSERT INTO auth0_user_mappings (auth0_sub, uid, created) VALUES ($1, $2, now_as_millis())",
                              [auth0Sub, uid],
                              (insertErr: any) => {
                                if (insertErr) {
                                  return pg.query("ROLLBACK", [], () =>
                                    reject(insertErr)
                                  );
                                }

                                // Success, commit.
                                pg.query("COMMIT", [], (commitErr: any) => {
                                  if (commitErr) return reject(commitErr);
                                  resolve(uid);
                                });
                              }
                            );
                          }
                        );
                      }
                    } else {
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
  generateAndRegisterZinvite,
  getOrCreateUserIDFromAuth0Sub,
};
