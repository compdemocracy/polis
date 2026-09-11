/*
 * CO08 / D4 harness: drive the REAL Node server reader against a published
 * generation, in-process, with no HTTP layer and no mocks.
 *
 * It loads the actual server modules — `server/src/utils/pca.ts` (`getPca`, its
 * LruCache keyed by `[math_env, zid]` and the gzip buffer `/api/v3/math/pca2`
 * serves) and `server/src/utils/participants.ts`
 * (`getBidIndexToPidMapping`, `getPidsForGid`) — and reports, per math_env:
 *
 *   - `asJSON`: the exact string `participationInit` embeds as `response.pca`
 *     and the exact bytes `pca2` gzips; reported as sha256 plus its length.
 *   - `gzip`: sha256 of `asBufferOfGzippedJson`, the literal response body of
 *     `GET /api/v3/math/pca2` when no `keys` filter is given.
 *   - `keys`: the `_.pick(asPOJO, keys)` projection that route serves when
 *     `keys` IS given, so the other pca2 branch is covered too.
 *   - `mapping`: `getBidIndexToPidMapping`'s returned data.
 *   - `pids_for_gid`: the `getPca` + mapping join, per group.
 *
 * The response-boundary presenter owns approved-comment defaults; raw getPca
 * bytes are reported separately and checked for mutation. The current server
 * uses loadBundle internally; this in-process check does not replace the S2
 * interleaving witnesses or the combined full-app campaign.
 *
 * Usage: node node_reader.cjs '<json spec>' where the spec is
 *   {"zid":1,"envs":["python","rustproto"],"keys":["tids","n"],"gids":[0,1]}
 * DATABASE_URL must be set. Writes one JSON object to stdout.
 */
"use strict";

const crypto = require("crypto");
const path = require("path");
const { createRequire } = require("module");

const server = path.resolve(__dirname, "../../server");
// Resolve the server's own dependency tree, not this tool's directory.
const serverRequire = createRequire(path.join(server, "package.json"));

serverRequire("ts-node").register({
  transpileOnly: true,
  skipProject: true,
  compilerOptions: {
    module: "commonjs",
    target: "es2020",
    esModuleInterop: true,
    allowJs: true,
    resolveJsonModule: true,
    skipLibCheck: true,
  },
});

const Config = serverRequire("./src/config").default;
const { getPca } = serverRequire("./src/utils/pca");
const { presentPca } = serverRequire("./src/utils/pcaPresentation");
const participants = serverRequire("./src/utils/participants");
const _ = serverRequire("underscore");

const sha256 = (value) => crypto.createHash("sha256").update(value).digest("hex");

async function readNamespace(zid, mathEnv, keys, gids) {
  // The sanctioned pattern from server/__tests__/integration/math-env-isolation.test.ts.
  Config.mathEnv = mathEnv;
  const raw = await getPca(zid, undefined);
  const rawBefore = raw ? JSON.stringify(raw.asPOJO) : null;
  const item = await presentPca(zid, raw);
  if (!item) {
    return { math_env: mathEnv, present: false };
  }
  const mapping = await participants.getBidIndexToPidMapping(zid, -1);
  const joins = {};
  for (const gid of gids) {
    try {
      const pids = await participants.getPidsForGid(zid, gid, -1);
      joins[gid] = pids;
    } catch (error) {
      joins[gid] = { error: String(error && error.message ? error.message : error) };
    }
  }
  const projection = JSON.stringify(_.pick(item.asPOJO, keys));
  return {
    math_env: mathEnv,
    present: true,
    raw: {
      tids: raw.asPOJO.tids,
      n_cmts: raw.asPOJO["n-cmts"],
      asJSON_sha256: sha256(raw.asJSON),
      gzip_sha256: sha256(raw.asBufferOfGzippedJson),
      unchanged_after_presentation: rawBefore === JSON.stringify(raw.asPOJO),
    },
    n_cmts: item.asPOJO["n-cmts"],
    pca_center: item.asPOJO.pca.center,
    comment_extremity: item.asPOJO.pca["comment-extremity"],
    // The math_tick the route puts in the ETag.
    etag_math_tick: item.asPOJO.math_tick,
    asJSON_sha256: sha256(item.asJSON),
    asJSON_bytes: Buffer.byteLength(item.asJSON, "utf-8"),
    // Exactly what pca2 sends as the response body.
    gzip_sha256: sha256(item.asBufferOfGzippedJson),
    gzip_bytes: item.asBufferOfGzippedJson.length,
    keys_projection_sha256: sha256(projection),
    tids: item.asPOJO.tids,
    n: item.asPOJO.n,
    // The server's synthesized empty presentation stamps Date.now() here
    // (pca.ts createEmptyPcaStructure), so it is reported rather than assumed.
    last_vote_timestamp: item.asPOJO.lastVoteTimestamp,
    repness_keys: Object.keys(item.repness || {}).sort(),
    consensus_shape: {
      agree: (item.consensus && item.consensus.agree && item.consensus.agree.length) || 0,
      disagree: (item.consensus && item.consensus.disagree && item.consensus.disagree.length) || 0,
    },
    mapping_is_error: mapping instanceof Error,
    mapping_sha256: mapping instanceof Error ? null : sha256(JSON.stringify(mapping)),
    mapping_math_tick: mapping instanceof Error ? null : mapping.math_tick,
    bid_to_pid: mapping instanceof Error ? null : mapping.bidToPid,
    pids_for_gid: joins,
  };
}

async function main() {
  const spec = JSON.parse(process.argv[2]);
  const out = { zid: spec.zid, namespaces: [] };
  for (const mathEnv of spec.envs) {
    out.namespaces.push(await readNamespace(spec.zid, mathEnv, spec.keys || [], spec.gids || []));
  }
  process.stdout.write(JSON.stringify(out));
}

main().then(
  () => process.exit(0),
  (error) => {
    process.stderr.write(String((error && error.stack) || error) + "\n");
    process.exit(1);
  }
);
