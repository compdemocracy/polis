import logger from './logger.js';
export default function fail(res, httpCode, clientVisibleErrorString, err) {
  logger.error(clientVisibleErrorString, err);
  res.writeHead(httpCode || 500);
  res.end(clientVisibleErrorString);
}
