/**
 * P-038 — `globalErrorHandler` reachability under Express 3.
 *
 * `app.ts` mounts `globalErrorHandler` during module evaluation, while every
 * route is registered later inside the async `helpersInitialized` callback.
 * Express 3 appends `app.router` to the app stack at the first route
 * registration (`express/lib/application.js:464`,
 * `if (!this._usedRouter) this.use(this.router)`), and `next(err)` walks the
 * stack forward only — so an error middleware mounted before the router can
 * never see a route's error. The error falls through to connect's
 * `finalhandler`, which in production serves `http.STATUS_CODES[status]`
 * (`finalhandler@0.4.0 index.js:83-86`).
 *
 * These tests pin both halves of that: the current (unreachable) mounting, and
 * what the `POLIS_REACHABLE_ERROR_HANDLER` mounting would serve instead. The
 * two are NOT byte-equivalent, which is why the flag defaults to off.
 */
import { describe, test, expect, jest } from "@jest/globals";
import http from "node:http";
import Config from "../../src/config";
import { globalErrorHandler } from "../../src/server-middleware";

type Mounting = "before-router" | "after-router";

interface Served {
  handlerCalls: number;
  status: number;
  contentType: string | undefined;
  contentTypeOptions: string | undefined;
  body: string;
  byteLength: number;
}

/**
 * connect reads its environment once, at module load
 * (`connect/lib/proto.js:23`, `var env = process.env.NODE_ENV || 'development'`),
 * and hands it to `finalhandler`. `app.set('env', ...)` does not reach it. So
 * to exercise the production branch we must load a fresh copy of express with
 * NODE_ENV already set.
 */
function loadExpress(nodeEnv: string) {
  const previous = process.env.NODE_ENV;
  process.env.NODE_ENV = nodeEnv;
  let express: any;
  try {
    jest.isolateModules(() => {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      express = require("express");
    });
  } finally {
    process.env.NODE_ENV = previous;
  }
  return express;
}

/**
 * Mirrors the shape of `app.ts`: an error middleware mounted before any route
 * ("before-router", today's production mounting) or after every route
 * ("after-router", the mounting `POLIS_REACHABLE_ERROR_HANDLER` adds).
 *
 * `/param-400` reproduces `src/utils/parameter.ts:146-149`, which sets the
 * status and hands a bare *string* to `next` without ever writing a body.
 */
function buildApp(express: any, mounting: Mounting, handler: any) {
  const app = express();
  if (mounting === "before-router") {
    app.use(handler);
  }
  app.get("/param-400", (_req: any, res: any, next: any) => {
    res.status(400);
    next("polis_err_param_missing_conversation_id");
  });
  app.get("/throw-500", (_req: any, _res: any, next: any) => {
    next(new Error("boom"));
  });
  if (mounting === "after-router") {
    app.use(handler);
  }
  return app;
}

function serve(app: any, path: string, calls: { n: number }): Promise<Served> {
  return new Promise((resolve, reject) => {
    const server = http.createServer(app);
    server.listen(0, () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      http
        .get({ port, path }, (res) => {
          let body = "";
          res.setEncoding("utf8");
          res.on("data", (chunk) => (body += chunk));
          res.on("end", () => {
            server.close();
            resolve({
              handlerCalls: calls.n,
              status: res.statusCode as number,
              contentType: res.headers["content-type"],
              contentTypeOptions: res.headers["x-content-type-options"],
              body,
              byteLength: Buffer.byteLength(body, "utf8"),
            });
          });
        })
        .on("error", (err) => {
          server.close();
          reject(err);
        });
    });
  });
}

async function request(
  mounting: Mounting,
  path: string,
  nodeEnv = "production"
): Promise<Served> {
  const express = loadExpress(nodeEnv);
  const calls = { n: 0 };
  const spy = (err: any, req: any, res: any, next: any) => {
    calls.n += 1;
    return globalErrorHandler(err, req, res, next);
  };
  return serve(buildApp(express, mounting, spy), path, calls);
}

describe("P-038 globalErrorHandler reachability", () => {
  describe("the mechanism: mounted before the router, it never runs", () => {
    test("a route's next(string) does not reach it; finalhandler answers", async () => {
      const served = await request("before-router", "/param-400");

      expect(served.handlerCalls).toBe(0);
      // finalhandler's production branch, verbatim.
      expect(served.status).toBe(400);
      expect(served.body).toBe("Bad Request\n");
      expect(served.contentType).toBe("text/html; charset=utf-8");
      expect(served.contentTypeOptions).toBe("nosniff");
      expect(served.byteLength).toBe(12);
    });

    test("a route's next(new Error()) does not reach it either", async () => {
      const served = await request("before-router", "/throw-500");

      expect(served.handlerCalls).toBe(0);
      expect(served.status).toBe(500);
      expect(served.body).toBe("Internal Server Error\n");
      expect(served.contentType).toBe("text/html; charset=utf-8");
      expect(served.contentTypeOptions).toBe("nosniff");
      expect(served.byteLength).toBe(22);
    });

    test("outside production finalhandler leaks the error instead", async () => {
      const served = await request(
        "before-router",
        "/param-400",
        "development"
      );

      expect(served.handlerCalls).toBe(0);
      expect(served.status).toBe(400);
      // This development-only body is what the characterization harness saw
      // before it switched to a production profile.
      expect(served.body).toBe("polis_err_param_missing_conversation_id\n");
    });
  });

  describe("mounted after the router it runs — and changes served bytes", () => {
    test("the 400 parameter failure becomes a 500 JSON envelope", async () => {
      const served = await request("after-router", "/param-400");

      expect(served.handlerCalls).toBe(1);
      expect(served.status).toBe(500);
      expect(served.contentType).toBe("application/json; charset=utf-8");
      expect(served.contentTypeOptions).toBeUndefined();
      expect(JSON.parse(served.body).error).toBe("internal_server_error");
    });

    test("the 500 error becomes the same JSON envelope", async () => {
      const served = await request("after-router", "/throw-500");

      expect(served.handlerCalls).toBe(1);
      expect(served.status).toBe(500);
      expect(served.contentType).toBe("application/json; charset=utf-8");
      expect(JSON.parse(served.body).error).toBe("internal_server_error");
    });
  });

  describe("served-bytes difference, measured", () => {
    test.each([
      ["/param-400", 400],
      ["/throw-500", 500],
    ])(
      "%s: status, Content-Type and body all differ between the two mountings",
      async (path, currentStatus) => {
        const current = await request("before-router", path as string);
        const reachable = await request("after-router", path as string);

        expect(current.status).toBe(currentStatus);
        expect(reachable.status).toBe(500);
        expect(reachable.contentType).not.toBe(current.contentType);
        expect(reachable.body).not.toBe(current.body);
        expect(reachable.byteLength).toBeGreaterThan(current.byteLength);
      }
    );
  });

  test("the flag is off by default, so production behaviour is unchanged", () => {
    expect(process.env.POLIS_REACHABLE_ERROR_HANDLER).toBeUndefined();
    expect(Config.reachableErrorHandler).toBe(false);
  });

  test("the flag is read from POLIS_REACHABLE_ERROR_HANDLER", () => {
    const previous = process.env.POLIS_REACHABLE_ERROR_HANDLER;
    process.env.POLIS_REACHABLE_ERROR_HANDLER = "true";
    let reloaded: any;
    try {
      jest.isolateModules(() => {
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        reloaded = require("../../src/config").default;
      });
    } finally {
      if (previous === undefined) {
        delete process.env.POLIS_REACHABLE_ERROR_HANDLER;
      } else {
        process.env.POLIS_REACHABLE_ERROR_HANDLER = previous;
      }
    }
    expect(reloaded.reachableErrorHandler).toBe(true);
  });
});
