import { createLogger, format, transports } from "winston";
import Config from "../config";

const devMode = Config.isDevMode;
// See https://github.com/winstonjs/winston#logging-levels
const logLevel = Config.logLevel || "warn";
const logToFile = Config.logToFile;

// Console transport:
// - In dev, emit colorful, human-readable logs
// - In prod, emit structured JSON logs friendly to Datadog
const consoleTransport = new transports.Console({
  format: devMode
    ? format.combine(format.colorize(), format.simple())
    : format.combine(
        format.uncolorize(),
        format.timestamp(),
        format.errors({ stack: true }),
        format.json()
      ),
  level: logLevel,
});

const logger = createLogger({
  level: logLevel,
  exitOnError: false,
  // Base formatter (transport may override). Keep JSON capability always available.
  format: format.combine(
    format.timestamp(),
    format.errors({ stack: true }),
    format.json()
  ),
  defaultMeta: { service: "server" },
  // Write only to console by default, unless the logToFile config is set.
  transports: [consoleTransport],
});

if (logToFile) {
  logger.configure({
    //
    // - Write all logs with importance level of `error` or less to `error.log`
    // - Write all logs with importance level of `info` or less to `combined.log`
    //
    transports: [
      new transports.File({
        filename: "./logs/error.log",
        level: "error",
      }),
      new transports.File({
        filename: "./logs/combined.log",
      }),
      // Additionally, write all logs to the console as above.
      consoleTransport,
    ],
    exceptionHandlers: [
      new transports.File({ filename: "./logs/exceptions.log" }),
    ],
    rejectionHandlers: [
      new transports.File({ filename: "./logs/rejections.log" }),
    ],
  });
}

export default logger;
