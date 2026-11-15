import express, { Request, Response, NextFunction } from "express";
import Config from "../../config";

// Mount before the shared 50 MiB parser. Bound wire bytes (including whitespace)
// for length-delimited and chunked requests, before JSON parsing or body logging.
const parseJson = express.json({ limit: "1mb", strict: true });
export function collectiveBody(
  req: Request,
  res: Response,
  next: NextFunction
) {
  const match =
    req.method === "POST" &&
    /^\/api\/v3\/delphi\/(collective|narrative)\/results\/?$/i.exec(req.path);
  if (!match) return next();
  // The narrative import has the same bound; its codes are the narrative
  // contract's (narrativeJobs.ts).
  const narrative = match[1].toLowerCase() === "narrative";
  // Switched off, the handler answers 404 whatever the body.
  if (narrative && !Config.narrativeJobsEnabled) return next();
  res.setHeader("Cache-Control", "no-store");
  const fail = (status: number, message: string) =>
    res.status(status).json({
      status: "error",
      code: narrative ? "INVALID_NARRATIVE" : "INVALID_COLLECTIVE",
      message,
    });
  if (!/^application\/json(?:\s*;|$)/i.test(req.headers["content-type"] || ""))
    return fail(
      415,
      narrative
        ? "Narrative import requires application/json"
        : "Collective statement import requires application/json"
    );
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
