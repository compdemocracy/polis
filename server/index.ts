/**
 * Server entry point
 * This file is responsible for starting the server after the app is configured
 */
import app from "./app";
import Config from "./src/config";
import pg from "./src/db/pg-query";
import { startNotificationLoop } from "./src/routes/notify";
import logger from "./src/utils/logger";
import {
  VoteConventionStartupError,
  requireDeclaredConvention,
} from "./src/votes/dbConvention";

if (Config.nodeEnv === "production") {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars, @typescript-eslint/no-var-requires
  const tracer = require("dd-trace").init();
}

/**
 * Start the server on the configured port or a provided port
 * @param {number} [port=Config.serverPort] - The port to listen on
 * @returns {Object} The server instance
 */
function startServer(port = Config.serverPort) {
  const server = app.listen(port);
  logger.info(`Server started on port ${port}`);
  return server;
}

// The database must declare its stored vote sign, and it must be the sign
// this build is built for (P-078; docs/vote-convention-upgrade.md). Nothing
// listens until it does; a refusal exits 1 with the operator message.
const primary = (sql: string) =>
    pg.queryP(sql) as Promise<Array<Record<string, unknown>>>;
const replica =
  Config.databaseURL === Config.readOnlyDatabaseURL
    ? undefined
    : (sql: string) =>
        pg.queryP_readOnly(sql) as Promise<Array<Record<string, unknown>>>;

requireDeclaredConvention(primary, "server", replica).then(
  (convention) => {
    logger.info(
      `vote convention: version ${convention.version}, agree stored as ${convention.agreeValue}`
    );
    startNotificationLoop();
    startServer();
  },
  (err: unknown) => {
    if (err instanceof VoteConventionStartupError) {
      logger.error(err.message);
    } else {
      logger.error("failed to read the database's vote convention", err);
    }
    process.exit(1);
  }
);

export { startServer };
export default app;
