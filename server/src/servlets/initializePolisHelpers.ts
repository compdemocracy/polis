function initializePolisHelpers() {
  const polisTypes = Utils.polisTypes;
  const setCookie = cookies.setCookie;
  const setParentReferrerCookie = cookies.setParentReferrerCookie;
  const setParentUrlCookie = cookies.setParentUrlCookie;
  const setPlanCookie = cookies.setPlanCookie;
  const setPermanentCookie = cookies.setPermanentCookie;
  const setCookieTestCookie = cookies.setCookieTestCookie;
  const shouldSetCookieOnPolisDomain = cookies.shouldSetCookieOnPolisDomain;
  const addCookies = cookies.addCookies;
  const getPermanentCookieAndEnsureItIsSet =
    cookies.getPermanentCookieAndEnsureItIsSet;

  const pidCache = User.pidCache;
  const getPid = User.getPid;
  const getPidPromise = User.getPidPromise;
  const getPidForParticipant = User.getPidForParticipant;

  function recordPermanentCookieZidJoin(permanentCookieToken: any, zid: any) {
    function doInsert() {
      return pgQueryP(
        "insert into permanentCookieZidJoins (cookie, zid) values ($1, $2);",
        [permanentCookieToken, zid]
      );
    }
    return pgQueryP(
      "select zid from permanentCookieZidJoins where cookie = ($1) and zid = ($2);",
      [permanentCookieToken, zid]
    ).then(
      function (rows: string | any[]) {
        if (rows && rows.length) {
          // already there
        } else {
          return doInsert();
        }
      },
      function (err: any) {
        console.error(err);
        // hmm, weird, try inserting anyway
        return doInsert();
      }
    );
  }

  const detectLanguage = Comment.detectLanguage;

  if (Config.backfillCommentLangDetection) {
    pgQueryP("select tid, txt, zid from comments where lang is null;", []).then(
      (comments: string | any[]) => {
        let i = 0;
        function doNext() {
          if (i < comments.length) {
            const c = comments[i];
            i += 1;
            detectLanguage(c.txt).then((x: DetectLanguageResult[]) => {
              const firstResult = x[0];
              console.log("backfill", firstResult.language + "\t\t" + c.txt);
              pgQueryP(
                "update comments set lang = ($1), lang_confidence = ($2) where zid = ($3) and tid = ($4)",
                [firstResult.language, firstResult.confidence, c.zid, c.tid]
              ).then(() => {
                doNext();
              });
            });
          }
        }
        doNext();
      }
    );
  }

  function doVotesPost(
    uid?: any,
    pid?: any,
    conv?: { zid: any },
    tid?: any,
    voteType?: any,
    weight?: number,
    shouldNotify?: any
  ) {
    const zid = conv?.zid;
    weight = weight || 0;
    // weight is stored as a SMALLINT, so convert from a [-1,1] float to [-32767,32767] int
    const weight_x_32767 = Math.trunc(weight * 32767);
    return new Promise(function (
      resolve: (arg0: { conv: any; vote: any }) => void,
      reject: (arg0: string) => void
    ) {
      const query =
        "INSERT INTO votes (pid, zid, tid, vote, weight_x_32767, created) VALUES ($1, $2, $3, $4, $5, default) RETURNING *;";
      const params = [pid, zid, tid, voteType, weight_x_32767];
      pgQuery(query, params, function (err: any, result: { rows: any[] }) {
        if (err) {
          if (isDuplicateKey(err)) {
            reject("polis_err_vote_duplicate");
          } else {
            console.dir(err);
            reject("polis_err_vote_other");
          }
          return;
        }

        const vote = result.rows[0];

        resolve({
          conv: conv,
          vote: vote,
        });
      });
    });
  }

  function votesPost(
    uid?: any,
    pid?: any,
    zid?: any,
    tid?: any,
    voteType?: any,
    weight?: number,
    shouldNotify?: boolean
  ) {
    return (
      pgQueryP_readOnly("select * from conversations where zid = ($1);", [zid])
        .then(function (rows: string | any[]) {
          if (!rows || !rows.length) {
            throw "polis_err_unknown_conversation";
          }
          const conv = rows[0];
          if (!conv.is_active) {
            throw "polis_err_conversation_is_closed";
          }
          if (conv.auth_needed_to_vote) {
            return isModerator(zid, uid).then((is_mod: any) => {
              if (is_mod) {
                return conv;
              }
              return Promise.all([
                pgQueryP(
                  "select * from xids where owner = ($1) and uid = ($2);",
                  [conv.owner, uid]
                ),
                getSocialInfoForUsers([uid], zid),
              ]).then(([xids, info]) => {
                const socialAccountIsLinked = info.length > 0;
                const hasXid = xids.length > 0;
                if (socialAccountIsLinked || hasXid) {
                  return conv;
                } else {
                  throw "polis_err_post_votes_social_needed";
                }
              });
            });
          }
          return conv;
        })
        .then(function (conv: any) {
          return doVotesPost(
            uid,
            pid,
            conv,
            tid,
            voteType,
            weight,
            shouldNotify
          );
        })
    );
  }
  function getVotesForSingleParticipant(p: { pid: any }) {
    if (_.isUndefined(p.pid)) {
      return Promise.resolve([]);
    }
    return votesGet(p);
  }

  function votesGet(p: { zid?: any; pid?: any; tid?: any }) {
    return new MPromise(
      "votesGet",
      function (resolve: (arg0: any) => void, reject: (arg0: any) => void) {
        let q = sql_votes_latest_unique
          .select(sql_votes_latest_unique.star())
          .where(sql_votes_latest_unique.zid.equals(p.zid));

        if (!_.isUndefined(p.pid)) {
          q = q.where(sql_votes_latest_unique.pid.equals(p.pid));
        }
        if (!_.isUndefined(p.tid)) {
          q = q.where(sql_votes_latest_unique.tid.equals(p.tid));
        }
        pgQuery_readOnly(
          q.toString(),
          function (err: any, results: { rows: any }) {
            if (err) {
              reject(err);
            } else {
              resolve(results.rows);
            }
          }
        );
      }
    );
  }

  function writeDefaultHead(
    req: any,
    res: {
      set: (arg0: {
        "Content-Type": string;
        "Cache-Control": string;
        Connection: string;
      }) => void;
    },
    next: () => void
  ) {
    res.set({
      "Content-Type": "application/json",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    });
    next();
  }

  function redirectIfNotHttps(
    req: { headers?: { [x: string]: string; host: string }; url: string },
    res: {
      writeHead: (arg0: number, arg1: { Location: string }) => void;
      end: () => any;
    },
    next: () => any
  ) {
    const exempt = devMode;

    if (exempt) {
      return next();
    }

    const isHttps = req?.headers?.["x-forwarded-proto"] === "https";

    if (!isHttps) {
      // assuming we're running on Heroku, where we're behind a proxy.
      res.writeHead(302, {
        Location: "https://" + req?.headers?.host + req.url,
      });
      return res.end();
    }
    return next();
  }

  function redirectIfWrongDomain(
    req: { headers?: { host: string }; url: string },
    res: {
      writeHead: (arg0: number, arg1: { Location: string }) => void;
      end: () => any;
    },
    next: () => any
  ) {
    if (
      /www.pol.is/.test(req?.headers?.host || "")
    ) {
      res.writeHead(302, {
        Location: serverUrl + req.url,
      });
      return res.end();
    }
    return next();
  }

  function redirectIfApiDomain(
    req: { headers?: { host: string }; url: string },
    res: {
      writeHead: (arg0: number, arg1: { Location: string }) => void;
      end: () => any;
    },
    next: () => any
  ) {
    if (/api.pol.is/.test(req?.headers?.host || "")) {
      if (req.url === "/" || req.url === "") {
        res.writeHead(302, {
          Location: "https://pol.is/docs/api",
        });
        return res.end();
      } else if (!req.url.match(/^\/?api/)) {
        res.writeHead(302, {
          Location: "https://pol.is/" + req.url,
        });
        return res.end();
      }
    }
    return next();
  }

  function doXidConversationIdAuth(
    assigner: (arg0: any, arg1: string, arg2: number) => void,
    xid: any,
    conversation_id: any,
    isOptional: any,
    req: AuthRequest,
    res: { status: (arg0: number) => void },
    onDone: { (err: any): void; (arg0?: string): void }
  ) {
    return getConversationInfoByConversationId(conversation_id)
      .then((conv: { org_id: any; zid: any }) => {
        return getXidRecordByXidOwnerId(
          xid,
          conv.org_id,
          conv.zid,
          req.body.x_profile_image_url || req?.query?.x_profile_image_url,
          req.body.x_name || req?.query?.x_name || null,
          req.body.x_email || req?.query?.x_email || null,
          !!req.body.agid || !!req?.query?.agid || null
        ).then((rows: string | any[]) => {
          if (!rows || !rows.length) {
            if (isOptional) {
              return onDone();
            } else {
              res.status(403);
              onDone("polis_err_auth_no_such_xid_for_this_apikey_11");
              return;
            }
          }
          const uidForCurrentUser = Number(rows[0].uid);
          assigner(req, "uid", uidForCurrentUser);
          onDone();
        });
      })
      .catch((err: any) => {
        console.log(err);
        onDone(err);
      });
  }

  function _auth(assigner: any, isOptional: boolean) {
    function getKey(
      req: {
        body: Body;
        headers?: Headers;
        query?: Query;
      },
      key: string
    ) {
      return req.body[key] || req?.headers?.[key] || req?.query?.[key];
    }

    function doAuth(
      req: {
        cookies: { [x: string]: any };
        headers?: { [x: string]: any; authorization: any };
        p: { uid?: any };
        body: Body;
      },
      res: { status: (arg0: number) => void }
    ) {
      //var token = req.body.token;
      const token = req.cookies[COOKIES.TOKEN];
      const xPolisToken = req?.headers?.["x-polis"];

      return new Promise(function (
        resolve: (arg0: any) => void,
        reject: (arg0: string) => void
      ) {
        function onDone(err?: string) {
          if (err) {
            reject(err);
          }
          if ((!req.p || !req.p.uid) && !isOptional) {
            reject("polis_err_mandatory_auth_unsuccessful");
          }
          resolve(req.p && req.p.uid);
        }
        if (xPolisToken && isPolisLtiToken(xPolisToken)) {
          console.log("authtype", "doPolisLtiTokenHeaderAuth");
          doPolisLtiTokenHeaderAuth(assigner, isOptional, req, res, onDone);
        } else if (xPolisToken) {
          console.log("authtype", "doHeaderAuth");
          doHeaderAuth(assigner, isOptional, req, res, onDone);
        } else if (getKey(req, "polisApiKey") && getKey(req, "ownerXid")) {
          console.log("authtype", "doXidApiKeyAuth");
          doXidApiKeyAuth(
            assigner,
            getKey(req, "polisApiKey"),
            getKey(req, "ownerXid"),
            isOptional,
            req,
            res,
            onDone
          );
        } else if (getKey(req, "polisApiKey") && getKey(req, "xid")) {
          console.log("authtype", "doXidApiKeyAuth");
          doXidApiKeyAuth(
            assigner,
            getKey(req, "polisApiKey"),
            getKey(req, "xid"),
            isOptional,
            req,
            res,
            onDone
          );
        } else if (getKey(req, "xid") && getKey(req, "conversation_id")) {
          console.log("authtype", "doXidConversationIdAuth");
          doXidConversationIdAuth(
            assigner,
            getKey(req, "xid"),
            getKey(req, "conversation_id"),
            isOptional,
            req,
            res,
            onDone
          );
        } else if (req?.headers?.["x-sandstorm-app-polis-apikey"]) {
          console.log("authtype", "doApiKeyAuth");
          doApiKeyAuth(
            assigner,
            req?.headers?.["x-sandstorm-app-polis-apikey"],
            isOptional,
            req,
            res,
            onDone
          );
        } else if (req.body["polisApiKey"]) {
          console.log("authtype", "doApiKeyAuth");
          doApiKeyAuth(
            assigner,
            getKey(req, "polisApiKey"),
            isOptional,
            req,
            res,
            onDone
          );
        } else if (token) {
          console.log("authtype", "doCookieAuth");
          doCookieAuth(assigner, isOptional, req, res, onDone);
        } else if (req?.headers?.authorization) {
          console.log("authtype", "doApiKeyBasicAuth");
          doApiKeyBasicAuth(
            assigner,
            req.headers.authorization,
            isOptional,
            req,
            res,
            onDone
          );
        } else if (req.body.agid) {
          // Auto Gen user  ID
          console.log("authtype", "no auth but agid");
          createDummyUser()
            .then(
              function (uid?: any) {
                const shouldAddCookies = _.isUndefined(req.body.xid);
                if (!shouldAddCookies) {
                  req.p = req.p || {};
                  req.p.uid = uid;
                  return onDone();
                }
                return startSessionAndAddCookies(req, res, uid).then(
                  function () {
                    req.p = req.p || {};
                    req.p.uid = uid;
                    onDone();
                  },
                  function (err: any) {
                    res.status(500);
                    console.error(err);
                    onDone("polis_err_auth_token_error_2343");
                  }
                );
              },
              function (err: any) {
                res.status(500);
                console.error(err);
                onDone("polis_err_auth_token_error_1241");
              }
            )
            .catch(function (err: any) {
              res.status(500);
              console.error(err);
              onDone("polis_err_auth_token_error_5345");
            });
        } else if (isOptional) {
          onDone(); // didn't create user
        } else {
          res.status(401);
          onDone("polis_err_auth_token_not_supplied");
        }
      });
    }
    return function (
      req: any,
      res: { status: (arg0: number) => void },
      next: (arg0?: undefined) => void
    ) {
      doAuth(req, res)
        .then(() => {
          return next();
        })
        .catch((err: any) => {
          res.status(500);
          console.error(err);
          next(err || "polis_err_auth_error_432");
        });
    };
  }

  // input token from body or query, and populate req.body.u with userid.
  function authOptional(assigner: any) {
    return _auth(assigner, true);
  }

  function auth(assigner: any) {
    return _auth(assigner, false);
  }

  function enableAgid(req: { body: Body }, res: any, next: () => void) {
    req.body.agid = 1;
    next();
  }

  const whitelistedCrossDomainRoutes = [
    /^\/api\/v[0-9]+\/launchPrep/,
    /^\/api\/v[0-9]+\/setFirstCookie/,
  ];

  const whitelistedDomains = [
    Config.getServerHostname(),
    ...Config.whitelistItems,
    "localhost:5000",
    "localhost:5001",
    "localhost:5002",
    "canvas.instructure.com", // LTI
    "canvas.uw.edu", // LTI
    "canvas.shoreline.edu", // LTI
    "shoreline.instructure.com", // LTI
    "facebook.com",
    "api.twitter.com",
    "connect.stripe.com",
    "", // for API
  ];

  const whitelistedBuckets = {
    "pol.is": "pol.is",
    "embed.pol.is": "pol.is",
    "survey.pol.is": "survey.pol.is",
    "preprod.pol.is": "preprod.pol.is",
  };

  function hasWhitelistMatches(host: string) {
    let hostWithoutProtocol = host;
    if (host.startsWith("http://")) {
      hostWithoutProtocol = host.slice(7);
    } else if (host.startsWith("https://")) {
      hostWithoutProtocol = host.slice(8);
    }

    for (let i = 0; i < whitelistedDomains.length; i++) {
      const w = whitelistedDomains[i];
      if (hostWithoutProtocol.endsWith(w || "")) {
        // ok, the ending matches, now we need to make sure it's the same, or a subdomain.
        if (hostWithoutProtocol === w) {
          return true;
        }
        if (
          hostWithoutProtocol[
            hostWithoutProtocol.length - ((w || "").length + 1)
          ] === "."
        ) {
          // separated by a dot, so it's a subdomain.
          return true;
        }
      }
    }
    return false;
  }

  function addCorsHeader(
    req: {
      protocol: string;
      get: (arg0: string) => any;
      path: any;
      headers: Headers;
    },
    res: { header: (arg0: string, arg1: string | boolean) => void },
    next: (arg0?: string) => any
  ) {
    let host = "";
    if (domainOverride) {
      host = req.protocol + "://" + domainOverride;
    } else {
      // TODO does it make sense for this middleware to look
      // at origin || referer? is Origin for CORS preflight?
      // or for everything?
      // Origin was missing from FF, so added Referer.
      host = req.get("Origin") || req.get("Referer") || "";
    }

    // Somehow the fragment identifier is being sent by IE10????
    // Remove unexpected fragment identifier
    host = host.replace(/#.*$/, "");

    // Remove characters starting with the first slash following the double slash at the beginning.
    const result = /^[^\/]*\/\/[^\/]*/.exec(host);
    if (result && result[0]) {
      host = result[0];
    }
    // check if the route is on a special list that allows it to be called cross domain (by polisHost.js for example)
    const routeIsWhitelistedForAnyDomain = _.some(
      whitelistedCrossDomainRoutes,
      function (regex: { test: (arg0: any) => any }) {
        return regex.test(req.path);
      }
    );

    if (
      !domainOverride &&
      !hasWhitelistMatches(host) &&
      !routeIsWhitelistedForAnyDomain
    ) {
      winston.log("info", "not whitelisted");
      winston.log("info", req.headers);
      winston.log("info", req.path);
      return next("unauthorized domain: " + host);
    }
    if (host === "") {
      // API
    } else {
      res.header("Access-Control-Allow-Origin", host);
      res.header(
        "Access-Control-Allow-Headers",
        "Cache-Control, Pragma, Origin, Authorization, Content-Type, X-Requested-With"
      );
      res.header(
        "Access-Control-Allow-Methods",
        "GET, PUT, POST, DELETE, OPTIONS"
      );
      res.header("Access-Control-Allow-Credentials", true);
    }
    return next();
  }

  ////////////////////////////////////////////
  ////////////////////////////////////////////
  ////////////////////////////////////////////
  ////////////////////////////////////////////
  ////////////////////////////////////////////
  ////////////////////////////////////////////
  //
  //             BEGIN ROUTES
  //
  ////////////////////////////////////////////
  ////////////////////////////////////////////
  ////////////////////////////////////////////
  ////////////////////////////////////////////
  ////////////////////////////////////////////
  ////////////////////////////////////////////

  const strToHex = Utils.strToHex;
  const hexToStr = Utils.hexToStr;

  function handle_GET_launchPrep(
    req: {
      headers?: { origin: string };
      cookies: { [x: string]: any };
      p: { dest: any };
    },
    res: { redirect: (arg0: any) => void }
  ) {
    let setOnPolisDomain = !domainOverride;
    const origin = req?.headers?.origin || "";
    if (setOnPolisDomain && origin.match(/^http:\/\/localhost:[0-9]{4}/)) {
      setOnPolisDomain = false;
    }

    if (!req.cookies[COOKIES.PERMANENT_COOKIE]) {
      setPermanentCookie(req, res, setOnPolisDomain, makeSessionToken());
    }
    setCookieTestCookie(req, res, setOnPolisDomain);

    setCookie(req, res, setOnPolisDomain, "top", "ok", {
      httpOnly: false, // not httpOnly - needed by JS
    });

    // using hex since it doesn't require escaping like base64.
    const dest = hexToStr(req.p.dest);
    res.redirect(dest);
  }

  function handle_GET_tryCookie(
    req: { headers?: { origin: string }; cookies: { [x: string]: any } },
    res: {
      status: (
        arg0: number
      ) => { (): any; new (): any; json: { (arg0: {}): void; new (): any } };
    }
  ) {
    let setOnPolisDomain = !domainOverride;
    const origin = req?.headers?.origin || "";
    if (setOnPolisDomain && origin.match(/^http:\/\/localhost:[0-9]{4}/)) {
      setOnPolisDomain = false;
    }

    if (!req.cookies[COOKIES.TRY_COOKIE]) {
      setCookie(req, res, setOnPolisDomain, COOKIES.TRY_COOKIE, "ok", {
        httpOnly: false, // not httpOnly - needed by JS
      });
    }
    res.status(200).json({});
  }

  const pcaCacheSize = Config.cacheMathResults ? 300 : 1;
  const pcaCache = new LruCache({
    max: pcaCacheSize,
  });

  const lastPrefetchedMathTick = -1;

  function processMathObject(o: { [x: string]: any }) {
    function remapSubgroupStuff(g: { val: any[] }) {
      if (_.isArray(g.val)) {
        g.val = g.val.map((x: { id: number }) => {
          return { id: Number(x.id), val: x };
        });
      } else {
        g.val = _.keys(g.val).map((id: number) => {
          return { id: Number(id), val: g.val[id] };
        });
      }
      return g;
    }

    // Normalize so everything is arrays of objects (group-clusters is already in this format,
    // but needs to have the val: subobject style too).

    if (_.isArray(o["group-clusters"])) {
      // NOTE this is different since group-clusters is already an array.
      o["group-clusters"] = o["group-clusters"].map((g: { id: any }) => {
        return { id: Number(g.id), val: g };
      });
    }

    if (!_.isArray(o["repness"])) {
      o["repness"] = _.keys(o["repness"]).map((gid: string | number) => {
        return { id: Number(gid), val: o["repness"][gid] };
      });
    }
    if (!_.isArray(o["group-votes"])) {
      o["group-votes"] = _.keys(o["group-votes"]).map(
        (gid: string | number) => {
          return { id: Number(gid), val: o["group-votes"][gid] };
        }
      );
    }
    if (!_.isArray(o["subgroup-repness"])) {
      o["subgroup-repness"] = _.keys(o["subgroup-repness"]).map(
        (gid: string | number) => {
          return { id: Number(gid), val: o["subgroup-repness"][gid] };
        }
      );
      o["subgroup-repness"].map(remapSubgroupStuff);
    }
    if (!_.isArray(o["subgroup-votes"])) {
      o["subgroup-votes"] = _.keys(o["subgroup-votes"]).map(
        (gid: string | number) => {
          return { id: Number(gid), val: o["subgroup-votes"][gid] };
        }
      );
      o["subgroup-votes"].map(remapSubgroupStuff);
    }
    if (!_.isArray(o["subgroup-clusters"])) {
      o["subgroup-clusters"] = _.keys(o["subgroup-clusters"]).map(
        (gid: string | number) => {
          return { id: Number(gid), val: o["subgroup-clusters"][gid] };
        }
      );
      o["subgroup-clusters"].map(remapSubgroupStuff);
    }

    // Edge case where there are two groups and one is huge, split the large group.
    // Once we have a better story for h-clust in the participation view, then we can just show the h-clust instead.
    // var groupVotes = o['group-votes'];
    // if (_.keys(groupVotes).length === 2 && o['subgroup-votes'] && o['subgroup-clusters'] && o['subgroup-repness']) {
    //   var s0 = groupVotes[0].val['n-members'];
    //   var s1 = groupVotes[1].val['n-members'];
    //   const scaleRatio = 1.1;
    //   if (s1 * scaleRatio < s0) {
    //     console.log('splitting 0', s0, s1, s1*scaleRatio);
    //     o = splitTopLevelGroup(o, groupVotes[0].id);
    //   } else if (s0 * scaleRatio < s1) {
    //     console.log('splitting 1', s0, s1, s0*scaleRatio);
    //     o = splitTopLevelGroup(o, groupVotes[1].id);
    //   }
    // }

    // // Gaps in the gids are not what we want to show users, and they make client development difficult.
    // // So this guarantees that the gids are contiguous. TODO look into Darwin.
    // o = packGids(o);

    // Un-normalize to maintain API consistency.
    // This could removed in a future API version.
    function toObj(a: string | any[]) {
      const obj = {};
      if (!a) {
        return obj;
      }
      for (let i = 0; i < a.length; i++) {
        obj[a[i].id] = a[i].val;
        obj[a[i].id].id = a[i].id;
      }
      return obj;
    }
    function toArray(a: any[]) {
      if (!a) {
        return [];
      }
      return a.map((g: { id: any; val: any }) => {
        const id = g.id;
        g = g.val;
        g.id = id;
        return g;
      });
    }
    o["repness"] = toObj(o["repness"]);
    o["group-votes"] = toObj(o["group-votes"]);
    o["group-clusters"] = toArray(o["group-clusters"]);

    delete o["subgroup-repness"];
    delete o["subgroup-votes"];
    delete o["subgroup-clusters"];
    return o;
  }

  function getPca(zid?: any, math_tick?: number) {
    let cached = pcaCache.get(zid);
    if (cached && cached.expiration < Date.now()) {
      cached = null;
    }
    const cachedPOJO = cached && cached.asPOJO;
    if (cachedPOJO) {
      if (cachedPOJO.math_tick <= (math_tick || 0)) {
        INFO(
          "mathpoll related",
          "math was cached but not new: zid=",
          zid,
          "cached math_tick=",
          cachedPOJO.math_tick,
          "query math_tick=",
          math_tick
        );
        return Promise.resolve(null);
      } else {
        INFO("mathpoll related", "math from cache", zid, math_tick);
        return Promise.resolve(cached);
      }
    }

    INFO("mathpoll cache miss", zid, math_tick);

    // NOTE: not caching results from this query for now, think about this later.
    // not caching these means that conversations without new votes might not be cached.
    // (closed conversations may be slower to load)
    // It's probably not difficult to cache, but keeping things simple for now, and only caching things that come down
    // with the poll.

    const queryStart = Date.now();

    return pgQueryP_readOnly(
      "select * from math_main where zid = ($1) and math_env = ($2);",
      [zid, Config.mathEnv]
    ).then((rows: string | any[]) => {
      const queryEnd = Date.now();
      const queryDuration = queryEnd - queryStart;
      addInRamMetric("pcaGetQuery", queryDuration);

      if (!rows || !rows.length) {
        INFO("mathpoll related; after cache miss, unable to find data for", {
          zid,
          math_tick,
          math_env: Config.mathEnv,
        });
        return null;
      }
      const item = rows[0].data;

      if (rows[0].math_tick) {
        item.math_tick = Number(rows[0].math_tick);
      }

      if (item.math_tick <= (math_tick || 0)) {
        INFO(
          "mathpoll related",
          "after cache miss, unable to find newer item",
          zid,
          math_tick
        );
        return null;
      }
      INFO(
        "mathpoll related",
        "after cache miss, found item, adding to cache",
        zid,
        math_tick
      );

      processMathObject(item);

      return updatePcaCache(zid, item).then(
        function (o: any) {
          return o;
        },
        function (err: any) {
          return err;
        }
      );
    });
  }

  function updatePcaCache(zid: any, item: { zid: any }) {
    return new Promise(function (
      resolve: (arg0: {
        asPOJO: any;
        asJSON: string;
        asBufferOfGzippedJson: any;
        expiration: number;
      }) => void,
      reject: (arg0: any) => any
    ) {
      delete item.zid; // don't leak zid
      const asJSON = JSON.stringify(item);
      const buf = new Buffer(asJSON, "utf-8");
      zlib.gzip(buf, function (err: any, jsondGzipdPcaBuffer: any) {
        if (err) {
          return reject(err);
        }

        const o = {
          asPOJO: item,
          asJSON: asJSON,
          asBufferOfGzippedJson: jsondGzipdPcaBuffer,
          expiration: Date.now() + 3000,
        };
        // save in LRU cache, but don't update the lastPrefetchedMathTick
        pcaCache.set(zid, o);
        resolve(o);
      });
    });
  }

  function redirectIfHasZidButNoConversationId(
    req: { body: { zid: any; conversation_id: any } },
    res: {
      writeHead: (arg0: number, arg1: { Location: string }) => void;
      end: () => any;
    },
    next: () => any
  ) {
    if (req.body.zid && !req.body.conversation_id) {
      winston.log("info", "redirecting old zid user to about page");
      res.writeHead(302, {
        Location: "https://pol.is/about",
      });
      return res.end();
    }
    return next();
  }

  function handle_GET_math_pca(
    req: any,
    res: {
      status: (
        arg0: number
      ) => { (): any; new (): any; end: { (): void; new (): any } };
    }
  ) {
    // migrated off this path, old clients were causing timeout issues by polling repeatedly without waiting for a
    // result for a previous poll.
    res.status(304).end();
  }

  // Cache the knowledge of whether there are any pca results for a given zid.
  // Needed to determine whether to return a 404 or a 304.
  // zid -> boolean
  const pcaResultsExistForZid = {};
  function handle_GET_math_pca2(
    req: { p: { zid: any; math_tick: any; ifNoneMatch: any } },
    res: {
      status: (
        arg0: number
      ) => { (): any; new (): any; end: { (): void; new (): any } };
      set: (arg0: {
        "Content-Type": string;
        "Content-Encoding": string;
        Etag: string;
      }) => void;
      send: (arg0: any) => void;
    }
  ) {
    const zid = req.p.zid;
    let math_tick = req.p.math_tick;

    const ifNoneMatch = req.p.ifNoneMatch;
    if (ifNoneMatch) {
      if (!_.isUndefined(math_tick)) {
        return fail(
          res,
          400,
          "Expected either math_tick param or If-Not-Match header, but not both."
        );
      }
      if (ifNoneMatch.includes("*")) {
        math_tick = 0;
      } else {
        const entries = ifNoneMatch.split(/ *, */).map((x: string) => {
          return Number(
            x
              .replace(/^[wW]\//, "")
              .replace(/^"/, "")
              .replace(/"$/, "")
          );
        });
        // supporting multiple values for the ifNoneMatch header doesn't really make sense, so I've arbitrarily
        // chosen _.min to decide on one.
        math_tick = _.min(entries);
      }
    } else if (_.isUndefined(math_tick)) {
      math_tick = -1;
    }
    function finishWith304or404() {
      if (pcaResultsExistForZid[zid]) {
        res.status(304).end();
      } else {
        res.status(404).end();
      }
    }

    getPca(zid, math_tick)
      .then(function (data: {
        asPOJO: { math_tick: string };
        asBufferOfGzippedJson: any;
      }) {
        if (data) {
          // The buffer is gzipped beforehand to cut down on server effort in re-gzipping the same json string for each response.
          // We can't cache this endpoint on Cloudflare because the response changes too freqently, so it seems like the best way
          // is to cache the gzipped json'd buffer here on the server.
          res.set({
            "Content-Type": "application/json",
            "Content-Encoding": "gzip",
            Etag: '"' + data.asPOJO.math_tick + '"',
          });
          res.send(data.asBufferOfGzippedJson);
        } else {
          // check whether we should return a 304 or a 404
          if (_.isUndefined(pcaResultsExistForZid[zid])) {
            // This server doesn't know yet if there are any PCA results in the DB
            // So try querying from -1
            return getPca(zid, -1).then(function (data: any) {
              const exists = !!data;
              pcaResultsExistForZid[zid] = exists;
              finishWith304or404();
            });
          } else {
            finishWith304or404();
          }
        }
      })
      .catch(function (err: any) {
        fail(res, 500, err);
      });
  }

  function getZidForRid(rid: any) {
    return pgQueryP("select zid from reports where rid = ($1);", [rid]).then(
      (row: string | any[]) => {
        if (!row || !row.length) {
          return null;
        }
        return row[0].zid;
      }
    );
  }

  function handle_POST_math_update(
    req: { p: { zid: any; uid?: any; math_update_type: any } },
    res: {
      status: (
        arg0: number
      ) => { (): any; new (): any; json: { (arg0: {}): void; new (): any } };
    }
  ) {
    const zid = req.p.zid;
    const uid = req.p.uid;
    const math_env = Config.mathEnv;
    const math_update_type = req.p.math_update_type;

    isModerator(zid, uid).then((hasPermission: any) => {
      if (!hasPermission) {
        return fail(res, 500, "handle_POST_math_update_permission");
      }
      return pgQueryP(
        "insert into worker_tasks (task_type, task_data, task_bucket, math_env) values ('update_math', $1, $2, $3);",
        [
          JSON.stringify({
            zid: zid,
            math_update_type: math_update_type,
          }),
          zid,
          math_env,
        ]
      )
        .then(() => {
          res.status(200).json({});
        })
        .catch((err: any) => {
          return fail(res, 500, "polis_err_POST_math_update", err);
        });
    });
  }

  function handle_GET_math_correlationMatrix(
    req: { p: { rid: any; math_tick: any } },
    res: {
      status: (
        arg0: number
      ) => {
        (): any;
        new (): any;
        json: { (arg0: { status: string }): void; new (): any };
      };
      json: (arg0: any) => void;
    }
  ) {
    const rid = req.p.rid;
    const math_env = Config.mathEnv;
    const math_tick = req.p.math_tick;

    console.log(req.p);
    function finishAsPending() {
      res.status(202).json({
        status: "pending",
      });
    }

    function hasCommentSelections() {
      return pgQueryP(
        "select * from report_comment_selections where rid = ($1) and selection = 1;",
        [rid]
      ).then((rows: string | any[]) => {
        return rows.length > 0;
      });
    }

    const requestExistsPromise = pgQueryP(
      "select * from worker_tasks where task_type = 'generate_report_data' and math_env=($2) " +
        "and task_bucket = ($1) " +
        // "and attempts < 3 " +
        "and (task_data->>'math_tick')::int >= ($3) " +
        "and finished_time is NULL;",
      [rid, math_env, math_tick]
    );

    const resultExistsPromise = pgQueryP(
      "select * from math_report_correlationmatrix where rid = ($1) and math_env = ($2) and math_tick >= ($3);",
      [rid, math_env, math_tick]
    );

    Promise.all([resultExistsPromise, getZidForRid(rid)])
      .then((a: any[]) => {
        const rows = a[0];
        const zid = a[1];
        if (!rows || !rows.length) {
          return requestExistsPromise.then((requests_rows: string | any[]) => {
            const shouldAddTask = !requests_rows || !requests_rows.length;

            if (shouldAddTask) {
              return hasCommentSelections().then((hasSelections: any) => {
                if (!hasSelections) {
                  return res.status(202).json({
                    status: "polis_report_needs_comment_selection",
                  });
                }
                return pgQueryP(
                  "insert into worker_tasks (task_type, task_data, task_bucket, math_env) values ('generate_report_data', $1, $2, $3);",
                  [
                    JSON.stringify({
                      rid: rid,
                      zid: zid,
                      math_tick: math_tick,
                    }),
                    rid,
                    math_env,
                  ]
                ).then(finishAsPending);
              });
            }
            finishAsPending();
          });
        }
        res.json(rows[0].data);
      })
      .catch((err: any) => {
        return fail(res, 500, "polis_err_GET_math_correlationMatrix", err);
      });
  }

  function doAddDataExportTask(
    math_env: string | undefined,
    email: string,
    zid: number,
    atDate: number,
    format: string,
    task_bucket: number
  ) {
    return pgQueryP(
      "insert into worker_tasks (math_env, task_data, task_type, task_bucket) values ($1, $2, 'generate_export_data', $3);",
      [
        math_env,
        {
          email: email,
          zid: zid,
          "at-date": atDate,
          format: format,
        },
        task_bucket, // TODO hash the params to get a consistent number?
      ]
    );
  }

  if (
    Config.runPeriodicExportTests &&
    !devMode &&
    Config.mathEnv === "preprod"
  ) {
    const runExportTest = () => {
      const math_env = "prod";
      const email = Config.adminEmailDataExportTest;
      const zid = 12480;
      const atDate = Date.now();
      const format = "csv";
      const task_bucket = Math.abs((Math.random() * 999999999999) >> 0);
      doAddDataExportTask(
        math_env,
        email,
        zid,
        atDate,
        format,
        task_bucket
      ).then(() => {
        setTimeout(() => {
          pgQueryP(
            "select * from worker_tasks where task_type = 'generate_export_data' and task_bucket = ($1);",
            [task_bucket]
          ).then((rows: string | any[]) => {
            const ok = rows && rows.length;
            let newOk;
            if (ok) {
              newOk = rows[0].finished_time > 0;
            }
            if (ok && newOk) {
              console.log("runExportTest success");
            } else {
              console.log("runExportTest failed");
              emailBadProblemTime("Math export didn't finish.");
            }
          });
        }, 10 * 60 * 1000); // wait 10 minutes before verifying
      });
    };
    setInterval(runExportTest, 6 * 60 * 60 * 1000); // every 6 hours
  }

  function handle_GET_dataExport(
    req: { p: { uid?: any; zid: any; unixTimestamp: number; format: any } },
    res: { json: (arg0: {}) => void }
  ) {
    getUserInfoForUid2(req.p.uid)
      .then((user: { email: any }) => {
        return doAddDataExportTask(
          Config.mathEnv,
          user.email,
          req.p.zid,
          req.p.unixTimestamp * 1000,
          req.p.format,
          Math.abs((Math.random() * 999999999999) >> 0)
        )
          .then(() => {
            res.json({});
          })
          .catch((err: any) => {
            fail(res, 500, "polis_err_data_export123", err);
          });
      })
      .catch((err: any) => {
        fail(res, 500, "polis_err_data_export123b", err);
      });
  }

  function handle_GET_dataExport_results(
    req: { p: { filename: string } },
    res: { redirect: (arg0: any) => void }
  ) {
    const url = s3Client.getSignedUrl("getObject", {
      Bucket: "polis-datadump",
      Key: Config.mathEnv + "/" + req.p.filename,
      Expires: 60 * 60 * 24 * 7,
    });
    res.redirect(url);
  }

  function getBidIndexToPidMapping(zid: number, math_tick: number) {
    math_tick = math_tick || -1;
    return pgQueryP_readOnly(
      "select * from math_bidtopid where zid = ($1) and math_env = ($2);",
      [zid, Config.mathEnv]
    ).then((rows: string | any[]) => {
      if (zid === 12480) {
        console.log("bidToPid", rows[0].data);
      }
      if (!rows || !rows.length) {
        // Could actually be a 404, would require more work to determine that.
        return new Error("polis_err_get_pca_results_missing");
      } else if (rows[0].data.math_tick <= math_tick) {
        return new Error("polis_err_get_pca_results_not_new");
      } else {
        return rows[0].data;
      }
    });
  }

  function handle_GET_bidToPid(
    req: { p: { zid: any; math_tick: any } },
    res: {
      json: (arg0: { bidToPid: any }) => void;
      status: (
        arg0: number
      ) => { (): any; new (): any; end: { (): void; new (): any } };
    }
  ) {
    const zid = req.p.zid;
    const math_tick = req.p.math_tick;
    getBidIndexToPidMapping(zid, math_tick).then(
      function (doc: { bidToPid: any }) {
        const b2p = doc.bidToPid;
        res.json({
          bidToPid: b2p,
        });
      },
      function (err: any) {
        res.status(304).end();
      }
    );
  }

  function getXids(zid: any) {
    return new MPromise(
      "getXids",
      function (resolve: (arg0: any) => void, reject: (arg0: string) => void) {
        pgQuery_readOnly(
          "select pid, xid from xids inner join " +
            "(select * from participants where zid = ($1)) as p on xids.uid = p.uid " +
            " where owner in (select org_id from conversations where zid = ($1));",
          [zid],
          function (err: any, result: { rows: any }) {
            if (err) {
              reject("polis_err_fetching_xids");
              return;
            }
            resolve(result.rows);
          }
        );
      }
    );
  }

  function handle_GET_xids(
    req: { p: { uid?: any; zid: any } },
    res: {
      status: (
        arg0: number
      ) => { (): any; new (): any; json: { (arg0: any): void; new (): any } };
    }
  ) {
    const uid = req.p.uid;
    const zid = req.p.zid;

    isOwner(zid, uid).then(
      function (owner: any) {
        if (owner) {
          getXids(zid).then(
            function (xids: any) {
              res.status(200).json(xids);
            },
            function (err: any) {
              fail(res, 500, "polis_err_get_xids", err);
            }
          );
        } else {
          fail(res, 403, "polis_err_get_xids_not_authorized");
        }
      },
      function (err: any) {
        fail(res, 500, "polis_err_get_xids", err);
      }
    );
  }

  function handle_POST_xidWhitelist(
    req: { p: { xid_whitelist: any; uid?: any } },
    res: {
      status: (
        arg0: number
      ) => { (): any; new (): any; json: { (arg0: {}): void; new (): any } };
    }
  ) {
    const xid_whitelist = req.p.xid_whitelist;
    const len = xid_whitelist.length;
    const owner = req.p.uid;
    const entries = [];
    try {
      for (let i = 0; i < len; i++) {
        entries.push("(" + escapeLiteral(xid_whitelist[i]) + "," + owner + ")");
      }
    } catch (err) {
      return fail(res, 400, "polis_err_bad_xid", err);
    }

    pgQueryP(
      "insert into xid_whitelist (xid, owner) values " +
        entries.join(",") +
        " on conflict do nothing;",
      []
    )
      .then((result: any) => {
        res.status(200).json({});
      })
      .catch((err: any) => {
        return fail(res, 500, "polis_err_POST_xidWhitelist", err);
      });
  }

  function getBidsForPids(zid: any, math_tick: number, pids: any[]) {
    const dataPromise = getBidIndexToPidMapping(zid, math_tick);
    const mathResultsPromise = getPca(zid, math_tick);

    return Promise.all([dataPromise, mathResultsPromise]).then(function (
      items: { asPOJO: any }[]
    ) {
      const b2p = items[0].bidToPid || []; // not sure yet if "|| []" is right here.
      const mathResults = items[1].asPOJO;
      function findBidForPid(pid: any) {
        let yourBidi = -1;
        for (let bidi = 0; bidi < b2p.length; bidi++) {
          const pids = b2p[bidi];
          if (pids.indexOf(pid) !== -1) {
            yourBidi = bidi;
            break;
          }
        }

        let yourBid = indexToBid[yourBidi];

        if (yourBidi >= 0 && _.isUndefined(yourBid)) {
          console.error(
            "polis_err_math_index_mapping_mismatch",
            "pid was",
            pid,
            "bidToPid was",
            JSON.stringify(b2p)
          );
          yell("polis_err_math_index_mapping_mismatch");
          yourBid = -1;
        }
        return yourBid;
      }

      const indexToBid = mathResults["base-clusters"].id;
      const bids = pids.map(findBidForPid);
      const pidToBid = _.object(pids, bids);
      return pidToBid;
    });
  }

  function handle_GET_bid(
    req: { p: { uid?: any; zid: any; math_tick: any } },
    res: {
      json: (arg0: { bid: any }) => void;
      status: (
        arg0: number
      ) => { (): any; new (): any; end: { (): void; new (): any } };
    }
  ) {
    const uid = req.p.uid;
    const zid = req.p.zid;
    const math_tick = req.p.math_tick;

    const dataPromise = getBidIndexToPidMapping(zid, math_tick);
    const pidPromise = getPidPromise(zid, uid);
    const mathResultsPromise = getPca(zid, math_tick);

    Promise.all([dataPromise, pidPromise, mathResultsPromise])
      .then(
        function (items: { asPOJO: any }[]) {
          const b2p = items[0].bidToPid || []; // not sure yet if "|| []" is right here.
          const pid = items[1];
          const mathResults = items[2].asPOJO;
          if (((pid as unknown) as number) < 0) {
            // NOTE: this API should not be called in /demo mode
            fail(res, 500, "polis_err_get_bid_bad_pid");
            return;
          }

          const indexToBid = mathResults["base-clusters"].id;

          let yourBidi = -1;
          for (let bidi = 0; bidi < b2p.length; bidi++) {
            const pids = b2p[bidi];
            if (pids.indexOf(pid) !== -1) {
              yourBidi = bidi;
              break;
            }
          }

          let yourBid = indexToBid[yourBidi];

          if (yourBidi >= 0 && _.isUndefined(yourBid)) {
            console.error(
              "polis_err_math_index_mapping_mismatch",
              "pid was",
              pid,
              "bidToPid was",
              JSON.stringify(b2p)
            );
            yell("polis_err_math_index_mapping_mismatch");
            yourBid = -1;
          }

          res.json({
            bid: yourBid, // The user's current bid
          });
        },
        function (err: any) {
          res.status(304).end();
        }
      )
      .catch(function (err: any) {
        fail(res, 500, "polis_err_get_bid_misc", err);
      });
  }

  function handle_POST_auth_password(
    req: { p: { pwresettoken: any; newPassword: any } },
    res: {
      status: (
        arg0: number
      ) => {
        (): any;
        new (): any;
        json: { (arg0: string): void; new (): any };
      };
    }
  ) {
    const pwresettoken = req.p.pwresettoken;
    const newPassword = req.p.newPassword;

    getUidForPwResetToken(
      pwresettoken,
      function (err: any, userParams: { uid?: any }) {
        if (err) {
          console.error(err);
          fail(
            res,
            500,
            "Password Reset failed. Couldn't find matching pwresettoken.",
            err
          );
          return;
        }
        const uid = Number(userParams.uid);
        Password.generateHashedPassword(
          newPassword,
          function (err: any, hashedPassword: any) {
            return pgQueryP(
              "insert into jianiuevyew (uid, pwhash) values " +
                "($1, $2) on conflict (uid) " +
                "do update set pwhash = excluded.pwhash;",
              [uid, hashedPassword]
            ).then(
              (rows: any) => {
                res.status(200).json("Password reset successful.");
                clearPwResetToken(pwresettoken, function (err: any) {
                  if (err) {
                    yell(err);
                    console.error("polis_err_auth_pwresettoken_clear_fail");
                  }
                });
              },
              (err: any) => {
                console.error(err);
                fail(res, 500, "Couldn't reset password.", err);
              }
            );
          }
        );
      }
    );
  }

  const getServerNameWithProtocol = Config.getServerNameWithProtocol;

  function handle_POST_auth_pwresettoken(
    req: { p: { email: any } },
    res: {
      status: (
        arg0: number
      ) => {
        (): any;
        new (): any;
        json: { (arg0: string): void; new (): any };
      };
    }
  ) {
    const email = req.p.email;

    const server = getServerNameWithProtocol(req);

    // let's clear the cookies here, in case something is borked.
    clearCookies(req, res);

    function finish() {
      res
        .status(200)
        .json("Password reset email sent, please check your email.");
    }

    getUidByEmail(email).then(
      function (uid?: any) {
        setupPwReset(uid, function (err: any, pwresettoken: any) {
          sendPasswordResetEmail(
            uid,
            pwresettoken,
            server,
            function (err: any) {
              if (err) {
                console.error(err);
                fail(res, 500, "Error: Couldn't send password reset email.");
                return;
              }
              finish();
            }
          );
        });
      },
      function () {
        sendPasswordResetEmailFailure(email, server);
        finish();
      }
    );
  }

  // Email.sendPasswordResetEmailFailure;

  function getUidByEmail(email: string) {
    email = email.toLowerCase();
    return pgQueryP_readOnly(
      "SELECT uid FROM users where LOWER(email) = ($1);",
      [email]
    ).then(function (rows: string | any[]) {
      if (!rows || !rows.length) {
        throw new Error("polis_err_no_user_matching_email");
      }
      return rows[0].uid;
    });
  }

  function clearCookie(
    req: { [key: string]: any; headers?: { origin: string } },
    res: {
      [key: string]: any;
      clearCookie?: (
        arg0: any,
        arg1: { path: string; domain?: string }
      ) => void;
    },
    cookieName: any
  ) {
    const origin = req?.headers?.origin || "";
    if (domainOverride || origin.match(/^http:\/\/localhost:[0-9]{4}/)) {
      res?.clearCookie?.(cookieName, {
        path: "/",
      });
    } else {
      res?.clearCookie?.(cookieName, {
        path: "/",
        domain: ".pol.is",
      });
    }
  }

  function clearCookies(
    req: { headers?: Headers; cookies?: any; p?: any },
    res: {
      clearCookie?: (
        arg0: string,
        arg1: { path: string; domain?: string }
      ) => void;
      status?: (arg0: number) => void;
      _headers?: { [x: string]: any };
      redirect?: (arg0: string) => void;
      set?: (arg0: { "Content-Type": string }) => void;
    }
  ) {
    const origin = req?.headers?.origin || "";
    let cookieName;
    if (domainOverride || origin.match(/^http:\/\/localhost:[0-9]{4}/)) {
      for (cookieName in req.cookies) {
        if (COOKIES_TO_CLEAR[cookieName]) {
          res?.clearCookie?.(cookieName, {
            path: "/",
          });
        }
      }
    } else {
      for (cookieName in req.cookies) {
        if (COOKIES_TO_CLEAR[cookieName]) {
          res?.clearCookie?.(cookieName, {
            path: "/",
            domain: ".pol.is",
          });
        }
      }
    }
    winston.log(
      "info",
      "after clear res set-cookie: " +
        JSON.stringify(res?._headers?.["set-cookie"])
    );
  }
  function doCookieAuth(
    assigner: (arg0: any, arg1: string, arg2: number) => void,
    isOptional: any,
    req: { cookies: { [x: string]: any }; body: { uid?: any } },
    res: { status: (arg0: number) => void },
    next: { (err: any): void; (arg0?: string): void }
  ) {
    const token = req.cookies[COOKIES.TOKEN];

    getUserInfoForSessionToken(token, res, function (err: any, uid?: any) {
      if (err) {
        clearCookies(req, res); // TODO_MULTI_DATACENTER_CONSIDERATION
        if (isOptional) {
          next();
        } else {
          res.status(403);
          next("polis_err_auth_no_such_token");
        }
        return;
      }
      if (req.body.uid && req.body.uid !== uid) {
        res.status(401);
        next("polis_err_auth_mismatch_uid");
        return;
      }
      assigner(req, "uid", Number(uid));
      next();
    });
  }

  // Email.handlePostAuthDeregister;

  function hashStringToInt32(s: string) {
    let h = 1;
    if (typeof s !== "string" || !s.length) {
      return 99;
    }
    for (let i = 0; i < s.length; i++) {
      h = h * s.charCodeAt(i) * 31;
    }
    if (h < 0) {
      h = -h;
    }
    // fit in 32 bit signed
    while (h > 2147483648) {
      h = h / 2;
    }
    return h;
  }

  function handle_POST_metrics(
    req: {
      cookies: { [x: string]: any };
      p: {
        uid: null;
        durs: any[];
        clientTimestamp: any;
        times: any[];
        types: any[];
      };
    },
    res: {
      status: (
        arg0: number
      ) => { (): any; new (): any; json: { (arg0: {}): any; new (): any } };
      json: (arg0: {}) => void;
    }
  ) {
    const enabled = false;
    if (!enabled) {
      return res.status(200).json({});
    }

    const pc = req.cookies[COOKIES.PERMANENT_COOKIE];
    const hashedPc = hashStringToInt32(pc);

    const uid = req.p.uid || null;
    const durs = req.p.durs.map(function (dur: number | null) {
      if (dur === -1) {
        dur = null;
      }
      return dur;
    });
    const clientTimestamp = req.p.clientTimestamp;
    const ages = req.p.times.map(function (t: number) {
      return clientTimestamp - t;
    });
    const now = Date.now();
    const timesInTermsOfServerTime = ages.map(function (a: number) {
      return now - a;
    });
    const len = timesInTermsOfServerTime.length;
    const entries = [];
    for (let i = 0; i < len; i++) {
      entries.push(
        "(" +
          [
            uid || "null",
            req.p.types[i],
            durs[i],
            hashedPc,
            timesInTermsOfServerTime[i],
          ].join(",") +
          ")"
      );
    }

    pgQueryP(
      "insert into metrics (uid, type, dur, hashedPc, created) values " +
        entries.join(",") +
        ";",
      []
    )
      .then(function (result: any) {
        res.json({});
      })
      .catch(function (err: any) {
        fail(res, 500, "polis_err_metrics_post", err);
      });
  }

  function handle_GET_zinvites(
    req: { p: { zid: any; uid?: any } },
    res: {
      writeHead: (arg0: number) => void;
      json: (arg0: { status: number }) => void;
      status: (
        arg0: number
      ) => {
        (): any;
        new (): any;
        json: { (arg0: { codes: any }): void; new (): any };
      };
    }
  ) {
    // if uid is not conversation owner, fail
    pgQuery_readOnly(
      "SELECT * FROM conversations WHERE zid = ($1) AND owner = ($2);",
      [req.p.zid, req.p.uid],
      function (err: any, results: { rows: any }) {
        if (err) {
          fail(
            res,
            500,
            "polis_err_fetching_zinvite_invalid_conversation_or_owner",
            err
          );
          return;
        }
        if (!results || !results.rows) {
          res.writeHead(404);
          res.json({
            status: 404,
          });
          return;
        }
        pgQuery_readOnly(
          "SELECT * FROM zinvites WHERE zid = ($1);",
          [req.p.zid],
          function (err: any, results: { rows: any }) {
            if (err) {
              fail(
                res,
                500,
                "polis_err_fetching_zinvite_invalid_conversation_or_owner_or_something",
                err
              );
              return;
            }
            if (!results || !results.rows) {
              res.writeHead(404);
              res.json({
                status: 404,
              });
              return;
            }
            res.status(200).json({
              codes: results.rows, // _.pluck(results.rows[0],"code");
            });
          }
        );
      }
    );
  }

  function generateConversationURLPrefix() {
    // not 1 or 0 since they look like "l" and "O"
    return "" + _.random(2, 9);
  }

  function generateSUZinvites(numTokens: number) {
    return new Promise(function (
      resolve: (arg0: any) => void,
      reject: (arg0: Error) => void
    ) {
      generateToken(
        31 * numTokens,
        // For now, pseodorandom bytes are probably ok. Anticipating API call will generate lots of these at once,
        // possibly draining the entropy pool. Revisit this if the otzinvites really need to be unguessable.
        true,
        function (err: any, longStringOfTokens?: string) {
          if (err) {
            reject(new Error("polis_err_creating_otzinvite"));
            return;
          }
          winston.log("info", longStringOfTokens);
          const otzinviteArrayRegexMatch = longStringOfTokens?.match(/.{1,31}/g);
          // Base64 encoding expands to extra characters, so trim to the number of tokens we want.
          let otzinviteArray = otzinviteArrayRegexMatch?.slice(0, numTokens);
          otzinviteArray = otzinviteArray?.map(function (suzinvite: string) {
            return generateConversationURLPrefix() + suzinvite;
          });
          winston.log("info", otzinviteArray);
          resolve(otzinviteArray);
        }
      );
    });
  }

  function handle_POST_zinvites(
    req: { p: { short_url: any; zid: any; uid?: any } },
    res: {
      status: (
        arg0: number
      ) => {
        (): any;
        new (): any;
        json: { (arg0: { zinvite: any }): void; new (): any };
      };
    }
  ) {
    const generateShortUrl = req.p.short_url;

    pgQuery(
      "SELECT * FROM conversations WHERE zid = ($1) AND owner = ($2);",
      [req.p.zid, req.p.uid],
      function (err: any, results: any) {
        if (err) {
          fail(
            res,
            500,
            "polis_err_creating_zinvite_invalid_conversation_or_owner",
            err
          );
          return;
        }

        generateAndRegisterZinvite(req.p.zid, generateShortUrl)
          .then(function (zinvite: any) {
            res.status(200).json({
              zinvite: zinvite,
            });
          })
          .catch(function (err: any) {
            fail(res, 500, "polis_err_creating_zinvite", err);
          });
      }
    );
  }

  function checkZinviteCodeValidity(
    zid: any,
    zinvite: any,
    callback: {
      (err: any, foo: any): void;
      (err: any, foo: any): void;
      (err: any): void;
      (arg0: number | null): void;
    }
  ) {
    pgQuery_readOnly(
      "SELECT * FROM zinvites WHERE zid = ($1) AND zinvite = ($2);",
      [zid, zinvite],
      function (err: any, results: { rows: string | any[] }) {
        if (err || !results || !results.rows || !results.rows.length) {
          callback(1);
        } else {
          callback(null); // ok
        }
      }
    );
  }

  const zidToConversationIdCache = new LruCache({
    max: 1000,
  });

  function getZinvite(zid: any, dontUseCache?: boolean) {
    const cachedConversationId = zidToConversationIdCache.get(zid);
    if (!dontUseCache && cachedConversationId) {
      return Promise.resolve(cachedConversationId);
    }
    return pgQueryP_metered(
      "getZinvite",
      "select * from zinvites where zid = ($1);",
      [zid]
    ).then(function (rows: { zinvite: any }[]) {
      const conversation_id = (rows && rows[0] && rows[0].zinvite) || void 0;
      if (conversation_id) {
        zidToConversationIdCache.set(zid, conversation_id);
      }
      return conversation_id;
    });
  }

  function getZinvites(zids: any[]) {
    if (!zids.length) {
      return Promise.resolve(zids);
    }
    zids = _.map(zids, function (zid: any) {
      return Number(zid); // just in case
    });
    zids = _.uniq(zids);

    const uncachedZids = zids.filter(function (zid: any) {
      return !zidToConversationIdCache.get(zid);
    });
    const zidsWithCachedConversationIds = zids
      .filter(function (zid: any) {
        return !!zidToConversationIdCache.get(zid);
      })
      .map(function (zid: any) {
        return {
          zid: zid,
          zinvite: zidToConversationIdCache.get(zid),
        };
      });

    function makeZidToConversationIdMap(arrays: any[]) {
      const zid2conversation_id = {};
      arrays.forEach(function (a: any[]) {
        a.forEach(function (o: { zid: string | number; zinvite: any }) {
          zid2conversation_id[o.zid] = o.zinvite;
        });
      });
      return zid2conversation_id;
    }

    return new MPromise(
      "getZinvites",
      function (resolve: (arg0: {}) => void, reject: (arg0: any) => void) {
        if (uncachedZids.length === 0) {
          resolve(makeZidToConversationIdMap([zidsWithCachedConversationIds]));
          return;
        }
        pgQuery_readOnly(
          "select * from zinvites where zid in (" +
            uncachedZids.join(",") +
            ");",
          [],
          function (err: any, result: { rows: any }) {
            if (err) {
              reject(err);
            } else {
              resolve(
                makeZidToConversationIdMap([
                  result.rows,
                  zidsWithCachedConversationIds,
                ])
              );
            }
          }
        );
      }
    );
  }

  function addConversationId(
    o: { zid?: any; conversation_id?: any },
    dontUseCache: any
  ) {
    if (!o.zid) {
      // if no zid, resolve without fetching zinvite.
      return Promise.resolve(o);
    }
    return getZinvite(o.zid, dontUseCache).then(function (
      conversation_id: any
    ) {
      o.conversation_id = conversation_id;
      return o;
    });
  }

  function addConversationIds(a: any[]) {
    const zids = [];
    for (let i = 0; i < a.length; i++) {
      if (a[i].zid) {
        zids.push(a[i].zid);
      }
    }
    if (!zids.length) {
      return Promise.resolve(a);
    }
    return getZinvites(zids).then(function (zid2conversation_id: {
      [x: string]: any;
    }) {
      return a.map(function (o: {
        conversation_id: any;
        zid: string | number;
      }) {
        o.conversation_id = zid2conversation_id[o.zid];
        return o;
      });
    });
  }

  function finishOne(
    res: {
      status: (
        arg0: any
      ) => { (): any; new (): any; json: { (arg0: any): void; new (): any } };
    },
    o: { url?: string; zid?: any; currentPid?: any },
    dontUseCache?: boolean | undefined,
    altStatusCode?: number | undefined
  ) {
    addConversationId(o, dontUseCache)
      .then(
        function (item: { zid: any }) {
          // ensure we don't expose zid
          if (item.zid) {
            delete item.zid;
          }
          const statusCode = altStatusCode || 200;
          res.status(statusCode).json(item);
        },
        function (err: any) {
          fail(res, 500, "polis_err_finishing_responseA", err);
        }
      )
      .catch(function (err: any) {
        fail(res, 500, "polis_err_finishing_response", err);
      });
  }

  function finishArray(
    res: {
      status: (
        arg0: number
      ) => { (): any; new (): any; json: { (arg0: any): void; new (): any } };
    },
    a: any
  ) {
    addConversationIds(a)
      .then(
        function (items: string | any[]) {
          // ensure we don't expose zid
          if (items) {
            for (let i = 0; i < items.length; i++) {
              if (items[i].zid) {
                delete items[i].zid;
              }
            }
          }
          res.status(200).json(items);
        },
        function (err: any) {
          fail(res, 500, "polis_err_finishing_response2A", err);
        }
      )
      .catch(function (err: any) {
        fail(res, 500, "polis_err_finishing_response2", err);
      });
  }

  function checkSuzinviteCodeValidity(
    zid: any,
    suzinvite: any,
    callback: {
      (err: any, foo: any): void;
      (err: any, foo: any): void;
      (err: any): void;
      (arg0: number | null): void;
    }
  ) {
    pgQuery(
      "SELECT * FROM suzinvites WHERE zid = ($1) AND suzinvite = ($2);",
      [zid, suzinvite],
      function (err: any, results: { rows: string | any[] }) {
        if (err || !results || !results.rows || !results.rows.length) {
          callback(1);
        } else {
          callback(null); // ok
        }
      }
    );
  }

  function getSUZinviteInfo(suzinvite: any) {
    return new Promise(function (
      resolve: (arg0: any) => void,
      reject: (arg0: Error) => any
    ) {
      pgQuery(
        "SELECT * FROM suzinvites WHERE suzinvite = ($1);",
        [suzinvite],
        function (err: any, results: { rows: string | any[] }) {
          if (err) {
            return reject(err);
          }
          if (!results || !results.rows || !results.rows.length) {
            return reject(new Error("polis_err_no_matching_suzinvite"));
          }
          resolve(results.rows[0]);
        }
      );
    });
  }

  function deleteSuzinvite(suzinvite: any) {
    return new Promise(function (resolve: () => void, reject: any) {
      pgQuery(
        "DELETE FROM suzinvites WHERE suzinvite = ($1);",
        [suzinvite],
        function (err: any, results: any) {
          if (err) {
            // resolve, but complain
            yell("polis_err_removing_suzinvite");
          }
          resolve();
        }
      );
    });
  }

  function xidExists(xid: any, owner: any, uid?: any) {
    return pgQueryP(
      "select * from xids where xid = ($1) and owner = ($2) and uid = ($3);",
      [xid, owner, uid]
    ).then(function (rows: string | any[]) {
      return rows && rows.length;
    });
  }

  function createXidEntry(xid: any, owner: any, uid?: any) {
    return new Promise(function (
      resolve: () => void,
      reject: (arg0: Error) => void
    ) {
      pgQuery(
        "INSERT INTO xids (uid, owner, xid) VALUES ($1, $2, $3);",
        [uid, owner, xid],
        function (err: any, results: any) {
          if (err) {
            console.error(err);
            reject(new Error("polis_err_adding_xid_entry"));
            return;
          }
          resolve();
        }
      );
    });
  }

  function saveParticipantMetadataChoicesP(zid: any, pid: any, answers: any) {
    return new Promise(function (
      resolve: (arg0: number) => void,
      reject: (arg0: any) => void
    ) {
      saveParticipantMetadataChoices(zid, pid, answers, function (err: any) {
        if (err) {
          reject(err);
        } else {
          resolve(0);
        }
      });
    });
  }

  function saveParticipantMetadataChoices(
    zid: any,
    pid: any,
    answers: any[],
    callback: { (err: any): void; (arg0: number): void }
  ) {
    // answers is a list of pmaid
    if (!answers || !answers.length) {
      // nothing to save
      return callback(0);
    }

    const q =
      "select * from participant_metadata_answers where zid = ($1) and pmaid in (" +
      answers.join(",") +
      ");";

    pgQuery(
      q,
      [zid],
      function (
        err: any,
        qa_results: { [x: string]: { pmqid: any }; rows: any }
      ) {
        if (err) {
          winston.log("info", "adsfasdfasd");
          return callback(err);
        }

        qa_results = qa_results.rows;
        qa_results = _.indexBy(qa_results, "pmaid");
        // construct an array of params arrays
        answers = answers.map(function (pmaid: string | number) {
          const pmqid = qa_results[pmaid].pmqid;
          return [zid, pid, pmaid, pmqid];
        });
        // make simultaneous requests to insert the choices
        async.map(
          answers,
          function (x: any, cb: (arg0: number) => void) {
            pgQuery(
              "INSERT INTO participant_metadata_choices (zid, pid, pmaid, pmqid) VALUES ($1,$2,$3,$4);",
              x,
              function (err: any, results: any) {
                if (err) {
                  winston.log("info", "sdkfuhsdu");
                  return cb(err);
                }
                cb(0);
              }
            );
          },
          function (err: any) {
            if (err) {
              winston.log("info", "ifudshf78ds");
              return callback(err);
            }
            // finished with all the inserts
            callback(0);
          }
        );
      }
    );
  }

  function createParticpantLocationRecord(
    zid: any,
    uid?: any,
    pid?: any,
    lat?: any,
    lng?: any,
    source?: any
  ) {
    return pgQueryP(
      "insert into participant_locations (zid, uid, pid, lat, lng, source) values ($1,$2,$3,$4,$5,$6);",
      [zid, uid, pid, lat, lng, source]
    );
  }

  const LOCATION_SOURCES = {
    Twitter: 400,
    Facebook: 300,
    HTML5: 200,
    IP: 100,
    manual_entry: 1,
  };

  function getUsersLocationName(uid?: any) {
    return Promise.all([
      pgQueryP_readOnly("select * from facebook_users where uid = ($1);", [
        uid,
      ]),
      pgQueryP_readOnly("select * from twitter_users where uid = ($1);", [uid]),
    ]).then(function (o: any[][]) {
      const fb = o[0] && o[0][0];
      const tw = o[1] && o[1][0];
      if (fb && _.isString(fb.location)) {
        return {
          location: fb.location,
          source: LOCATION_SOURCES.Facebook,
        };
      } else if (tw && _.isString(tw.location)) {
        return {
          location: tw.location,
          source: LOCATION_SOURCES.Twitter,
        };
      }
      return null;
    });
  }

  function populateParticipantLocationRecordIfPossible(
    zid: any,
    uid?: any,
    pid?: any
  ) {
    INFO("asdf1", zid, uid, pid);
    getUsersLocationName(uid)
      .then(function (locationData: { location: any; source: any }) {
        if (!locationData) {
          INFO("asdf1.nope");
          return;
        }
        INFO(locationData);
        geoCode(locationData.location)
          .then(function (o: { lat: any; lng: any }) {
            createParticpantLocationRecord(
              zid,
              uid,
              pid,
              o.lat,
              o.lng,
              locationData.source
            ).catch(function (err: any) {
              if (!isDuplicateKey(err)) {
                yell("polis_err_creating_particpant_location_record");
                console.error(err);
              }
            });
          })
          .catch(function (err: any) {
            yell("polis_err_geocoding_01");
            console.error(err);
          });
      })
      .catch(function (err: any) {
        yell("polis_err_fetching_user_location_name");
        console.error(err);
      });
  }

  function updateLastInteractionTimeForConversation(zid: any, uid?: any) {
    return pgQueryP(
      "update participants set last_interaction = now_as_millis(), nsli = 0 where zid = ($1) and uid = ($2);",
      [zid, uid]
    );
  }

  function populateGeoIpInfo(zid: any, uid?: any, ipAddress?: string | null) {
    const userId = Config.maxmindUserID;
    const licenseKey = Config.maxmindLicenseKey;

    let url = "https://geoip.maxmind.com/geoip/v2.1/city/";
    let contentType =
      "application/vnd.maxmind.com-city+json; charset=UTF-8; version=2.1";

    // "city" is     $0.0004 per query
    // "insights" is $0.002  per query
    const insights = false;

    if (insights) {
      url = "https://geoip.maxmind.com/geoip/v2.1/insights/";
      contentType =
        "application/vnd.maxmind.com-insights+json; charset=UTF-8; version=2.1";
    }
    return request
      .get(url + ipAddress, {
        method: "GET",
        contentType: contentType,
        headers: {
          Authorization:
            "Basic " +
            new Buffer(userId + ":" + licenseKey, "utf8").toString("base64"),
        },
      })
      .then(function (response: string) {
        const parsedResponse = JSON.parse(response);
        console.log("BEGIN MAXMIND RESPONSE");
        console.log(response);
        console.log("END MAXMIND RESPONSE");

        return pgQueryP(
          "update participants_extended set modified=now_as_millis(), country_iso_code=($4), encrypted_maxmind_response_city=($3), " +
            "location=ST_GeographyFromText('SRID=4326;POINT(" +
            parsedResponse.location.latitude +
            " " +
            parsedResponse.location.longitude +
            ")'), latitude=($5), longitude=($6) where zid = ($1) and uid = ($2);",
          [
            zid,
            uid,
            encrypt(response),
            parsedResponse.country.iso_code,
            parsedResponse.location.latitude,
            parsedResponse.location.longitude,
          ]
        );
      });
  }

  // SECOND_QUARTER;

  // SECOND_HALF;

}