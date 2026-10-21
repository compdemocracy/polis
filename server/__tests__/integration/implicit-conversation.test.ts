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

});
