import logger from "./logger";

// New JSON-based fail function for modern API responses
export function failJson(
  res: any,
  httpCode: any,
  clientVisibleErrorString: any,
  err?: any,
  additionalData?: any
) {
  logger.error(clientVisibleErrorString, err);

  const errorResponse = {
    error: clientVisibleErrorString,
    message: clientVisibleErrorString,
    status: httpCode || 500,
    ...additionalData,
  };

  res.status(httpCode || 500).json(errorResponse);
}
