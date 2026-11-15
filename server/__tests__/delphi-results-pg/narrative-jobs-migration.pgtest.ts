/** Migration 000046 (narrative jobs), through the real migration runner:
 *   - over a database of the older shape that already holds Delphi results
 *     written by pd_result_mutate, `polis-migrate deploy` applies only 000046,
 *     the stored results are unchanged, the earlier writers still work, and
 *     the release before it passes `check` beside it (declared additive);
 *   - its down refuses while a prompt pack is stored, and otherwise drops what
 *     000046 made and restores pd_queue_binding exactly as 000027 left it;
 *     applying 000046 again gives the same catalog;
 *   - on an empty database the whole release gives that same catalog.
 *
 * Each case makes its own database on the server DATABASE_URL names, and
 * drops it. The runner is the one scripts/test-delphi-result-reads.sh builds
 * (POLIS_MIGRATE_BIN overrides). Generated data only; no vote is written. */
import { Client } from "pg";
import { execFileSync } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";

const ROOT = path.resolve(__dirname, "../../..");
const MIGRATIONS = path.join(ROOT, "server/postgres/migrations");
const RUNNER = process.env.POLIS_MIGRATE_BIN || path.join(ROOT, "queue-rs/target/debug/polis-migrate");
const NAME = "000046_create_delphi_narrative_jobs.sql";
const DOWN = path.join(MIGRATIONS, "down/000046_drop_delphi_narrative_jobs.sql");
const DATABASES = ["m000046_upgrade", "m000046_fresh"];
const ENV = "migration";
const SCOPE = "delphi";

let admin: Client;
let before: string;
let through: string;

function url(db: string): string {
  const u = new URL(process.env.DATABASE_URL as string);
  u.pathname = `/${db}`;
  return u.toString();
}
function runner(db: string, command: string, dir = MIGRATIONS): string {
  return execFileSync(RUNNER, [command, "--dir", dir], {
    env: { ...process.env, DATABASE_URL: url(db) },
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}
function releaseWith(keep: (name: string) => boolean): string {
  const dir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "release-")), "migrations");
  fs.cpSync(MIGRATIONS, dir, { recursive: true });
  const numbered = (name: string) => /^\d{6}_.*\.sql$/.test(name);
  for (const name of fs.readdirSync(dir)) if (numbered(name) && !keep(name)) fs.rmSync(path.join(dir, name));
  for (const manifest of ["release.txt", "compat.txt"]) {
    const file = path.join(dir, manifest);
    const kept = fs
      .readFileSync(file, "utf8")
      .split("\n")
      .filter((line) => !numbered(line.split(" ")[0]) || keep(line.split(" ")[0]));
    fs.writeFileSync(file, kept.join("\n"));
  }
  return dir;
}
async function withDatabase<T>(db: string, work: (client: Client) => Promise<T>): Promise<T> {
  const client = new Client({ connectionString: url(db) });
  await client.connect();
  try {
    return await work(client);
  } finally {
    await client.end();
  }
}

/** What 000046 owns or changes, as the catalog has it. */
async function catalog(client: Client) {
  const functions = (
    await client.query(`SELECT p.oid::regprocedure::text AS name, md5(pg_get_functiondef(p.oid)) AS def,
      pg_get_userbyid(p.proowner) AS owner, p.proacl::text AS acl, p.prosecdef
    FROM pg_proc p WHERE p.pronamespace='public'::regnamespace
     AND (p.proname LIKE 'pd_narrative%' OR p.proname='pd_queue_binding') ORDER BY 1`)
  ).rows;
  const columns = (
    await client.query(`SELECT table_name,column_name,data_type,is_nullable,column_default FROM information_schema.columns
    WHERE table_schema='public' AND table_name LIKE 'delphi_narrative%' ORDER BY table_name,ordinal_position`)
  ).rows;
  const constraints = (
    await client.query(`SELECT conrelid::regclass::text AS t,conname,pg_get_constraintdef(oid) AS def FROM pg_constraint
    WHERE connamespace='public'::regnamespace AND conrelid::regclass::text LIKE 'delphi_narrative%' ORDER BY 1,2`)
  ).rows;
  const triggers = (
    await client.query(`SELECT tgrelid::regclass::text AS t,tgname FROM pg_trigger
    WHERE NOT tgisinternal AND tgrelid::regclass::text LIKE 'delphi_narrative%' ORDER BY 1,2`)
  ).rows;
  return { functions, columns, constraints, triggers };
}
const binding = async (client: Client) =>
  (await client.query("SELECT pg_get_functiondef('public.pd_queue_binding()'::regprocedure) AS d")).rows[0].d;

/** A conversation with a report and a collective statement written through
 * the earlier release's own writer (pd_result_mutate, a Delphi job). */
async function seedDelphi(client: Client, zid: number, statement: string) {
  await client.query("INSERT INTO users(uid,hname,email) VALUES($1,'generated',$2) ON CONFLICT DO NOTHING", [
    zid,
    `generated-${zid}@example.invalid`,
  ]);
  await client.query("INSERT INTO conversations(zid,owner,topic) VALUES($1,$1,'generated') ON CONFLICT DO NOTHING", [zid]);
  await client.query("INSERT INTO reports(report_id,zid) SELECT $1::text,$2 WHERE NOT EXISTS(SELECT 1 FROM reports WHERE report_id=$1::text)", [
    `rmigration${zid}`,
    zid,
  ]);
  const item = {
    zid_topic_jobid: { S: `${zid}#generated#0#1#${statement}` },
    zid: { S: String(zid) },
    topic_key: { S: "generated#0#1" },
    statement_data: { S: JSON.stringify({ statement }) },
  };
  const reply = (
    await client.query("SELECT public.pd_result_mutate($1,$2,'generated',gen_random_uuid(),'Delphi_CollectiveStatement','put',$3::jsonb) AS v", [
      ENV,
      SCOPE,
      JSON.stringify(item),
    ])
  ).rows[0].v;
  expect(reply.outcome).toBe("succeeded");
}
const stored = async (client: Client) => ({
  rows: (await client.query("SELECT env,batch_id,family,item_key,ordinal,item FROM delphi_result_rows ORDER BY batch_id,family,ordinal")).rows,
  jobs: (await client.query("SELECT job_id,kind,status FROM delphi_jobs ORDER BY created_at,job_id")).rows,
  served: (await client.query("SELECT * FROM delphi_graph_served ORDER BY zid,scope_key")).rows,
});

beforeAll(async () => {
  admin = new Client({ connectionString: process.env.DATABASE_URL });
  await admin.connect();
  for (const db of DATABASES) await admin.query(`DROP DATABASE IF EXISTS ${db} WITH (FORCE)`);
  before = releaseWith((name) => name < NAME);
  through = releaseWith((name) => name <= NAME);
});
afterAll(async () => {
  for (const db of DATABASES) await admin?.query(`DROP DATABASE IF EXISTS ${db} WITH (FORCE)`);
  await admin?.end();
  for (const release of [before, through]) if (release) fs.rmSync(path.dirname(release), { recursive: true, force: true });
});

let upgraded: Awaited<ReturnType<typeof catalog>>;

test("over the older shape: deploy applies only 000046, stored results are unchanged, the earlier release checks beside it", async () => {
  await admin.query("CREATE DATABASE m000046_upgrade");
  runner("m000046_upgrade", "deploy", before);
  await withDatabase("m000046_upgrade", async (client) => {
    await seedDelphi(client, 1, "first");
    const was = await stored(client);
    const bindingBefore = await binding(client);
    const out = runner("m000046_upgrade", "deploy", through);
    expect(out.split("\n").filter((l) => l.startsWith("APPLIED "))).toEqual([`APPLIED ${NAME}`]);
    expect((await client.query("SELECT status,compat FROM migrations WHERE name=$1", [NAME])).rows).toEqual([
      { status: "APPLIED", compat: "additive" },
    ]);
    expect(await stored(client)).toEqual(was);
    // The earlier release, beside the newer migration.
    expect(runner("m000046_upgrade", "check", before)).toMatch(/tolerating 000046_create_delphi_narrative_jobs\.sql|newer additive migration/);
    // Its writer still writes, through the redefined binding.
    await seedDelphi(client, 1, "second");
    const now = await stored(client);
    expect(now.jobs.length).toBe(was.jobs.length + 1);
    expect(now.jobs.every((j: any) => j.status === "succeeded")).toBe(true);
    // The binding differs from 000027's by the topic-name clause alone.
    const bindingAfter = await binding(client);
    expect(bindingAfter).not.toBe(bindingBefore);
    const stripped = bindingAfter
      .replace("j.kind NOT IN ('narrative','topic_name')", "j.kind<>'narrative'")
      .replace(/\n OR \(q\.stage='delphi_narrative' AND j\.kind='topic_name' AND NOT EXISTS\(\n[^\n]*\)\)/, "");
    expect(stripped).toBe(bindingBefore);
    upgraded = await catalog(client);
    expect(upgraded.functions.map((f: any) => f.name)).toEqual([
      "pd_narrative_compare(text,uuid,uuid)",
      "pd_narrative_job_doc(delphi_narrative_jobs)",
      "pd_narrative_job_read(text,uuid)",
      "pd_narrative_job_submit(text,text,uuid,uuid,jsonb,jsonb,jsonb,text)",
      "pd_narrative_jobs_list(text,text)",
      "pd_narrative_pack_current(text,text)",
      "pd_narrative_pack_put(text,integer,text,jsonb,text)",
      "pd_narrative_publish(text,text,uuid,integer)",
      "pd_narrative_source_state(integer,text)",
      "pd_queue_binding()",
    ]);
    expect(upgraded.triggers.map((t: any) => t.tgname)).toEqual([
      "narrative_job_immutable",
      "narrative_pack_immutable",
      "narrative_publication_immutable",
    ]);

    // Down: drops what 000046 made and restores 000027's binding exactly.
    await client.query(fs.readFileSync(DOWN, "utf8"));
    expect(await binding(client)).toBe(bindingBefore);
    expect((await catalog(client)).columns).toEqual([]);
    expect(await stored(client)).toEqual(now);
    await client.query("DELETE FROM migrations WHERE name=$1", [NAME]);
    // Applied again: the same catalog.
    runner("m000046_upgrade", "deploy", through);
    expect(await catalog(client)).toEqual(upgraded);
  });
}, 120000);

test("on an empty database the release gives the same catalog, and down refuses while a pack is stored", async () => {
  await admin.query("CREATE DATABASE m000046_fresh");
  runner("m000046_fresh", "deploy");
  await withDatabase("m000046_fresh", async (client) => {
    expect(await catalog(client)).toEqual(upgraded);
    await seedDelphi(client, 2, "fresh");
    const pack = {
      schema: "polis-narrative-pack/1",
      pack_id: "00000000-0000-4000-8000-00000000f001",
      zid: "2",
      report_id: "rmigration2",
      prompt_version: "narrative/1",
      inputs: {},
      sections: [{ section: "generated" }],
    };
    expect(
      (await client.query("SELECT public.pd_narrative_pack_put($1,2,'rmigration2',$2::jsonb,$3) AS v", [ENV, JSON.stringify(pack), "c".repeat(64)]))
        .rows[0].v.outcome
    ).toBe("stored");
    await expect(client.query(fs.readFileSync(DOWN, "utf8"))).rejects.toThrow(/narrative jobs are stored/);
    await client.query("ROLLBACK").catch(() => undefined);
    expect(await catalog(client)).toEqual(upgraded);
  });
}, 120000);
