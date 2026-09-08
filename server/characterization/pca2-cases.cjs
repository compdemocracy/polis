"use strict";
const fixtures = require("./pca2-fixtures.json");
const { hash } = require("./core.cjs");
function pca2Cases(seed = "p027-v1") {
  const cases = [];
  for (const f of fixtures) {
    const add = (name, query = {}, headers = {}, body = null) => {
      const caseId = `r5/${f.auth}/pca2/f${f.zid}/env-${f.mathEnv}/row-${
        f.rowMathEnv || "none"
      }/tick-${f.mathTick}/${name}`;
      cases.push({
        caseId,
        routeId: 5,
        auth: f.auth,
        case: name,
        seed: hash(`${seed}/${caseId}`).slice(0, 12),
        request: {
          method: "GET",
          path: "/api/v3/math/pca2",
          query: { conversation_id: f.capability, ...query },
          headers: {
            accept: "application/json",
            "x-forwarded-proto": "https",
            ...(f.auth === "unauthenticated"
              ? {}
              : {
                  authorization: `$auth:${
                    f.auth === "participant" ? `participant-${f.zid}` : f.auth
                  }`,
                }),
            ...(body === null ? {} : { "content-type": "application/json" }),
            ...headers,
          },
          body,
        },
      });
    };
    if (f.shape === "not-ready") {
      // First access has no scoped row and no existence-cache entry. Second is warm.
      add("not-ready-cold", { math_tick: 0 });
      add("not-ready-warm", { math_tick: 0 });
      add("not-ready-latest");
    } else if (f.shape === "foreign") {
      // The participant credential belongs to the actor's populated conversation.
      add("cross-capability");
      if (f.auth === "participant")
        cases.at(-1).request.headers.authorization = `$auth:participant-${
          f.zid - 3
        }`;
      add("malformed-capability", { conversation_id: `!invalid-${f.zid}` });
      add("missing-capability", { conversation_id: `2p027missing${f.zid}` });
    } else {
      add(f.shape);
      if (f.shape !== "populated") continue;
      for (const [name, etag] of [
        ["equal", '"1"'],
        ["older", '"0"'],
        ["newer", '"2"'],
        ["weak", 'W/"1"'],
        ["weak-lower", 'w/"1"'],
        ["list", '"2", W/"0"'],
        ["star", "*"],
      ])
        add(`conditional-${name}`, {}, { "if-none-match": etag });
      add("conditional-conflict", { math_tick: 0 }, { "if-none-match": '"1"' });
      for (const [name, keys] of [
        ["pair", "tids,n-cmts"],
        ["reverse", "n-cmts,tids"],
        ["duplicate", "tids,tids,n-cmts"],
        ["unknown", "tids,unknown"],
        ["empty", ""],
        ["prototype", "__proto__,constructor,toString,tids"],
        ["integer", "0,1,tids"],
      ])
        add(`keys-${name}`, { keys });
      add("keys-array", {}, {}, { keys: ["tids", "n-cmts"] });
      add("keys-empty-array", {}, {}, { keys: [] });
      // Large selection exceeds the installed compression middleware threshold.
      add(
        "keys-gzip",
        {
          keys: "tids,n-cmts,pca,base-clusters,group-clusters,repness,votes-base,comment-priorities,group-votes",
        },
        { "accept-encoding": "gzip" }
      );
      add(
        "keys-small-gzip",
        { keys: "tids,n-cmts" },
        { "accept-encoding": "gzip" }
      );
    }
  }
  return cases;
}
module.exports = { pca2Cases };
if (require.main === module)
  console.log(
    pca2Cases()
      .map((c) => c.caseId)
      .join(",")
  );
