"use strict";
// The schema pin's rule: replay fails only when a relation the recordings
// read changes shape; a migration that adds something else passes.
//   node --test characterization/collective-statement/schema.test.cjs
// With CSREC_PG_ADMIN_URL set (the replay job's Postgres) the same rule is
// also proven against the real migrations.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { RELATIONS, readSchema, schemaDrift } = require("./schema.cjs");

// A catalog answered from a description: {relname: {kind, columns: [[name,
// type, notnull, default]], constraints: [[name, def]], rules: [[name, def]],
// triggers: [[name, def]]}} plus functions {signature: def}. It answers the
// four catalog statements and the function lookup that readSchema makes.
function catalog(desc, functions = {}) {
  return async (sql, params) => {
    const names = params[0];
    const rows = [];
    const want = (n) => Array.isArray(names) && names.includes(n);
    if (/FROM pg_class c/.test(sql) && /pg_attribute/.test(sql)) {
      for (const [relation, r] of Object.entries(desc))
        if (want(relation))
          r.columns.forEach(([attname, type, attnotnull, def], i) =>
            rows.push({
              relation,
              relkind: r.kind || "r",
              attname,
              attnum: i + 1,
              type,
              attnotnull: !!attnotnull,
              def: def ?? null,
            }),
          );
    } else if (/FROM pg_constraint/.test(sql)) {
      for (const [relation, r] of Object.entries(desc))
        if (want(relation))
          for (const [conname, def] of r.constraints || [])
            rows.push({ relation, conname, def });
    } else if (/FROM pg_rules/.test(sql)) {
      for (const [relation, r] of Object.entries(desc))
        if (want(relation))
          for (const [rulename, definition] of r.rules || [])
            rows.push({ relation, rulename, definition });
    } else if (/FROM pg_trigger/.test(sql)) {
      for (const [relation, r] of Object.entries(desc))
        if (want(relation))
          for (const [tgname, def] of r.triggers || [])
            rows.push({ relation, tgname, def });
    } else if (/pg_get_functiondef/.test(sql)) {
      rows.push({
        def: Object.hasOwn(functions, names) ? functions[names] : null,
      });
    } else throw new Error(`unexpected statement: ${sql}`);
    return { rows };
  };
}

function edgeLike() {
  const d = {};
  for (const name of Object.keys(RELATIONS))
    d[name] = {
      kind: "r",
      columns: [
        ["zid", "integer", true],
        ["created", "bigint", false, "now_as_millis()"],
      ],
      constraints: [],
      rules: [],
      triggers: [],
    };
  d.users.columns.unshift([
    "uid",
    "integer",
    true,
    "nextval('users_uid_seq'::regclass)",
  ]);
  d.comments.columns.push(
    ["txt", "character varying(1000)", true],
    ["mod", "integer", true, "0"],
  );
  d.votes.columns.push(["vote", "smallint", true]);
  d.votes.rules.push([
    "on_vote_insert_update_unique_table",
    "CREATE RULE ... ON INSERT TO public.votes\n  DO ALSO INSERT INTO votes_latest_unique ...",
  ]);
  d.votes_latest_unique.constraints.push([
    "votes_latest_unique_zid_pid_tid_key",
    "UNIQUE (zid, pid, tid)",
  ]);
  return d;
}

test("the pin covers every relation the fixture writes and the routes read", () => {
  assert.deepEqual(Object.keys(RELATIONS).sort(), [
    "comments",
    "conversations",
    "oidc_user_mappings",
    "participants",
    "reports",
    "users",
    "votes",
    "votes_latest_unique",
    "zinvites",
  ]);
  // The fixture writes every pinned relation but two: the votes are written by
  // main.cjs through the shared vote writer, and votes_latest_unique is
  // filled from them by the insert rule the migrations define on votes.
  const fixture = fs.readFileSync(path.join(__dirname, "fixtures.cjs"), "utf8");
  const main = fs.readFileSync(path.join(__dirname, "main.cjs"), "utf8");
  for (const name of Object.keys(RELATIONS))
    if (name === "votes") assert.match(main, /INSERT INTO votes\(/);
    else if (name !== "votes_latest_unique")
      assert.match(
        fixture,
        new RegExp(`INSERT INTO ${name}\\(`),
        `${name} is written by the fixture`,
      );
});

test("reading the same schema twice gives the same pin", async () => {
  const a = await readSchema(catalog(edgeLike()));
  const b = await readSchema(catalog(edgeLike()));
  assert.equal(JSON.stringify(a), JSON.stringify(b));
  assert.equal(a.relations.comments.kind, "table");
  assert.deepEqual(
    a.relations.users.columns[0],
    "uid integer not null default nextval('users_uid_seq'::regclass)",
  );
  assert.deepEqual(a.functions, { "public.vote_convention_current()": null });
  assert.deepEqual(schemaDrift(a, b), []);
});

test("one more migration that touches none of the read relations passes", async () => {
  const recorded = await readSchema(catalog(edgeLike()));
  const later = edgeLike();
  later.delphi_jobs = {
    kind: "r",
    columns: [
      ["job_id", "uuid", true],
      ["zid", "integer", true],
    ],
    constraints: [["delphi_jobs_pkey", "PRIMARY KEY (job_id)"]],
    rules: [],
    triggers: [],
  };
  later.polis_queue_jobs = {
    kind: "r",
    columns: [["worker_class", "text", true, "'noop'::text"]],
    constraints: [],
    rules: [],
    triggers: [],
  };
  const current = await readSchema(catalog(later));
  assert.deepEqual(schemaDrift(recorded, current), []);
});

test("a changed read relation fails, naming the relation and the change", async () => {
  const recorded = await readSchema(catalog(edgeLike()));
  const column = edgeLike();
  column.comments.columns.push(["embedding", "jsonb", false]);
  assert.deepEqual(schemaDrift(recorded, await readSchema(catalog(column))), [
    "comments: columns changed +[embedding jsonb]",
  ]);
  const type = edgeLike();
  type.votes.columns[2] = ["vote", "integer", true];
  assert.deepEqual(schemaDrift(recorded, await readSchema(catalog(type))), [
    "votes: columns changed -[vote smallint not null] +[vote integer not null]",
  ]);
  const rule = edgeLike();
  rule.votes.rules[0][1] =
    "CREATE RULE ... DO ALSO INSERT INTO votes_latest_unique ... ON CONFLICT DO NOTHING";
  assert.equal(
    schemaDrift(recorded, await readSchema(catalog(rule))).length,
    1,
  );
  assert.match(
    schemaDrift(recorded, await readSchema(catalog(rule)))[0],
    /^votes: rules changed/,
  );
  const unique = edgeLike();
  unique.votes_latest_unique.constraints = [];
  assert.deepEqual(schemaDrift(recorded, await readSchema(catalog(unique))), [
    "votes_latest_unique: constraints changed -[votes_latest_unique_zid_pid_tid_key UNIQUE (zid, pid, tid)]",
  ]);
  const gone = edgeLike();
  delete gone.reports;
  assert.deepEqual(schemaDrift(recorded, await readSchema(catalog(gone))), [
    "reports: recorded as table, now missing",
  ]);
  const view = edgeLike();
  view.votes_latest_unique.kind = "v";
  assert.match(
    schemaDrift(recorded, await readSchema(catalog(view)))[0],
    /^votes_latest_unique: recorded as table, now view/,
  );
});

test("the vote convention function appearing or changing fails", async () => {
  const recorded = await readSchema(catalog(edgeLike()));
  const defined = await readSchema(
    catalog(edgeLike(), {
      "public.vote_convention_current()":
        "CREATE FUNCTION public.vote_convention_current() ... RETURNS TABLE(agree_value smallint)",
    }),
  );
  assert.deepEqual(schemaDrift(recorded, defined), [
    "public.vote_convention_current(): absent at record time, now defined",
  ]);
  const changed = await readSchema(
    catalog(edgeLike(), {
      "public.vote_convention_current()":
        "CREATE FUNCTION public.vote_convention_current() ... SELECT 1",
    }),
  );
  assert.deepEqual(schemaDrift(defined, changed), [
    "public.vote_convention_current(): definition changed",
  ]);
  assert.deepEqual(schemaDrift(defined, recorded), [
    "public.vote_convention_current(): defined at record time, now absent",
  ]);
});

test("a pin from an older index (no schema) is reported, not crashed on", () => {
  const drift = schemaDrift(undefined, {
    relations: {
      comments: {
        kind: "table",
        columns: [],
        constraints: [],
        rules: [],
        triggers: [],
      },
    },
    functions: {},
  });
  assert.deepEqual(drift, ["comments: not in the recorded pin"]);
});

// Against the real migrations, when the replay job's Postgres is there.
test(
  "against the real migrations: an unrelated migration passes, a touched read table fails",
  {
    skip: process.env.CSREC_PG_ADMIN_URL ? false : "CSREC_PG_ADMIN_URL not set",
  },
  async () => {
    const { Client } = require("pg");
    const safety = require("./safety.cjs");
    const adminUrl = new URL(process.env.CSREC_PG_ADMIN_URL);
    assert.equal(
      adminUrl.port,
      safety.PG_PORT,
      "the harness's own Postgres only",
    );
    const admin = new Client({ connectionString: adminUrl.toString() });
    await admin.connect();
    const dbs = (await admin.query("SELECT datname FROM pg_database")).rows.map(
      (r) => r.datname,
    );
    assert.deepEqual(safety.checkPgDatabases(dbs), []);
    await admin.query("DROP DATABASE IF EXISTS csrec WITH (FORCE)");
    await admin.query("CREATE DATABASE csrec");
    await admin.end();
    const appUrl = new URL(adminUrl);
    appUrl.pathname = "/csrec";
    const db = new Client({ connectionString: appUrl.toString() });
    await db.connect();
    try {
      const dir = path.resolve(__dirname, "../../postgres/migrations");
      for (const f of fs
        .readdirSync(dir)
        .filter((f) => f.endsWith(".sql"))
        .sort())
        await db.query(fs.readFileSync(path.join(dir, f), "utf8"));
      const query = (sql, params) => db.query(sql, params);
      const recorded = await readSchema(query);
      assert.equal(recorded.relations.votes_latest_unique.kind, "table");
      assert.ok(
        recorded.relations.votes.rules.some((r) =>
          r.startsWith("on_vote_insert_update_unique_table:"),
        ),
      );
      // One more migration, unrelated: a new table with its own indexes, a
      // column on a table the recordings never read, and an index on one they do.
      await db.query(`
        CREATE TABLE csrec_unrelated (id bigserial PRIMARY KEY, zid integer NOT NULL, note text);
        CREATE INDEX csrec_unrelated_zid ON csrec_unrelated (zid);
        ALTER TABLE polis_queue_jobs ADD COLUMN csrec_unrelated_flag boolean NOT NULL DEFAULT false;
        CREATE INDEX csrec_comments_created ON comments (zid, created);
      `);
      assert.deepEqual(schemaDrift(recorded, await readSchema(query)), []);
      // A migration that touches a relation the recordings read.
      await db.query("ALTER TABLE comments ADD COLUMN csrec_touched text");
      assert.deepEqual(schemaDrift(recorded, await readSchema(query)), [
        "comments: columns changed +[csrec_touched text]",
      ]);
    } finally {
      await db.end();
    }
  },
);
