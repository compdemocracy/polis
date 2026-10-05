"use strict";
/**
 * The harness drops and rebuilds a Postgres database and EVERY Delphi table
 * on the stores it is given. These checks make it refuse anything but its own
 * throwaway stores, before any destructive step:
 *
 *  1. Both URLs are loopback and on the harness's own ports (compose.yml binds
 *     exactly these; CI uses the same): Postgres 5481, DynamoDB 8481. A
 *     developer's dev DynamoDB (localhost:8000) or dev Postgres (5432) is
 *     refused before a connection is opened.
 *  2. The Postgres server holds no database but postgres, the templates and
 *     the harness's own `csrec`.
 *  3. The DynamoDB store is either empty (a fresh throwaway store, which the
 *     harness then claims by creating the sentinel table) or already carries
 *     the sentinel. A store with tables and no sentinel is someone's data.
 */
const LOOPBACK = new Set(["127.0.0.1", "localhost", "[::1]", "::1"]);
const PG_PORT = "5481";
const DYNAMO_PORT = "8481";
const SENTINEL = "CsrecThrowawayStore";
const PG_DATABASES = new Set(["postgres", "template0", "template1", "csrec"]);

function checkUrls(pgUrl, dynamoUrl) {
  const problems = [];
  const pg = new URL(pgUrl);
  const dy = new URL(dynamoUrl);
  if (!LOOPBACK.has(pg.hostname))
    problems.push(`Postgres host ${pg.hostname} is not loopback`);
  if (pg.port !== PG_PORT)
    problems.push(
      `Postgres port ${pg.port || "(default)"} is not the harness's ${PG_PORT}`
    );
  if (!LOOPBACK.has(dy.hostname))
    problems.push(`DynamoDB host ${dy.hostname} is not loopback`);
  if (dy.port !== DYNAMO_PORT)
    problems.push(
      `DynamoDB port ${
        dy.port || "(default)"
      } is not the harness's ${DYNAMO_PORT}`
    );
  return problems;
}

function checkPgDatabases(names) {
  const other = names.filter((n) => !PG_DATABASES.has(n)).sort();
  return other.length
    ? [
        `Postgres holds other databases (${other.join(
          ", "
        )}): not a throwaway server`,
      ]
    : [];
}

/** { claim: create the sentinel first, problems } */
function checkDynamoTables(tables) {
  const list = [...tables];
  if (list.includes(SENTINEL)) return { claim: false, problems: [] };
  if (list.length === 0) return { claim: true, problems: [] };
  return {
    claim: false,
    problems: [
      `DynamoDB holds ${list.length} table(s) and no ${SENTINEL} sentinel: not this harness's throwaway store`,
    ],
  };
}

module.exports = {
  PG_PORT,
  DYNAMO_PORT,
  SENTINEL,
  checkUrls,
  checkPgDatabases,
  checkDynamoTables,
};
