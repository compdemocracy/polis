/** Check the release's migrations before importing the app or starting work. */
import "dotenv/config";
import { checkMigrations } from "./src/db/migrations.cjs";

async function startServer(port?: number) {
  await checkMigrations();
  const { default: Config } = await import("./src/config");
  if (Config.nodeEnv === "production") {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    require("dd-trace").init();
  }
  const { default: app } = await import("./app");
  const { startNotificationLoop } = await import("./src/routes/notify");
  const { default: logger } = await import("./src/utils/logger");
  startNotificationLoop();
  const server = app.listen(port ?? Config.serverPort);
  logger.info(`Server started on port ${port ?? Config.serverPort}`);
  return server;
}

startServer().catch((error) => {
  process.stderr.write(`Server startup refused: ${error.message}\n`);
  process.exit(1);
});
export { startServer };
