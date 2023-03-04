import { createLogger, format, transports } from "winston";
import Config from "../config";

const logger = createLogger({
  level: Config.logLevel || 'info',
  exitOnError: false,
  format: format.combine(
    format.timestamp({
      format: "YYYY-MM-DD HH:mm:ss Z",
    }),
    format.errors({ stack: true }),
    format.json()
  ),
  defaultMeta: { service: "polis-api-server" },
  transports: [
    //
    // - Write all logs with importance level of `error` or less to `error.log`
    // - Write all logs with importance level of `info` or less to `combined.log`
    //
    new transports.File({
      filename: "./logs/error.log",
      level: "error",
    }),
    new transports.File({
      filename: "./logs/combined.log",
    }),
  ],
  exceptionHandlers: [
    new transports.File({ filename: "./logs/exceptions.log" }),
  ],
  rejectionHandlers: [
    new transports.File({ filename: "./logs/rejections.log" }),
  ],
});

//
// If we're not in production then log to the `console` with the format:
// `${info.level}: ${info.message} JSON.stringify({ ...rest }) `
//
if (Config.nodeEnv !== "production") {
  logger.add(
    new transports.Console({
      format: format.combine(format.colorize(), format.simple()),
    })
  );
}

export default logger;
