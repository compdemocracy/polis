'use strict';
const fs = require('node:fs'),
  path = require('node:path'),
  http = require('node:http'),
  https = require('node:https');
const { Pool } = require('pg');
const {
  DynamoDBClient,
  ListTablesCommand,
  ScanCommand,
  CreateTableCommand,
} = require('@aws-sdk/client-dynamodb');
const {
  canonical,
  hash,
  delta,
  firstDiff,
  normalizeDump,
  coverage,
  readRecording,
  oracle,
} = require('./core.cjs');
const { Normalizer, policy } = require('./normalize.cjs');
const { generate } = require('./generate.cjs');
const inventory = require('./inventory.json'),
  scope = require('./scope.json');
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const dynamo = new DynamoDBClient({
  endpoint: process.env.DYNAMODB_ENDPOINT,
  region: 'us-east-1',
  credentials: { accessKeyId: 'generatedlocal', secretAccessKey: 'generatedlocal' },
  maxAttempts: 1,
});
const base = process.env.P027_BASE_URL || 'http://localhost:5000';
const control = process.env.P027_CONTROL_URL || 'http://localhost:5001';
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const quoted = (x) => '"' + x.replaceAll('"', '""') + '"';
async function get(p) {
  const r = await fetch(control + p, { signal: AbortSignal.timeout(10000) });
  if (!r.ok) throw Error(`observer ${p}: ${r.status}`);
  return r.json();
}
async function schema() {
  return (
    await pool.query(
      "select table_name,column_name,data_type,udt_name from information_schema.columns where table_schema='public' order by table_name,ordinal_position"
    )
  ).rows;
}
async function snapshot(tables) {
  const client = await pool.connect();
  const result = {};
  try {
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    for (const table of tables)
      result[`pg:${table}`] = (
        await client.query(
          `select to_jsonb(t) as row from ${quoted(table)} t order by to_jsonb(t)::text`
        )
      ).rows.map((r) => r.row);
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
  let next;
  do {
    const out = await dynamo.send(new ListTablesCommand({ ExclusiveStartTableName: next }));
    for (const table of out.TableNames) {
      let key;
      const rows = [];
      do {
        const page = await dynamo.send(
          new ScanCommand({ TableName: table, ExclusiveStartKey: key, ConsistentRead: true })
        );
        rows.push(...page.Items);
        key = page.LastEvaluatedKey;
      } while (key);
      result[`dynamo:${table}`] = rows.sort((a, b) => canonical(a).localeCompare(canonical(b)));
    }
    next = out.LastEvaluatedTableName;
  } while (next);
  return result;
}
function send(request, tokens, deadlineMs = 2000) {
  return new Promise((resolve) => {
    const u = new URL(request.path, base);
    for (const [k, v] of Object.entries(request.query))
      u.searchParams.set(k, typeof v === 'object' ? JSON.stringify(v) : String(v));
    const headers = { host: 'localhost:5000', ...request.headers };
    if (headers.authorization?.startsWith('$auth:'))
      headers.authorization = `Bearer ${tokens[headers.authorization.slice(6)]}`;
    const start = performance.now();
    let responseStatus=null,responseHeaders={};
    let first = null,
      done = false,
      chunks = [];
    const result = (completed, status = null, rheaders = {}) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      const bytes = Buffer.concat(chunks),
        raw = bytes.toString('utf8');
      let body = Buffer.from(raw).equals(bytes) ? raw : { $base64: bytes.toString('base64') };
      if (rheaders['content-type']?.includes('application/json')) {
        try {
          body = JSON.parse(raw);
        } catch {}
      }
      resolve({
        completed,
        status,
        headers: Object.fromEntries(
          policy.responseHeaders
            .filter((k) => rheaders[k] !== undefined)
            .map((k) => [k, rheaders[k]])
        ),
        body,
        ttfbMs: first,
        ttlbMs: performance.now() - start,
      });
    };
    const req = (u.protocol === 'https:' ? https : http).request(
      u,
      { method: request.method, headers },
      (res) => {
        first = performance.now() - start;
        responseStatus=res.statusCode;responseHeaders=res.headers;
        res.on('data', (b) => chunks.push(b));
        res.on('end', () => result(true, res.statusCode, res.headers));
        res.on('error', () => result(false, res.statusCode, res.headers));
      }
    );
    const timer = setTimeout(() => {
      result(false,responseStatus,responseHeaders);
      req.destroy();
    }, deadlineMs);
    req.on('error', () => result(false,responseStatus,responseHeaders));
    if (request.body !== null) req.write(JSON.stringify(request.body));
    req.end();
  });
}
let caseActive = false;
async function runCase(c, tokens, tables, normalizer) {
  if (caseActive) throw Error('concurrent case execution forbidden');
  caseActive = true;
  await get('/begin?seed='+c.seed);
  const before = await snapshot(tables),
    obsBefore = await get('/state');
  const response = await send(c.request, tokens);
  // Capture delayed 100 ms writes, then demand quiescence; do not treat an arbitrary delay as proof.
  await wait(200);
  let after = await snapshot(tables),
    stable = false;
  for (let n = 0; n < 8; n++) {
    await wait(100);
    const check = await snapshot(tables);
    if (canonical(after) === canonical(check)) {
      stable = true;
      break;
    }
    after = check;
  }
  let observerUnavailable=false;
  const obsAfter = await get('/state').catch(() => {
    observerUnavailable=true;
    const events=fs.readFileSync('/artifacts/process-events.jsonl','utf8').trim();
    return {...obsBefore,process:events?events.split('\n').map(x=>JSON.parse(x)):obsBefore.process};
  });
  const processErrors = obsAfter.process.slice(obsBefore.process.length);
  const db = delta(before, after),
    files = delta(
      Object.fromEntries(Object.entries(obsBefore.files).map(([k, v]) => [k, [v]])),
      Object.fromEntries(Object.entries(obsAfter.files).map(([k, v]) => [k, [v]]))
    );
  const effects = {
    db,
    files,
    outbound: obsAfter.outbound.slice(obsBefore.outbound.length),
    participantCreated: (db['pg:participants']?.added || []).some(a =>
      !(db['pg:participants']?.removed || []).some(b => a.zid===b.zid && a.pid===b.pid)),
    jwtIssued: (obsAfter.jwtIssues || 0) > (obsBefore.jwtIssues || 0),
  };
  const o = oracle(response, processErrors, c.case === 'proxy-tail');
  if(observerUnavailable){o.pass=false;o.failures.push('observer unavailable');}
  if (!stable) {
    o.pass = false;
    o.failures.push('effects did not settle');
  }
  const enabled = inventory.routes.filter((r) => r.registered_in_default_config);
  const routeHits = [
    ...new Set(obsAfter.hits.slice(obsBefore.hits.length).map((i) => enabled[i]?.id)),
  ].sort((a, b) => a - b);
  if (c.routeId && !routeHits.includes(c.routeId)) {
    o.pass = false;
    o.failures.push('target route was not reached');
  }
  caseActive = false;
  return {
    ...c,
    version: 1,
    response: normalizer.normalize(response, '$.response'),
    effects: normalizer.normalize(effects, '$.effects'),
    process: processErrors,
    oracle: o,
    routeHits,
  };
}
function comparable(c) {
  const copy = JSON.parse(JSON.stringify(c));
  delete copy.response.ttfbMs;
  delete copy.response.ttlbMs;
  return copy;
}
function write(dir, name, x) {
  fs.writeFileSync(
    path.join(dir, name),
    typeof x === 'string' ? x : JSON.stringify(x, null, 2) + '\n'
  );
}
async function main() {
  const [command, dir = '/artifacts/recording', profile = 'boundary', fromRoute = '1'] = process.argv.slice(2);
  if (!/^\d+$/.test(fromRoute) || Number(fromRoute) < 1 || Number(fromRoute) > 201)
    throw Error('from-route must be an inventory ID from 1 through 201');
  if (command === 'init-dynamo') {
    const tables = require('./dynamo-schema.json').tables;
    for (const [TableName, spec] of Object.entries(tables))
      await dynamo.send(new CreateTableCommand({ TableName, ...spec }));
    await pool.query("INSERT INTO participant_metadata_questions(pmqid,zid,key,created) VALUES(1,1,'Generated question',1700000000000)");
    await pool.query("INSERT INTO participant_metadata_answers(pmaid,pmqid,zid,value,created) VALUES(1,1,1,'Generated answer',1700000000000)");
    await pool.query("SELECT setval('participant_metadata_questions_pmqid_seq',1,true),setval('participant_metadata_answers_pmaid_seq',1,true)");
    console.log(`created ${Object.keys(tables).length} generated empty Dynamo tables and generated metadata fixtures`);
    return;
  }
  if (command === 'seed') {
    if (new URL(process.env.DATABASE_URL).pathname !== '/p027')
      throw Error('seed only accepts disposable p027 database');
    const tables = (
      await pool.query(
        "select tablename from pg_tables where schemaname='public' order by tablename"
      )
    ).rows.map((r) => r.tablename);
    await pool.query(`TRUNCATE ${tables.map(quoted).join(',')} RESTART IDENTITY CASCADE`);
    await pool.query(fs.readFileSync(path.join(__dirname, 'fixture.sql'), 'utf8'));
    for (const r of await schema()) {
      if (
        policy.timeFields.includes(r.column_name) &&
        ['bigint', 'integer'].includes(r.data_type) &&
        tables.includes(r.table_name)
      )
        await pool.query(
          `UPDATE ${quoted(r.table_name)} SET ${quoted(r.column_name)}=1700000000000 WHERE ${quoted(
            r.column_name
          )} IS NOT NULL AND ${quoted(r.column_name)} NOT IN (0,-1)`
        );
    }
    await pool.query('UPDATE conversations SET created=1700000000000+zid*1000, modified=1700000000000+zid*1000');
    await pool.query("UPDATE zinvites SET uuid='00000000-0000-4000-8000-000000000027'");
    const tokens = await get('/tokens');
    for (const [role, uid] of [
      ['owner', 1],
      ['admin', 2],
    ]) {
      const claims = JSON.parse(Buffer.from(tokens[role].split('.')[1], 'base64url'));
      await pool.query(
        'INSERT INTO oidc_user_mappings(oidc_sub,uid,created) VALUES($1,$2,1700000000000)',
        [claims.sub, uid]
      );
    }
    console.log('generated fixture installed');
    return;
  }
  const dump = await get('/ready');
  const routes = normalizeDump(dump, inventory);
  if (command === 'probe-oracle') {
    const before = await get('/state');
    const response = await send(
      {
        method: 'GET',
        path: '/api/v3/testConnection',
        query: {},
        headers: { 'x-forwarded-proto': 'https' },
        body: null,
      },
      {}
    );
    await wait(200);
    const after = await get('/state').catch(()=>({process:fs.readFileSync('/artifacts/process-events.jsonl','utf8').trim().split('\n').filter(Boolean).map(x=>JSON.parse(x))}));
    const verdict = oracle(response, after.process.slice(before.process.length));
    console.log(JSON.stringify({ route: 'GET /api/v3/testConnection', response, verdict }));
    if (!verdict.pass) process.exitCode = 1;
    return;
  }
  if (command === 'coverage') {
    console.log(
      `PASS: ${dump.routes.length} runtime entries -> ${routes.length} enabled + 1 explicitly disabled = 201`
    );
    return;
  }
  if (dump.boot.notificationLoop)
    throw Error('background notification loop running during ordinary recording');
  if (
    dump.boot.outbound.some(
      (c) =>
        !c.blocked &&
        !['postgres', 'dynamodb', 'file-server', 'oidc-simulator', 'localhost'].includes(c.host)
    )
  )
    throw Error('unapproved boot egress');
  if (dump.boot.process.length) throw Error('process error at boot');
  const schemaRows = await schema();
  if (hash(schemaRows) !== hash(require('./catalog.json')))
    throw Error(
      'unknown schema column/type: update the reviewed catalog and column policy before recording'
    );
  const tables = [...new Set(schemaRows.map((r) => r.table_name))].filter(
    (t) => !t.startsWith('pg_')
  );
  // Snapshot only tables, not views (views can be nondeterministic and duplicate effects).
  const actualTables = new Set(
    (await pool.query("select tablename from pg_tables where schemaname='public'")).rows.map(
      (r) => r.tablename
    )
  );
  const selected = tables.filter((t) => actualTables.has(t));
  const tokens = await get('/tokens');
  for (const auth of ['participant', 'owner', 'admin']) {
    const probe = await send(
      {
        method: 'GET',
        path: '/api/v3/users',
        query: {},
        headers: { authorization: `$auth:${auth}`, 'x-forwarded-proto': 'https' },
        body: null,
      },
      tokens
    );
    if (probe.status !== 200) throw Error(`auth preflight failed for ${auth}: ${probe.status}`);
  }
  const norm = new Normalizer(),
    initial = await snapshot(selected);
  const expected = command === 'replay' ? readRecording(dir) : null;
  const planned = expected
    ? expected.cases.map((c) => ({
        caseId: c.caseId,
        routeId: c.routeId,
        auth: c.auth,
        case: c.case,
        seed: c.seed,
        request: c.request,
      }))
    : generate(inventory, scope, 'p027-v1', profile).filter(
        (c) => c.routeId === null || c.routeId >= Number(fromRoute)
      );
  if (expected) {
    for (const [k, v] of Object.entries({
      inventoryHash: hash(inventory),
      schemaHash: hash(schemaRows),
      normalizationHash: hash(policy),
      scopeHash: hash(scope),
      corpusHash: hash(initial),
    }))
      if (expected.manifest[k] !== v) throw Error(`manifest ${k} mismatch`);
  }
  const results = [],
    diffs = [];
  for (let i = 0; i < planned.length; i++) {
    const actual = await runCase(planned[i], tokens, selected, norm);
    results.push(actual);
    const field = expected ? firstDiff(comparable(expected.cases[i]), comparable(actual)) : null;
    diffs.push({
      route: actual.routeId,
      auth: actual.auth,
      case: actual.case,
      result: field || !actual.oracle.pass ? 'different' : 'same',
      firstField: field || actual.oracle.failures[0] || '',
    });
    if (i % 25 === 0 || !actual.oracle.pass || field)
      console.log(
        `${i + 1}/${planned.length} ${actual.caseId} status=${actual.response.status} ${
          actual.oracle.pass ? 'complete' : actual.oracle.failures.join('; ')
        }${field ? ' DIFF ' + field : ''}`
      );
    if ((field && process.env.P027_STOP_ON_DIFF === '1') || actual.oracle.failures.includes('observer unavailable')) break;
  }
  const cov = coverage(inventory, scope, results),
    failures = results.filter((c) => !c.oracle.pass).length;
  if (command === 'record') {
    fs.mkdirSync(dir, { recursive: true });
    const meta = fs.existsSync('/artifacts/stack.json')
      ? JSON.parse(fs.readFileSync('/artifacts/stack.json'))
      : null;
    if (!meta) throw Error('missing host-verified stack.json provenance');
    write(dir, 'manifest.json', {
      version: 1,
      inventoryHash: hash(inventory),
      inventorySourceHash: inventory.source_sha256,
      appCommit: meta.commit,
      appSourceHash: meta.sourceHash,
      stackDigest: hash(meta),
      stack: meta,
      schemaHash: hash(schemaRows),
      migrationVersion: meta.migrationHash,
      seed: 'p027-v1',
      profile,
      scopeHash: hash(scope),
      normalizationHash: hash(policy),
      corpusHash: hash(initial),
      inputsHash: hash(results.map((c) => ({ caseId: c.caseId, request: c.request }))),
      caseCount: results.length,
      blockingFailures: failures,
      coverage: cov,
    });
    write(dir, 'cases.jsonl', results.map((c) => JSON.stringify(c)).join('\n') + '\n');
    write(dir, 'schema.json', schemaRows);
    write(dir, 'boot.json', dump.boot);
    write(dir, 'routes.json', dump);
    write(dir, 'normalization.json', { policy, applications: norm.rules });
  }
  const out = command === 'replay' ? `${dir}-replay` : dir;
  fs.mkdirSync(out, { recursive: true });
  if(command==='replay')write(out,'cases.actual.jsonl',results.map(c=>JSON.stringify(c)).join('\n')+'\n');
  write(out, 'results.json', {
    cases: results.length,
    failures,
    differences: diffs.filter((d) => d.result === 'different').length,
    coverage: cov,
    rows: diffs,
  });
  write(
    out,
    'report.md',
    '| Route | Auth | Case | Result | First differing field |\n|---|---|---|---|---|\n' +
      diffs
        .map(
          (d) =>
            `| ${d.route ?? 'proxy-tail'} | ${d.auth} | ${d.case} | ${d.result} | ${d.firstField} |`
        )
        .join('\n') +
      '\n'
  );
  console.log(
    JSON.stringify({
      cases: results.length,
      oracleFailures: failures,
      differences: diffs.filter((d) => d.result === 'different').length,
      recorded: cov.recorded,
      excluded: cov.excluded,
      missing: cov.missing,
    })
  );
  if (failures || cov.missing || diffs.some((d) => d.result === 'different')) process.exitCode = 1;
}
main()
  .catch((e) => {
    console.error(e.stack);
    process.exitCode = 1;
  })
  .finally(async () => {
    await pool.end();
    dynamo.destroy();
  });
