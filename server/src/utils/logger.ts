import { createLogger, format, transports } from "winston";
import Config from "../config";

// See https://github.com/winstonjs/winston#logging-levels
const logLevel = Config.logLevel || "info";
const logToFile = Config.logToFile;

const consoleTransport = new transports.Console({
  format: format.combine(format.colorize(), format.simple()),
  level: logLevel,
});

const logger = createLogger({
  level: logLevel,
  exitOnError: false,
  format: format.combine(
    format.timestamp({
      format: "YYYY-MM-DD HH:mm:ss Z",
    }),
    format.errors({ stack: true }),
    format.json()
  ),
  defaultMeta: { service: "polis-api-server" },
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
