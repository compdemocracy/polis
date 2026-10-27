import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  jest,
  test,
} from "@jest/globals";
import { randomUUID } from "crypto";
import type { Express } from "express";
import request from "supertest";
import { getApp } from "../app-loader";
import { pool } from "../setup/db-test-helpers";
import pg from "../../src/db/pg-query";

describe("implicit embed conversations", () => {
  let app: Express;
  let owner: number;
  let siteId: string;
  const parentUrl = `https://example.invalid/embed/${randomUUID()}`;
  const unknownSiteId = `polis_site_id_${randomUUID()}`;

  beforeAll(async () => {
    app = await getApp();
    const { rows } = await pool.query(
      "INSERT INTO users (email, site_owner) VALUES ($1, TRUE) RETURNING uid, site_id",
      [`embed-${randomUUID()}@example.invalid`]
    );
    owner = rows[0].uid;
    siteId = rows[0].site_id;
  });

  afterEach(() => jest.restoreAllMocks());

  afterAll(async () => {
    await pool.query("DELETE FROM page_ids WHERE site_id = ANY($1)", [
      [siteId, unknownSiteId],
    ]);
    await pool.query(
      "DELETE FROM zinvites WHERE zid IN (SELECT zid FROM conversations WHERE parent_url = $1)",
      [parentUrl]
    );
    await pool.query("DELETE FROM conversations WHERE parent_url = $1", [
      parentUrl,
    ]);
    await pool.query("DELETE FROM users WHERE uid = $1", [owner]);
  });

  function visit(site: string, page: string) {
    return request(app)
      .get(`/${site}/${page}`)
      .set("Host", "embed.example.invalid")
      .set("Accept", "text/plain")
      .query({ parent_url: parentUrl });
  }

  async function pageRows(page: string) {
    const { rows } = await pool.query(
      `SELECT c.zid, c.owner, c.org_id, c.parent_url, p.site_id, p.page_id, z.zinvite
       FROM conversations c
       JOIN page_ids p ON p.zid = c.zid
       JOIN zinvites z ON z.zid = c.zid
       WHERE p.site_id = $1 AND p.page_id = $2`,
      [siteId, page]
    );
    return rows;
  }

  function redirectLocation(invite: string, page: string) {
    return `http://embed.example.invalid/${invite}?site_id=${siteId}&page_id=${page}&parent_url=${encodeURIComponent(
      parentUrl
    )}`;
  }

  test("an unknown site answers 404 without creating conversation, page or invite rows", async () => {
    const writes = jest.spyOn(pg, "query");
    const promiseWrites = jest.spyOn(pg, "queryP");
    const response = await visit(unknownSiteId, "unknown-page");

    // Scope row checks to this request so other integration suites can run concurrently.
    const { rows } = await pool.query(
      `SELECT
         (SELECT count(*)::int FROM conversations WHERE parent_url = $1) AS conversations,
         (SELECT count(*)::int FROM page_ids WHERE site_id = $2) AS pages,
         (SELECT count(*)::int FROM zinvites z JOIN conversations c ON c.zid = z.zid
          WHERE c.parent_url = $1) AS invites`,
      [parentUrl, unknownSiteId]
    );
    expect(rows[0]).toEqual({ conversations: 0, pages: 0, invites: 0 });
    expect(writes).not.toHaveBeenCalled();
    expect(promiseWrites).not.toHaveBeenCalled();
    expect(response.status).toBe(404);
    expect(response.body).toEqual({
      error: "polis_err_bad_site_id",
      message: "polis_err_bad_site_id",
      status: 404,
    });
  });

  test("a site owner's first visit creates the rows and preserves the redirect bytes", async () => {
    const response = await visit(siteId, "first-page");
    const rows = await pageRows("first-page");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      owner,
      org_id: owner,
      parent_url: parentUrl,
      site_id: siteId,
      page_id: "first-page",
    });
    expect(rows[0].zinvite).toMatch(/^[2-9][a-z0-9]{9}$/);
    const location = redirectLocation(rows[0].zinvite, "first-page");
    expect(response.status).toBe(302);
    expect(response.headers.location).toBe(location);
    expect(response.text).toBe(`Found. Redirecting to ${encodeURI(location)}`);
  });

  test("a second visit resolves the existing conversation without creating another", async () => {
    const first = await visit(siteId, "repeat-page");
    const before = await pageRows("repeat-page");
    expect(first.status).toBe(302);
    expect(before).toHaveLength(1);
    const writes = jest.spyOn(pg, "query");
    const promiseWrites = jest.spyOn(pg, "queryP");
    const second = await visit(siteId, "repeat-page");
    expect(second.status).toBe(302);
    expect(second.headers.location).toBe(
      redirectLocation(before[0].zinvite, "repeat-page")
    );
    expect(second.headers.location).toBe(first.headers.location);
    expect(second.text).toBe(first.text);
    expect(await pageRows("repeat-page")).toEqual(before);
    expect(writes).not.toHaveBeenCalled();
    expect(
      promiseWrites.mock.calls.every(([sql]) => /^select /i.test(String(sql)))
    ).toBe(true);
  });

  test("an owner lookup service error still answers 500 even with the same message", async () => {
    const read = pg.queryP_readOnly.bind(pg);
    jest.spyOn(pg, "queryP_readOnly").mockImplementation((sql, params) => {
      if (String(sql).startsWith("select uid from users")) {
        return Promise.reject(new Error("polis_err_bad_site_id"));
      }
      return read(sql, params);
    });
    const response = await visit(unknownSiteId, "lookup-error");
    expect(response.status).toBe(500);
    expect(response.body).toEqual({
      error: "polis_err_creating_conv",
      message: "polis_err_creating_conv",
      status: 500,
    });
  });

  async function counts() {
    const { rows } = await pool.query(
      `SELECT
         (SELECT count(*)::int FROM conversations WHERE owner = $1) AS conversations,
         (SELECT count(*)::int FROM page_ids WHERE site_id = $2) AS pages,
         (SELECT count(*)::int FROM zinvites z JOIN conversations c ON c.zid = z.zid
          WHERE c.owner = $1) AS invites`,
      [owner, siteId]
    );
    return rows[0];
  }

  test.each([150, 2000])(
    "a %i-character page creates once and the next visit reuses it",
    async (length) => {
      const page = "p".repeat(length);
      const before = await counts();
      const first = await visit(siteId, page);
      const second = await visit(siteId, page);
      expect(first.status).toBe(302);
      expect(second.status).toBe(302);
      expect(second.headers.location).toBe(first.headers.location);
      expect(await pageRows(page)).toHaveLength(1);
      expect(await counts()).toEqual({
        conversations: before.conversations + 1,
        pages: before.pages + 1,
        invites: before.invites + 1,
      });
    }
  );

  test.each(["page_id", "site_id"])(
    "a 2,001-character %s answers 400 before any database access",
    async (name) => {
      const before = await counts();
      const transaction = jest.spyOn(pg, "withTransaction");
      const read = jest.spyOn(pg, "queryP_readOnly");
      const response = await visit(
        name === "site_id" ? "polis_site_id" + "s".repeat(1988) : siteId,
        name === "page_id" ? "p".repeat(2001) : "oversized-site"
      );
      expect(response.status).toBe(400);
      expect(response.body.error).toBe(`polis_err_${name}_length_1_to_2000`);
      expect(transaction).not.toHaveBeenCalled();
      expect(read).not.toHaveBeenCalled();
      expect(await counts()).toEqual(before);
    }
  );

  test("a missing or empty page answers 400 without writes", async () => {
    const before = await counts();
    for (const path of [`/${siteId}`, `/${siteId}/`]) {
      const response = await request(app)
        .get(path)
        .query({ parent_url: parentUrl });
      expect(response.status).toBe(400);
      expect(response.body.error).toBe("polis_err_page_id_length_1_to_2000");
    }
    expect(await counts()).toEqual(before);
  });

  test.each(["page_ids", "zinvites"])(
    "a failing %s insert rolls back every row",
    async (table) => {
      const before = await counts();
      const transaction = pg.withTransaction.bind(pg);
      let attemptedZid: number | undefined;
      jest.spyOn(pg, "withTransaction").mockImplementation((callback) =>
        transaction(async (client) => {
          const query = client.query.bind(client);
          jest.spyOn(client, "query").mockImplementation((async (
            sql: any,
            params: any
          ) => {
            if (new RegExp(`insert into ${table}`, "i").test(String(sql))) {
              attemptedZid = table === "page_ids" ? params[2] : params[0];
              return query("SELECT 1 / 0");
            }
            return query(sql, params);
          }) as any);
          return callback(client);
        })
      );
      const response = await visit(siteId, `failed-${table}`);
      expect(response.status).toBe(500);
      expect(attemptedZid).toEqual(expect.any(Number));
      expect(await counts()).toEqual(before);
      for (const tableName of ["conversations", "page_ids", "zinvites"]) {
        const { rows } = await pool.query(
          `SELECT zid FROM ${tableName} WHERE zid = $1`,
          [attemptedZid]
        );
        expect(rows).toHaveLength(0);
      }
    }
  );

  test("two simultaneous first visits roll back the loser and redirect to one conversation", async () => {
    const page = "concurrent-first-visit";
    const before = await counts();
    const read = pg.queryP_readOnly.bind(pg);
    let arrivals = 0;
    let release!: () => void;
    const bothLookedUp = new Promise<void>((resolve) => {
      release = resolve;
    });
    jest
      .spyOn(pg, "queryP_readOnly")
      .mockImplementation(async (sql, params) => {
        const rows = await read(sql, params);
        if (
          String(sql).startsWith("select * from page_ids") &&
          params[1] === page
        ) {
          expect(rows).toEqual([]);
          if (++arrivals === 2) release();
          await bothLookedUp;
        }
        return rows;
      });
    const transaction = pg.withTransaction.bind(pg);
    let collisions = 0;
    jest.spyOn(pg, "withTransaction").mockImplementation(async (callback) => {
      try {
        return await transaction(callback);
      } catch (error: any) {
        if (
          error.code === "23505" &&
          error.constraint === "page_ids_site_id_page_id_key"
        )
          collisions++;
        throw error;
      }
    });
    const responses = await Promise.all([
      visit(siteId, page),
      visit(siteId, page),
    ]);
    expect(responses.map((response) => response.status)).toEqual([302, 302]);
    expect(responses[0].headers.location).toBe(responses[1].headers.location);
    expect(collisions).toBe(1);
    expect(await pageRows(page)).toHaveLength(1);
    expect(await counts()).toEqual({
      conversations: before.conversations + 1,
      pages: before.pages + 1,
      invites: before.invites + 1,
    });
  });
});
