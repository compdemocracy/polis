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
 * Get or create a user ID based on OIDC subject (sub)
 * This function handles the OIDC → local user mapping using the oidc_user_mappings table
 * Uses database-level upsert operations to handle race conditions more robustly
 */
async function getOrCreateUserIDFromOidcSub(
  oidcSub: string,
  oidcUser: any,
  retryCount = 0
): Promise<number> {
  const maxRetries = 3;
  const retryDelay = 100 + Math.random() * 200; // 100-300ms jitter

  // Extract email from either standard claims or custom namespace claims
  const namespace = Config.authNamespace;
  const email = oidcUser.email || oidcUser[`${namespace}email`];
  const name =
    oidcUser.name || oidcUser[`${namespace}name`] || oidcUser.nickname;

  // Validate required fields upfront
  if (!email) {
    throw new Error(
      `OIDC user missing email. Sub: ${oidcSub}, User: ${JSON.stringify(
        oidcUser
      )}`
    );
  }

  const displayName = name || oidcUser.nickname || email.split("@")[0];
  const username = oidcUser.nickname || email.split("@")[0];

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
          "SELECT uid FROM oidc_user_mappings WHERE oidc_sub = $1",
          [oidcSub],
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

                // Check if this uid already has a mapping to a different oidc_sub
                pg.query(
                  "SELECT oidc_sub FROM oidc_user_mappings WHERE uid = $1",
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
                      const existingOidcSub =
                        existingMappingResult.rows[0].oidc_sub;
                      if (existingOidcSub === oidcSub) {
                        // Same mapping already exists, just return the uid
                        return pg.query("COMMIT", [], (commitErr: any) => {
                          if (commitErr) return reject(commitErr);
                          logger.info(
                            `Mapping already exists for OIDC sub ${oidcSub}: uid ${uid}`
                          );
                          resolve(uid);
                        });
                      } else {
                        // Different OIDC user is already mapped to this local user.
                        // This can happen if a user changes the email on their social login,
                        // or deletes and recreates their account. We want the new login to win.
                        logger.warn(
                          `Local user ${uid} (${email}) was mapped to old OIDC sub ${existingOidcSub}. Overwriting with new mapping for ${oidcSub}.`
                        );

                        // To prevent unique constraint violations on either uid or oidc_sub,
                        // we must first remove any existing mappings that would conflict.
                        const cleanupQuery =
                          "DELETE FROM oidc_user_mappings WHERE oidc_sub = $1 OR uid = $2";

                        pg.query(
                          cleanupQuery,
                          [oidcSub, uid],
                          (deleteErr: any) => {
                            if (deleteErr) {
                              return pg.query("ROLLBACK", [], () =>
                                reject(deleteErr)
                              );
                            }

                            // Now that the coast is clear, insert the new mapping.
                            pg.query(
                              "INSERT INTO oidc_user_mappings (oidc_sub, uid, created) VALUES ($1, $2, now_as_millis())",
                              [oidcSub, uid],
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
                        "INSERT INTO oidc_user_mappings (oidc_sub, uid, created) VALUES ($1, $2, now_as_millis()) ON CONFLICT (oidc_sub) DO NOTHING",
                        [oidcSub, uid],
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
                              `Successfully created/linked user for OIDC sub ${oidcSub}: uid ${uid}`
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
      `Failed to get or create user for OIDC sub ${oidcSub}:`,
      error
    );

    // Handle specific constraint violations with retry logic
    if (error.code === "23505") {
      // Handle oidc_user_mappings primary key constraint violation
      if (error.constraint === "oidc_user_mappings_pkey") {
        if (retryCount < maxRetries) {
          logger.warn(
            `OIDC mapping constraint violation (attempt ${retryCount + 1}/${
              maxRetries + 1
            }), retrying after ${retryDelay}ms for sub: ${oidcSub}`
          );

          // Wait with jitter to reduce collision probability
          await new Promise((resolve) => setTimeout(resolve, retryDelay));

          // Retry with incremented count
          return getOrCreateUserIDFromOidcSub(
            oidcSub,
            oidcUser,
            retryCount + 1
          );
        } else {
          // Max retries exceeded, try to find existing mapping
          logger.error(
            `Max retries exceeded for OIDC sub ${oidcSub}, attempting final lookup`
          );

          try {
            const finalResult = await new Promise<number>((resolve, reject) => {
              pg.query_readOnly(
                "SELECT uid FROM oidc_user_mappings WHERE oidc_sub = $1",
                [oidcSub],
                (err: any, results: { rows: any[] }) => {
                  if (err) return reject(err);
                  if (!results.rows.length) {
                    return reject(
                      new Error(
                        `OIDC mapping not found after retries for sub: ${oidcSub}`
                      )
                    );
                  }
                  logger.info(
                    `Found existing mapping after retries for OIDC sub ${oidcSub}: uid ${results.rows[0].uid}`
                  );
                  resolve(results.rows[0].uid);
                }
              );
            });
            return finalResult;
          } catch (lookupError) {
            logger.error(
              `Final lookup failed for OIDC sub ${oidcSub}:`,
              lookupError
            );
            throw new Error(
              `Unable to create or find user mapping for OIDC sub: ${oidcSub}. This may be due to high concurrency. Please try again.`
            );
          }
        }
      }

      // Handle other constraint violations (users_email_key, oidc_user_mappings_uid_key)
      else if (
        error.constraint === "users_email_key" ||
        error.constraint === "oidc_user_mappings_uid_key"
      ) {
        logger.warn(
          `Constraint violation detected for ${email}, attempting recovery...`
        );

        try {
          // Try to find the existing user and handle mapping conflicts
          const recoveryResult = await new Promise<number>(
            (resolve, reject) => {
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
                    "SELECT oidc_sub FROM oidc_user_mappings WHERE uid = $1",
                    [uid],
                    (
                      mappingCheckErr: any,
                      mappingCheckResult: { rows: any[] }
                    ) => {
                      if (mappingCheckErr) return reject(mappingCheckErr);

                      if (mappingCheckResult.rows.length > 0) {
                        const existingOidcSub =
                          mappingCheckResult.rows[0].oidc_sub;
                        if (existingOidcSub === oidcSub) {
                          // Mapping already exists for this oidc_sub
                          logger.info(
                            `Recovery: mapping already exists for OIDC sub ${oidcSub}: uid ${uid}`
                          );
                          resolve(uid);
                        } else {
                          // Different mapping exists - this is expected with test data
                          logger.warn(
                            `Recovery: uid ${uid} already mapped to ${existingOidcSub}, not creating new mapping for ${oidcSub}`
                          );
                          resolve(uid);
                        }
                      } else {
                        // No mapping exists, create one
                        pg.query(
                          "INSERT INTO oidc_user_mappings (oidc_sub, uid, created) VALUES ($1, $2, now_as_millis()) ON CONFLICT (oidc_sub) DO NOTHING",
                          [oidcSub, uid],
                          (mappingErr: any) => {
                            if (mappingErr) return reject(mappingErr);
                            logger.info(
                              `Recovery successful: linked existing user ${uid} to OIDC sub ${oidcSub}`
                            );
                            resolve(uid);
                          }
                        );
                      }
                    }
                  );
                }
              );
            }
          );

          return recoveryResult;
        } catch (recoveryError) {
          logger.error("Recovery attempt failed:", recoveryError);
          throw new Error(
            `Unable to create or find user for email: ${email}. Original error: ${error.message}, Recovery error: ${recoveryError}`
          );
        }
      }
    }

    // Re-throw other errors
    throw error;
  }
}

export {
  createAnonUser,
  generateAndRegisterZinvite,
  getOrCreateUserIDFromOidcSub,
};
