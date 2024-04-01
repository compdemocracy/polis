import { createLogger, format, transports } from 'winston';
import Config from '../config.js';
const logLevel = Config.logLevel || 'info';
const logToFile = Config.logToFile;
const consoleTransport = new transports.Console({
  format: format.combine(format.colorize(), format.simple()),
  level: logLevel
});
const logger = createLogger({
  level: logLevel,
  exitOnError: false,
  format: format.combine(
    format.timestamp({
      format: 'YYYY-MM-DD HH:mm:ss Z'
    }),
    format.errors({ stack: true }),
    format.json()
  ),
  defaultMeta: { service: 'polis-api-server' },
  transports: [consoleTransport]
});
if (logToFile) {
  logger.configure({
    transports: [
      new transports.File({
        filename: './logs/error.log',
        level: 'error'
      }),
      new transports.File({
        filename: './logs/combined.log'
      }),
      consoleTransport
    ],
    exceptionHandlers: [new transports.File({ filename: './logs/exceptions.log' })],
    rejectionHandlers: [new transports.File({ filename: './logs/rejections.log' })]
  });
}
export default logger;
