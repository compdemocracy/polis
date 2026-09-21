"use strict";

const { EventEmitter } = require("node:events");
const forbidden = new Set([
  "BEGIN", "START", "COMMIT", "ROLLBACK", "SAVEPOINT", "RELEASE", "SET", "RESET",
  "DISCARD", "COPY", "CALL", "DO", "INSERT", "UPDATE", "DELETE", "TRUNCATE",
  "CREATE", "DROP", "ALTER", "GRANT", "REVOKE", "MERGE", "PREPARE", "EXECUTE",
  "SET_CONFIG", "PG_NOTIFY", "PG_ADVISORY_LOCK", "PG_TRY_ADVISORY_LOCK",
  "PG_ADVISORY_XACT_LOCK", "PG_TRY_ADVISORY_XACT_LOCK", "PG_ADVISORY_UNLOCK",
  "PG_ADVISORY_UNLOCK_ALL", "LO_IMPORT", "LO_EXPORT", "DBLINK", "DBLINK_EXEC",
]);

// Defense in depth for the admitted app, not a SQL authorization parser.
// The independently provisioned least-privilege role and READ ONLY transaction
// remain required; arbitrary user-defined functions are not proved safe here.
function admitQuery(input) {
  const text = typeof input === "string" ? input : input?.text;
  if (typeof text !== "string" || text.length > 1024 * 1024) throw Error("SHADOW_QUERY");
  let plain = "", i = 0;
  while (i < text.length) {
    if (text.startsWith("--", i)) {
      const end = text.indexOf("\n", i + 2);
      i = end < 0 ? text.length : end + 1;
      plain += " ";
    } else if (text.startsWith("/*", i)) {
      const end = text.indexOf("*/", i + 2);
      if (end < 0 || text.slice(i + 2, end).includes("/*")) throw Error("SHADOW_QUERY");
      i = end + 2;
      plain += " ";
    } else if (text[i] === "'" || text[i] === '"') {
      const quote = text[i++];
      let done = false, identifier = "";
      while (i < text.length) {
        if (text[i] === "\\") throw Error("SHADOW_QUERY");
        const char = text[i++];
        if (char === quote) {
          if (text[i] === quote) { identifier += quote; i++; }
          else { done = true; break; }
        } else identifier += char;
      }
      if (!done) throw Error("SHADOW_QUERY");
      // Keep quoted identifiers visible to the control-function denylist.
      plain += quote === '"' ? ` ${identifier} ` : " ";
    } else if (text[i] === "$" && /^\$(?:[A-Za-z_][A-Za-z_0-9]*)?\$/.test(text.slice(i))) {
      throw Error("SHADOW_QUERY");
    } else plain += text[i++];
  }
  const statements = plain.trim().replace(/;\s*$/, "");
  if (statements.includes(";")) throw Error("SHADOW_QUERY");
  const words = statements.toUpperCase().match(/[A-Z_][A-Z_0-9]*/g) || [];
  if (!["SELECT", "WITH"].includes(words[0]) || words.some((word) => forbidden.has(word))) {
    throw Error("SHADOW_QUERY");
  }
  return text;
}

function install(pg, snapshot, connectionConfig = {}, { QueryStream } = {}) {
  if (!/^[0-9A-Fa-f]+-[0-9A-Fa-f]+-[0-9]+$/.test(snapshot)) throw Error("SHADOW_SNAPSHOT");
  const OriginalPool = pg.Pool;
  const pools = new Set(), states = new WeakMap();
  class SnapshotPool extends EventEmitter {
    constructor() {
      super();
      // Never inherit caller Client/verify/options/SSL overrides. Both app pools
      // use exactly the connection admitted by the private bootstrap.
      const raw = new OriginalPool({ ...connectionConfig, max: 2,
        connectionTimeoutMillis: 10000, idleTimeoutMillis: 0 });
      const state = { raw, admitted: new WeakSet(), borrowed: new Set(), ending: false };
      states.set(this, state); pools.add(this);
      raw.on?.("error", () => {
        state.failed = true;
        this.emit("error", Error("SHADOW_DATABASE"));
      });
    }
    connect(callback) {
      const state = states.get(this);
      const connected = Promise.resolve().then(async () => {
        if (state.ending || state.failed) throw Error("SHADOW_DATABASE");
        const client = await state.raw.connect();
        state.borrowed.add(client);
        try {
          if (!state.admitted.has(client)) {
            await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
            await client.query(`SET TRANSACTION SNAPSHOT '${snapshot}'`);
            await client.query("SET LOCAL statement_timeout='10s'; SET LOCAL lock_timeout='500ms'");
            const check = await client.query(`SELECT current_setting('transaction_read_only') = 'on' AS readonly,
              r.rolsuper OR r.rolcreaterole OR r.rolcreatedb OR r.rolreplication OR r.rolbypassrls AS elevated,
              EXISTS (SELECT 1 FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
                WHERE n.nspname='public' AND c.relkind IN ('r','p','v','m','f') AND
                (pg_catalog.has_table_privilege(session_user,c.oid,'INSERT,UPDATE,DELETE,TRUNCATE,TRIGGER') OR
                 pg_catalog.has_any_column_privilege(session_user,c.oid,'INSERT,UPDATE'))) AS table_write,
              EXISTS (SELECT 1 FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid=p.pronamespace
                WHERE n.nspname='public' AND pg_catalog.starts_with(p.proname::text,'pc_') AND
                pg_catalog.has_function_privilege(session_user,p.oid,'EXECUTE')) AS control_execute
              FROM pg_catalog.pg_roles r WHERE r.rolname = session_user`);
            if (check.rows.length !== 1 || check.rows[0].readonly !== true || check.rows[0].elevated !== false ||
                check.rows[0].table_write !== false || check.rows[0].control_execute !== false) {
              throw Error("SHADOW_DATABASE_ROLE");
            }
            state.admitted.add(client);
          }
          if (state.ending || state.failed) throw Error("SHADOW_DATABASE");
          let released = false;
          const facade = {
            query(input, ...args) {
              const ownCallback = input && typeof input === "object" ? Object.getOwnPropertyDescriptor(input, "callback")?.value : null;
              const cb = typeof args.at(-1) === "function" ? args.at(-1) :
                (typeof ownCallback === "function" ? ownCallback : null);
              try {
                if (released || state.ending || state.failed) throw Error("SHADOW_DATABASE");
                if (QueryStream && input instanceof QueryStream) {
                  // Reconstruct an admitted library stream, so a caller's
                  // submit/cursor overrides never receive the raw connection.
                  const text = admitQuery(input.cursor?.text);
                  return client.query(new QueryStream(text, input.cursor.values,
                    { highWaterMark: input.readableHighWaterMark }));
                }
                if (typeof input !== "string") {
                  if (!input || Object.getPrototypeOf(input) !== Object.prototype ||
                      Object.keys(input).some((k) => !["text", "values", "name", "rowMode", "callback"].includes(k))) {
                    throw Error("SHADOW_QUERY");
                  }
                  if (Object.values(Object.getOwnPropertyDescriptors(input)).some((d) => d.get || d.set)) {
                    throw Error("SHADOW_QUERY");
                  }
                }
                admitQuery(input);
                return client.query(input, ...args);
              } catch {
                const error = Error("SHADOW_QUERY");
                if (cb) { queueMicrotask(() => cb(error)); return; }
                return Promise.reject(error);
              }
            },
            release(destroy) {
              if (released) return;
              released = true;
              if (state.borrowed.delete(client)) client.release(destroy);
            },
            on(event, listener) { if (event !== "error") throw Error("SHADOW_CLIENT_EVENT"); client.on(event, listener); return facade; },
            removeListener(event, listener) { client.removeListener(event, listener); return facade; },
          };
          return Object.freeze(facade);
        } catch {
          if (state.borrowed.delete(client)) client.release(true);
          throw Error("SHADOW_SNAPSHOT_IMPORT");
        }
      }).catch(() => { throw Error("SHADOW_SNAPSHOT_IMPORT"); });
      if (callback) {
        // The existing app calls release(err) even on connect failure.
        connected.then((client) => callback(null, client, client.release),
          (error) => callback(error, undefined, () => {}));
        return;
      }
      return connected;
    }
    query(input, ...args) {
      // The app uses streaming only through a borrowed client. A pool-level
      // stream would release that client before the stream has finished.
      if (QueryStream && input instanceof QueryStream) return Promise.reject(Error("SHADOW_QUERY"));
      let cb = typeof args.at(-1) === "function" ? args.pop() : null;
      if (input && Object.getPrototypeOf(input) === Object.prototype &&
          typeof Object.getOwnPropertyDescriptor(input, "callback")?.value === "function") {
        const descriptors = Object.getOwnPropertyDescriptors(input);
        cb ||= descriptors.callback.value;
        delete descriptors.callback;
        input = Object.defineProperties({}, descriptors);
      }
      const result = this.connect().then(async (client) => {
        try { const value = await client.query(input, ...args); client.release(); return value; }
        catch { client.release(true); throw Error("SHADOW_QUERY"); }
      });
      if (cb) { result.then((value) => cb(null, value), cb); return; }
      return result;
    }
    end(callback) {
      const state = states.get(this);
      if (!state.closing) {
        state.ending = true;
        for (const client of state.borrowed) client.release(true);
        state.borrowed.clear();
        state.closing = Promise.resolve(state.raw.end?.()).finally(() => pools.delete(this));
      }
      if (callback) { state.closing.then(() => callback(), callback); return; }
      return state.closing;
    }
    static async ready() {
      for (const pool of pools) { const client = await pool.connect(); client.release(); }
    }
    static async closeAll() { await Promise.allSettled([...pools].map((pool) => pool.end())); }
  }
  pg.Pool = SnapshotPool;
  pg.Client = class { constructor() { throw Error("SHADOW_DIRECT_CLIENT"); } };
  if (Object.getOwnPropertyDescriptor(pg, "native")?.configurable) {
    Object.defineProperty(pg, "native", { get() { throw Error("SHADOW_DIRECT_CLIENT"); } });
  }
  return SnapshotPool;
}

module.exports = { admitQuery, install };
