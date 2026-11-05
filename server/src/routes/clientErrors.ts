import type { Request, Response } from "express";
import { clientErrorAddress } from "../utils/clientErrorAddress";
import { fields, signature } from "../utils/clientErrorReporter";

const BODY_BYTES = 4096;
const MAX_IPS = 4096;
const MAX_ACTIVE = 32;
type Bucket = { tokens: number; at: number };

// This router runs before the shared body parser. Nothing here reads auth,
// cookies, conversation data, or a database. IPs live only in the bounded map.
export function createClientErrorHandler(
  log: (fields: Record<string, unknown>) => void,
  now = Date.now
) {
  const ips = new Map<string, Bucket>();
  const global: Bucket = { tokens: 100, at: now() };
  let active = 0;
  function refill(
    bucket: Bucket,
    capacity: number,
    interval: number,
    time: number
  ) {
    bucket.tokens = Math.min(
      capacity,
      bucket.tokens + Math.max(0, time - bucket.at) / interval
    );
    bucket.at = time;
    return bucket.tokens >= 1;
  }
  return (req: Request, res: Response) => {
    const reply = () => {
      res.statusCode = 204;
      res.setHeader("Cache-Control", "no-store");
      res.end();
    };
    const refuse = () => {
      reply();
      req.resume();
    };
    const time = now();
    if (active >= MAX_ACTIVE) return refuse();
    const ip = clientErrorAddress(req);
    let bucket = ips.get(ip);
    if (!bucket) {
      if (ips.size >= MAX_IPS) {
        // Insertion order bounds reclamation to one oldest entry per request.
        const oldest = ips.entries().next().value as [string, Bucket];
        if (time - oldest[1].at < 600000) return refuse();
        ips.delete(oldest[0]);
      }
      bucket = { tokens: 10, at: time };
      ips.set(ip, bucket);
    }
    ips.delete(ip);
    ips.set(ip, bucket);
    const addressReady = refill(bucket, 10, 60000, time);
    const processReady = refill(global, 100, 1000, time);
    if (!addressReady || !processReady) return refuse();
    bucket.tokens--;
    global.tokens--;
    if (
      req.headers["content-encoding"] ||
      !/^(?:application\/json|text\/plain)(?:;|$)/i.test(
        req.headers["content-type"] || ""
      ) ||
      Number(req.headers["content-length"] || 0) > BODY_BYTES
    )
      return refuse();
    active++;
    let size = 0,
      chunks: Buffer[] = [],
      finished = false;
    const timer = setTimeout(() => finish(), 5000);
    timer.unref();
    function finish() {
      if (finished) return;
      finished = true;
      active--;
      clearTimeout(timer);
      chunks = [];
      req.removeListener("data", data);
      req.removeListener("end", end);
      if (!res.writableEnded) reply();
      req.resume();
    }
    function data(chunk: Buffer) {
      size += chunk.length;
      if (size > BODY_BYTES) return finish();
      chunks.push(chunk);
    }
    function end() {
      if (finished) return;
      try {
        const value = fields(
          JSON.parse(Buffer.concat(chunks).toString("utf8"))
        );
        if (value) {
          const {
            client,
            build,
            page,
            kind,
            message,
            stack,
            resource,
            method,
            status,
            duration_ms,
            count,
          } = value;
          const agent =
            typeof req.headers["user-agent"] === "string"
              ? req.headers["user-agent"]
              : "";
          const userAgent = (
            agent
              .slice(0, 2048)
              .match(
                /\b(?:Mozilla|Chrome|Chromium|Firefox|Safari|Version|Edg|OPR)\/[0-9.]{1,32}\b/g
              ) || []
          )
            .join(" ")
            .slice(0, 256);
          log({
            message: "client_error",
            client,
            build,
            page,
            kind,
            stack,
            resource,
            method,
            status,
            duration_ms,
            signature: signature(value),
            count,
            error_message: message,
            user_agent: userAgent,
          });
        }
      } catch (_) {
        /* Invalid input and logging failures have the same response. */
      }
      finish();
    }
    req.on("data", data);
    req.on("end", end);
    req.once("error", finish);
    req.once("aborted", finish);
    res.once("close", finish);
  };
}
