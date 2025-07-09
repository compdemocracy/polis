/**
 * Utility functions to help with async/await patterns and reduce code duplication
 */

import logger from "./logger";

/**
 * Wraps a callback-based function to return a Promise
 */
export function promisify<T>(
  fn: (callback: (err: any, result?: T) => void) => void
): Promise<T> {
  return new Promise((resolve, reject) => {
    fn((err: any, result?: T) => {
      if (err) {
        reject(err);
      } else {
        resolve(result!);
      }
    });
  });
}

/**
 * Wraps a database query to return a Promise with better error handling
 */
export function queryPromise<T = any>(
  queryFn: (
    sql: string,
    params: any[],
    callback: (err: any, result: { rows: T[] }) => void
  ) => void,
  sql: string,
  params: any[] = []
): Promise<T[]> {
  return new Promise((resolve, reject) => {
    queryFn(sql, params, (err: any, result: { rows: T[] }) => {
      if (err) {
        logger.error("Database query error", { sql, params, err });
        reject(err);
      } else {
        resolve(result.rows);
      }
    });
  });
}

/**
 * Retry an async function with exponential backoff
 */
export async function retryWithBackoff<T>(
  fn: () => Promise<T>,
  maxRetries = 3,
  baseDelay = 1000
): Promise<T> {
  let lastError: any;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;

      if (attempt === maxRetries) {
        break;
      }

      const delay = baseDelay * Math.pow(2, attempt);
      logger.warn(`Attempt ${attempt + 1} failed, retrying in ${delay}ms`, {
        error,
      });
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }

  throw lastError;
}

/**
 * Execute multiple promises with a concurrency limit
 */
export async function promiseLimit<T>(
  promises: (() => Promise<T>)[],
  limit = 5
): Promise<T[]> {
  const results: T[] = [];
  const executing: Promise<void>[] = [];

  for (const promiseFactory of promises) {
    const promise = promiseFactory().then((result) => {
      results.push(result);
    });

    executing.push(promise);

    if (executing.length >= limit) {
      await Promise.race(executing);
      executing.splice(
        executing.findIndex((p) => p === promise),
        1
      );
    }
  }

  await Promise.all(executing);
  return results;
}

/**
 * Safe JSON parsing with default value
 */
export function safeJsonParse<T>(jsonString: string, defaultValue: T): T {
  try {
    return JSON.parse(jsonString);
  } catch (error) {
    logger.warn("Failed to parse JSON", { jsonString, error });
    return defaultValue;
  }
}

/**
 * Validate email format
 */
export function isValidEmail(email: string): boolean {
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  return emailRegex.test(email);
}

/**
 * Sanitize string for database storage
 */
export function sanitizeString(str: string, maxLength = 255): string {
  if (!str) return "";
  return str.trim().substring(0, maxLength);
}

/**
 * Generate a secure random string
 */
export function generateRandomString(length = 32): string {
  const chars =
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  let result = "";
  for (let i = 0; i < length; i++) {
    result += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return result;
}
