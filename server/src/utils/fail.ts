import logger from "./logger";

export default function fail(
  res: any,
  httpCode: any,
  clientVisibleErrorString: any,
  err?: any
) {
  logger.error(clientVisibleErrorString, err);
  res.writeHead(httpCode || 500);
  res.end(clientVisibleErrorString);
}
