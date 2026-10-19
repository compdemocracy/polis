"use strict";

// Publish the generated result fixtures and historical queue controls through
// the same codec and validating SQL used by the result-read integration tests.
// These are archived states, not executions of the native queue lifecycle.
const fs = require("node:fs");
const path = require("node:path");
const { Client } = require("pg");
const codec = require("../../src/utils/delphiStorageCodec.ts");
const { publish } = require("../../__tests__/delphi-results-pg/support.ts");

async function setupPostgresResults(connectionString, fixtures) {
  const pg = new Client({ connectionString });
  await pg.connect();
  try {
    const supported = new Set(
      (await pg.query("SELECT family FROM delphi_result_catalog")).rows.map(
        (r) => r.family
      )
    );
    const reports = new Map(
      (await pg.query("SELECT report_id,zid FROM reports")).rows.map((r) => [
        r.report_id,
        r.zid,
      ])
    );
    const byZid = new Map();
    const controls = new Map();
    let rows = 0;
    let controlRows = 0;
    const dir = path.join(fixtures, "dynamo");
    for (const file of fs.readdirSync(dir).filter((f) => f.endsWith(".jsonl")).sort()) {
      const family = file.slice(0, -6);
      if (!supported.has(family) && family !== "Delphi_JobQueue") continue;
      const { items } = codec.decodeFamily(fs.readFileSync(path.join(dir, file)));
      for (const item of items) {
        const zid = Number(
          item.conversation_id?.S ?? item.zid?.S ?? item.zid?.N ??
          item.zid_tick?.S?.split(":")[0] ?? item.zid_tick_gid?.S?.split(":")[0] ??
          reports.get(item.report_id?.S) ??
          reports.get(item.rid_section_model?.S?.split("#")[0]) ??
          item.zid_topic_jobid?.S?.split("#")[0]
        );
        if (!Number.isInteger(zid) || zid <= 0)
          throw new Error(`unmapped PostgreSQL fixture: ${family}`);
        if (family === "Delphi_JobQueue") {
          if (!controls.has(zid)) controls.set(zid, []);
          controls.get(zid).push(item);
          controlRows++;
        } else {
          if (!byZid.has(zid)) byZid.set(zid, {});
          const families = byZid.get(zid);
          (families[family] ??= []).push(item);
          rows++;
        }
      }
    }
    // Pending/running historical states have controls but no result rows. The
    // seal still requires a family; an empty supported family expresses that.
    for (const zid of controls.keys()) {
      if (!byZid.has(zid))
        byZid.set(zid, { Delphi_CommentHierarchicalClusterAssignments: [] });
    }
    for (const [zid, families] of byZid) {
      const legacyControlFiles = controls.has(zid)
        ? { Delphi_JobQueue: codec.encodeFamily("Delphi_JobQueue", controls.get(zid)).toString("utf8") }
        : {};
      await publish(pg, {
        env: "p2zero", scope: "delphi", zid, families, legacyControlFiles,
      });
    }
    return { conversations: byZid.size, rows, controlRows };
  } finally {
    await pg.end();
  }
}

module.exports = { setupPostgresResults };
