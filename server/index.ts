/**
 * Server entry point
 * This file is responsible for starting the server after the app is configured
 */
import app from "./app";
import Config from "./src/config";
import logger from "./src/utils/logger";

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

startServer();

export { startServer };
export default app;
