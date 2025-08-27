export interface PaginationParams {
  limit?: number;
  offset?: number;
}

export interface PaginationOptions {
  defaultLimit?: number;
  maxLimit?: number;
}

export interface PaginationResult {
  limit: number;
  offset: number;
  sql: string;
  params: number[];
}

export interface PaginationMeta {
  limit: number;
  offset: number;
  total?: number;
  hasMore?: boolean;
}

/**
 * Parse and validate pagination parameters from request
 * @param params - Raw pagination parameters from request
 * @param options - Configuration options for pagination
 * @returns Validated pagination parameters and SQL components
 */
export function parsePagination(
  params: PaginationParams,
  options: PaginationOptions = {}
): PaginationResult {
  const defaultLimit = options.defaultLimit || 50;
  const maxLimit = options.maxLimit || 500;

  // Parse and validate limit
  let limit = defaultLimit;
  if (params.limit !== undefined && params.limit !== null) {
    const parsedLimit = Number(params.limit);
    if (!isNaN(parsedLimit) && parsedLimit > 0) {
      limit = Math.min(parsedLimit, maxLimit);
    }
  }

  // Parse and validate offset
  let offset = 0;
  if (params.offset !== undefined && params.offset !== null) {
    const parsedOffset = Number(params.offset);
    if (!isNaN(parsedOffset) && parsedOffset >= 0) {
      offset = parsedOffset;
    }
  }

  return {
    limit,
    offset,
    sql: `LIMIT ($1) OFFSET ($2)`,
    params: [limit, offset],
  };
}

/**
 * Generate pagination metadata for response
 * @param limit - Items per page
 * @param offset - Items to skip
 * @param total - Total count (optional)
 * @returns Pagination metadata object
 */
export function createPaginationMeta(
  limit: number,
  offset: number,
  total?: number
): PaginationMeta {
  const meta: PaginationMeta = {
    limit,
    offset,
  };

  if (total !== undefined) {
    meta.total = total;
    meta.hasMore = offset + limit < total;
  }

  return meta;
}

/**
 * Adjust SQL parameter indices when pagination params are added
 * @param baseParams - Base query parameters
 * @param paginationResult - Result from parsePagination
 * @returns Combined parameters and adjusted SQL
 */
export function applySqlPagination(
  baseParams: unknown[],
  paginationResult: PaginationResult
): { params: unknown[]; sql: string } {
  const baseParamCount = baseParams.length;
  const adjustedSql = paginationResult.sql.replace(
    /\$(\d+)/g,
    (match, num) => `$${Number(num) + baseParamCount}`
  );

  return {
    params: [...baseParams, ...paginationResult.params],
    sql: adjustedSql,
  };
}
