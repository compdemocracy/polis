"use strict";
/**
 * The Postgres schema the collective-statement recordings stand on, pinned
 * by shape rather than by migration count.
 *
 * The recordings depend on exactly the relations the fixture writes
 * (fixtures.cjs, the shared vote writer seed-vote.cjs) and the routes read
 * (routes/collectiveStatement.ts, utils/parameter.ts). A migration that
 * touches none of them cannot change what the cases serve, so the index pins
 * the shape of those relations as read at record time (columns, constraints,
 * rules, triggers; indexes are left out, they change plans, not results) and
 * the definition of the one function the vote writer asks for. Replay fails
 * when that shape differs; a migration adding an unrelated table or an index
 * passes. Pinning the migration file digests instead would need the harness
 * to decide which migrations touch these relations by parsing SQL, and would
 * still fail on a comment edit to 000000_initial.sql.
 */

const RELATIONS = {
  users: "fixture: the owner and participant accounts",
  oidc_user_mappings: "fixture: OIDC subject -> uid for the signed-in callers",
  conversations: "fixture: the recorded conversations",
  zinvites: "fixture: the conversation ids the routes are called with",
  reports:
    "fixture; route: report_id -> zid (utils/parameter.ts getZidFromReport)",
  participants: "fixture: who voted",
  comments:
    "fixture; route: the comment texts and moderation (routes/collectiveStatement.ts)",
  votes:
    "fixture: the stored votes (seed-vote.cjs); its insert rule fills votes_latest_unique",
  votes_latest_unique:
    "route: the per-comment vote counts (routes/collectiveStatement.ts)",
};

const FUNCTIONS = ["public.vote_convention_current()"]; // seed-vote.cjs databaseConvention

const ws = (s) => String(s).replace(/\s+/g, " ").trim();

/**
 * Reads the shape with `query(text, params) -> { rows }` (a pg Client).
 * Returns a plain object fit for the index: every value is a string, every
 * list sorted, so two reads of the same schema serialise identically.
 */
async function readSchema(query) {
  const names = Object.keys(RELATIONS).sort();
  const columns = await query(
    `SELECT c.relname AS relation, c.relkind, a.attname, a.attnum,
            format_type(a.atttypid, a.atttypmod) AS type, a.attnotnull,
            pg_get_expr(d.adbin, d.adrelid) AS def
       FROM pg_class c
       JOIN pg_namespace n ON n.oid = c.relnamespace
       JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped
       LEFT JOIN pg_attrdef d ON d.adrelid = c.oid AND d.adnum = a.attnum
      WHERE n.nspname = 'public' AND c.relname = ANY($1)
      ORDER BY c.relname, a.attnum`,
    [names],
  );
  const constraints = await query(
    `SELECT c.relname AS relation, k.conname, pg_get_constraintdef(k.oid) AS def
       FROM pg_constraint k
       JOIN pg_class c ON c.oid = k.conrelid
       JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relname = ANY($1)
      ORDER BY c.relname, k.conname`,
    [names],
  );
  const rules = await query(
    `SELECT tablename AS relation, rulename, definition
       FROM pg_rules WHERE schemaname = 'public' AND tablename = ANY($1)
      ORDER BY tablename, rulename`,
    [names],
  );
  const triggers = await query(
    `SELECT c.relname AS relation, t.tgname, pg_get_triggerdef(t.oid) AS def
       FROM pg_trigger t
       JOIN pg_class c ON c.oid = t.tgrelid
       JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND NOT t.tgisinternal AND c.relname = ANY($1)
      ORDER BY c.relname, t.tgname`,
    [names],
  );
  const relations = {};
  for (const name of names)
    relations[name] = {
      kind: "missing",
      columns: [],
      constraints: [],
      rules: [],
      triggers: [],
    };
  const kinds = {
    r: "table",
    v: "view",
    m: "materialized view",
    p: "partitioned table",
  };
  for (const r of columns.rows) {
    const rel = relations[r.relation];
    rel.kind = kinds[r.relkind] || String(r.relkind);
    rel.columns.push(
      `${r.attname} ${r.type}${r.attnotnull ? " not null" : ""}${
        r.def == null ? "" : ` default ${ws(r.def)}`
      }`,
    );
  }
  for (const r of constraints.rows)
    relations[r.relation].constraints.push(`${r.conname} ${ws(r.def)}`);
  for (const r of rules.rows)
    relations[r.relation].rules.push(`${r.rulename}: ${ws(r.definition)}`);
  for (const r of triggers.rows)
    relations[r.relation].triggers.push(`${r.tgname}: ${ws(r.def)}`);
  const functions = {};
  for (const f of FUNCTIONS) {
    const r = await query(
      "SELECT pg_get_functiondef(to_regprocedure($1)) AS def",
      [f],
    );
    const def = r.rows[0] && r.rows[0].def;
    functions[f] = def == null ? null : ws(def);
  }
  return { relations, functions };
}

/** The differences between two shapes, one line each; [] when they agree. */
function schemaDrift(recorded, current) {
  const out = [];
  const rels = new Set([
    ...Object.keys((recorded && recorded.relations) || {}),
    ...Object.keys((current && current.relations) || {}),
  ]);
  for (const name of [...rels].sort()) {
    const a = recorded && recorded.relations && recorded.relations[name];
    const b = current && current.relations && current.relations[name];
    if (!a || !b) {
      out.push(
        `${name}: ${a ? "no longer pinned" : "not in the recorded pin"}`,
      );
      continue;
    }
    if (a.kind !== b.kind) {
      out.push(`${name}: recorded as ${a.kind}, now ${b.kind}`);
      if (a.kind === "missing" || b.kind === "missing") continue;
    }
    for (const part of ["columns", "constraints", "rules", "triggers"]) {
      const was = new Set(a[part] || []);
      const now = new Set(b[part] || []);
      const gone = [...was].filter((x) => !now.has(x));
      const added = [...now].filter((x) => !was.has(x));
      if (gone.length || added.length)
        out.push(
          `${name}: ${part} changed` +
            gone.map((x) => ` -[${x}]`).join("") +
            added.map((x) => ` +[${x}]`).join(""),
        );
    }
  }
  const fns = new Set([
    ...Object.keys((recorded && recorded.functions) || {}),
    ...Object.keys((current && current.functions) || {}),
  ]);
  for (const f of [...fns].sort()) {
    const a =
      recorded && recorded.functions ? recorded.functions[f] : undefined;
    const b = current && current.functions ? current.functions[f] : undefined;
    if (a === undefined || b === undefined)
      out.push(
        `${f}: ${a === undefined ? "not in the recorded pin" : "no longer pinned"}`,
      );
    else if (a !== b)
      out.push(
        `${f}: ${a == null ? "absent at record time, now defined" : b == null ? "defined at record time, now absent" : "definition changed"}`,
      );
  }
  return out;
}

module.exports = { RELATIONS, FUNCTIONS, readSchema, schemaDrift };
