import { Type } from "@sinclair/typebox";

// Browser reports are projected again before logging. No arbitrary message,
// request body, identity or extra property is part of this wire contract.
export const ClientError = Type.Object(
  {
    client: Type.Union(
      ["alpha", "admin", "report", "participation"].map((s) => Type.Literal(s))
    ),
    build: Type.String({ pattern: "^(?:[a-f0-9]{40}|[a-f0-9]{64}|unknown)$" }),
    page: Type.String({ maxLength: 160 }),
    kind: Type.Union(
      [
        "error",
        "unhandledrejection",
        "console_error",
        "console_warn",
        "fetch",
        "xhr",
        "resource",
        "csp",
      ].map((s) => Type.Literal(s))
    ),
    message: Type.String({ maxLength: 256 }),
    stack: Type.String({ maxLength: 1024 }),
    resource: Type.String({ maxLength: 160 }),
    method: Type.Union(
      [
        "",
        "GET",
        "HEAD",
        "POST",
        "PUT",
        "PATCH",
        "DELETE",
        "OPTIONS",
        "CONNECT",
        "TRACE",
      ].map((s) => Type.Literal(s))
    ),
    status: Type.Integer({ minimum: 0, maximum: 599 }),
    duration_ms: Type.Integer({ minimum: 0, maximum: 60000 }),
    signature: Type.String({ pattern: "^[a-f0-9]{16}$" }),
    count: Type.Integer({ minimum: 1, maximum: 1000 }),
  },
  {
    $id: "client-error/1",
    title: "ClientError",
    description:
      "POST /api/v3/clientErrors: bounded, privacy-projected browser diagnostics. Count is the new occurrences since the previous transmission; signature is recomputed by the receiver. Nonnetwork events have an empty method and zero status and duration_ms.",
    additionalProperties: false,
  }
);
