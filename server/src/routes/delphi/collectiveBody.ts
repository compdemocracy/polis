import express, { Request, Response, NextFunction } from "express";

// Mount before the shared 50 MiB parser. Bound wire bytes (including whitespace)
// for length-delimited and chunked requests, before JSON parsing or body logging.
const parseJson = express.json({ limit: "1mb", strict: true });
export function collectiveBody(
  req: Request,
  res: Response,
  next: NextFunction
) {
  if (
    req.method !== "POST" ||
    !/^\/api\/v3\/delphi\/collective\/results\/?$/i.test(req.path)
  )
    return next();
  res.setHeader("Cache-Control", "no-store");
  const fail = (status: number, message: string) =>
    res
      .status(status)
      .json({ status: "error", code: "INVALID_COLLECTIVE", message });
  if (!/^application\/json(?:\s*;|$)/i.test(req.headers["content-type"] || ""))
    return fail(415, "Collective statement import requires application/json");
  return parseJson(req, res, (error?: any) => {
    if (error)
      return fail(
        error.status === 413 ? 413 : 400,
        error.status === 413
          ? "Import exceeds 1 MiB"
          : "Import must be valid JSON"
      );
    return next();
  });
}
