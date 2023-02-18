var __spreadArray = (this && this.__spreadArray) || function (to, from) {
    for (var i = 0, il = from.length, j = to.length; i < il; i++, j++)
        to[j] = from[i];
    return to;
};
function initializePolisHelpers() {
    var polisTypes = Utils.polisTypes;
    var setCookie = cookies.setCookie;
    var setParentReferrerCookie = cookies.setParentReferrerCookie;
    var setParentUrlCookie = cookies.setParentUrlCookie;
    var setPlanCookie = cookies.setPlanCookie;
    var setPermanentCookie = cookies.setPermanentCookie;
    var setCookieTestCookie = cookies.setCookieTestCookie;
    var shouldSetCookieOnPolisDomain = cookies.shouldSetCookieOnPolisDomain;
    var addCookies = cookies.addCookies;
    var getPermanentCookieAndEnsureItIsSet = cookies.getPermanentCookieAndEnsureItIsSet;
    var pidCache = User.pidCache;
    var getPid = User.getPid;
    var getPidPromise = User.getPidPromise;
    var getPidForParticipant = User.getPidForParticipant;
    function recordPermanentCookieZidJoin(permanentCookieToken, zid) {
        function doInsert() {
            return pgQueryP("insert into permanentCookieZidJoins (cookie, zid) values ($1, $2);", [permanentCookieToken, zid]);
        }
        return pgQueryP("select zid from permanentCookieZidJoins where cookie = ($1) and zid = ($2);", [permanentCookieToken, zid]).then(function (rows) {
            if (rows && rows.length) {
                // already there
            }
            else {
                return doInsert();
            }
        }, function (err) {
            console.error(err);
            // hmm, weird, try inserting anyway
            return doInsert();
        });
    }
    var detectLanguage = Comment.detectLanguage;
    if (Config.backfillCommentLangDetection) {
        pgQueryP("select tid, txt, zid from comments where lang is null;", []).then(function (comments) {
            var i = 0;
            function doNext() {
                if (i < comments.length) {
                    var c_1 = comments[i];
                    i += 1;
                    detectLanguage(c_1.txt).then(function (x) {
                        var firstResult = x[0];
                        console.log("backfill", firstResult.language + "\t\t" + c_1.txt);
                        pgQueryP("update comments set lang = ($1), lang_confidence = ($2) where zid = ($3) and tid = ($4)", [firstResult.language, firstResult.confidence, c_1.zid, c_1.tid]).then(function () {
                            doNext();
                        });
                    });
                }
            }
            doNext();
        });
    }
    function doVotesPost(uid, pid, conv, tid, voteType, weight, shouldNotify) {
        var zid = conv === null || conv === void 0 ? void 0 : conv.zid;
        weight = weight || 0;
        // weight is stored as a SMALLINT, so convert from a [-1,1] float to [-32767,32767] int
        var weight_x_32767 = Math.trunc(weight * 32767);
        return new Promise(function (resolve, reject) {
            var query = "INSERT INTO votes (pid, zid, tid, vote, weight_x_32767, created) VALUES ($1, $2, $3, $4, $5, default) RETURNING *;";
            var params = [pid, zid, tid, voteType, weight_x_32767];
            pgQuery(query, params, function (err, result) {
                if (err) {
                    if (isDuplicateKey(err)) {
                        reject("polis_err_vote_duplicate");
                    }
                    else {
                        console.dir(err);
                        reject("polis_err_vote_other");
                    }
                    return;
                }
                var vote = result.rows[0];
                resolve({
                    conv: conv,
                    vote: vote
                });
            });
        });
    }
    function votesPost(uid, pid, zid, tid, voteType, weight, shouldNotify) {
        return (pgQueryP_readOnly("select * from conversations where zid = ($1);", [zid])
            .then(function (rows) {
            if (!rows || !rows.length) {
                throw "polis_err_unknown_conversation";
            }
            var conv = rows[0];
            if (!conv.is_active) {
                throw "polis_err_conversation_is_closed";
            }
            if (conv.auth_needed_to_vote) {
                return isModerator(zid, uid).then(function (is_mod) {
                    if (is_mod) {
                        return conv;
                    }
                    return Promise.all([
                        pgQueryP("select * from xids where owner = ($1) and uid = ($2);", [conv.owner, uid]),
                        getSocialInfoForUsers([uid], zid),
                    ]).then(function (_a) {
                        var xids = _a[0], info = _a[1];
                        var socialAccountIsLinked = info.length > 0;
                        var hasXid = xids.length > 0;
                        if (socialAccountIsLinked || hasXid) {
                            return conv;
                        }
                        else {
                            throw "polis_err_post_votes_social_needed";
                        }
                    });
                });
            }
            return conv;
        })
            .then(function (conv) {
            return doVotesPost(uid, pid, conv, tid, voteType, weight, shouldNotify);
        }));
    }
    function getVotesForSingleParticipant(p) {
        if (_.isUndefined(p.pid)) {
            return Promise.resolve([]);
        }
        return votesGet(p);
    }
    function votesGet(p) {
        return new MPromise("votesGet", function (resolve, reject) {
            var q = sql_votes_latest_unique
                .select(sql_votes_latest_unique.star())
                .where(sql_votes_latest_unique.zid.equals(p.zid));
            if (!_.isUndefined(p.pid)) {
                q = q.where(sql_votes_latest_unique.pid.equals(p.pid));
            }
            if (!_.isUndefined(p.tid)) {
                q = q.where(sql_votes_latest_unique.tid.equals(p.tid));
            }
            pgQuery_readOnly(q.toString(), function (err, results) {
                if (err) {
                    reject(err);
                }
                else {
                    resolve(results.rows);
                }
            });
        });
    }
    function writeDefaultHead(req, res, next) {
        res.set({
            "Content-Type": "application/json",
            "Cache-Control": "no-cache",
            Connection: "keep-alive"
        });
        next();
    }
    function redirectIfNotHttps(req, res, next) {
        var _a, _b;
        var exempt = devMode;
        if (exempt) {
            return next();
        }
        var isHttps = ((_a = req === null || req === void 0 ? void 0 : req.headers) === null || _a === void 0 ? void 0 : _a["x-forwarded-proto"]) === "https";
        if (!isHttps) {
            // assuming we're running on Heroku, where we're behind a proxy.
            res.writeHead(302, {
                Location: "https://" + ((_b = req === null || req === void 0 ? void 0 : req.headers) === null || _b === void 0 ? void 0 : _b.host) + req.url
            });
            return res.end();
        }
        return next();
    }
    function redirectIfWrongDomain(req, res, next) {
        var _a;
        if (/www.pol.is/.test(((_a = req === null || req === void 0 ? void 0 : req.headers) === null || _a === void 0 ? void 0 : _a.host) || "")) {
            res.writeHead(302, {
                Location: serverUrl + req.url
            });
            return res.end();
        }
        return next();
    }
    function redirectIfApiDomain(req, res, next) {
        var _a;
        if (/api.pol.is/.test(((_a = req === null || req === void 0 ? void 0 : req.headers) === null || _a === void 0 ? void 0 : _a.host) || "")) {
            if (req.url === "/" || req.url === "") {
                res.writeHead(302, {
                    Location: "https://pol.is/docs/api"
                });
                return res.end();
            }
            else if (!req.url.match(/^\/?api/)) {
                res.writeHead(302, {
                    Location: "https://pol.is/" + req.url
                });
                return res.end();
            }
        }
        return next();
    }
    function doXidConversationIdAuth(assigner, xid, conversation_id, isOptional, req, res, onDone) {
        return getConversationInfoByConversationId(conversation_id)
            .then(function (conv) {
            var _a, _b, _c, _d;
            return getXidRecordByXidOwnerId(xid, conv.org_id, conv.zid, req.body.x_profile_image_url || ((_a = req === null || req === void 0 ? void 0 : req.query) === null || _a === void 0 ? void 0 : _a.x_profile_image_url), req.body.x_name || ((_b = req === null || req === void 0 ? void 0 : req.query) === null || _b === void 0 ? void 0 : _b.x_name) || null, req.body.x_email || ((_c = req === null || req === void 0 ? void 0 : req.query) === null || _c === void 0 ? void 0 : _c.x_email) || null, !!req.body.agid || !!((_d = req === null || req === void 0 ? void 0 : req.query) === null || _d === void 0 ? void 0 : _d.agid) || null).then(function (rows) {
                if (!rows || !rows.length) {
                    if (isOptional) {
                        return onDone();
                    }
                    else {
                        res.status(403);
                        onDone("polis_err_auth_no_such_xid_for_this_apikey_11");
                        return;
                    }
                }
                var uidForCurrentUser = Number(rows[0].uid);
                assigner(req, "uid", uidForCurrentUser);
                onDone();
            });
        })["catch"](function (err) {
            console.log(err);
            onDone(err);
        });
    }
    function _auth(assigner, isOptional) {
        function getKey(req, key) {
            var _a, _b;
            return req.body[key] || ((_a = req === null || req === void 0 ? void 0 : req.headers) === null || _a === void 0 ? void 0 : _a[key]) || ((_b = req === null || req === void 0 ? void 0 : req.query) === null || _b === void 0 ? void 0 : _b[key]);
        }
        function doAuth(req, res) {
            var _a;
            //var token = req.body.token;
            var token = req.cookies[COOKIES.TOKEN];
            var xPolisToken = (_a = req === null || req === void 0 ? void 0 : req.headers) === null || _a === void 0 ? void 0 : _a["x-polis"];
            return new Promise(function (resolve, reject) {
                var _a, _b, _c;
                function onDone(err) {
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
                }
                else if (xPolisToken) {
                    console.log("authtype", "doHeaderAuth");
                    doHeaderAuth(assigner, isOptional, req, res, onDone);
                }
                else if (getKey(req, "polisApiKey") && getKey(req, "ownerXid")) {
                    console.log("authtype", "doXidApiKeyAuth");
                    doXidApiKeyAuth(assigner, getKey(req, "polisApiKey"), getKey(req, "ownerXid"), isOptional, req, res, onDone);
                }
                else if (getKey(req, "polisApiKey") && getKey(req, "xid")) {
                    console.log("authtype", "doXidApiKeyAuth");
                    doXidApiKeyAuth(assigner, getKey(req, "polisApiKey"), getKey(req, "xid"), isOptional, req, res, onDone);
                }
                else if (getKey(req, "xid") && getKey(req, "conversation_id")) {
                    console.log("authtype", "doXidConversationIdAuth");
                    doXidConversationIdAuth(assigner, getKey(req, "xid"), getKey(req, "conversation_id"), isOptional, req, res, onDone);
                }
                else if ((_a = req === null || req === void 0 ? void 0 : req.headers) === null || _a === void 0 ? void 0 : _a["x-sandstorm-app-polis-apikey"]) {
                    console.log("authtype", "doApiKeyAuth");
                    doApiKeyAuth(assigner, (_b = req === null || req === void 0 ? void 0 : req.headers) === null || _b === void 0 ? void 0 : _b["x-sandstorm-app-polis-apikey"], isOptional, req, res, onDone);
                }
                else if (req.body["polisApiKey"]) {
                    console.log("authtype", "doApiKeyAuth");
                    doApiKeyAuth(assigner, getKey(req, "polisApiKey"), isOptional, req, res, onDone);
                }
                else if (token) {
                    console.log("authtype", "doCookieAuth");
                    doCookieAuth(assigner, isOptional, req, res, onDone);
                }
                else if ((_c = req === null || req === void 0 ? void 0 : req.headers) === null || _c === void 0 ? void 0 : _c.authorization) {
                    console.log("authtype", "doApiKeyBasicAuth");
                    doApiKeyBasicAuth(assigner, req.headers.authorization, isOptional, req, res, onDone);
                }
                else if (req.body.agid) {
                    // Auto Gen user  ID
                    console.log("authtype", "no auth but agid");
                    createDummyUser()
                        .then(function (uid) {
                        var shouldAddCookies = _.isUndefined(req.body.xid);
                        if (!shouldAddCookies) {
                            req.p = req.p || {};
                            req.p.uid = uid;
                            return onDone();
                        }
                        return startSessionAndAddCookies(req, res, uid).then(function () {
                            req.p = req.p || {};
                            req.p.uid = uid;
                            onDone();
                        }, function (err) {
                            res.status(500);
                            console.error(err);
                            onDone("polis_err_auth_token_error_2343");
                        });
                    }, function (err) {
                        res.status(500);
                        console.error(err);
                        onDone("polis_err_auth_token_error_1241");
                    })["catch"](function (err) {
                        res.status(500);
                        console.error(err);
                        onDone("polis_err_auth_token_error_5345");
                    });
                }
                else if (isOptional) {
                    onDone(); // didn't create user
                }
                else {
                    res.status(401);
                    onDone("polis_err_auth_token_not_supplied");
                }
            });
        }
        return function (req, res, next) {
            doAuth(req, res)
                .then(function () {
                return next();
            })["catch"](function (err) {
                res.status(500);
                console.error(err);
                next(err || "polis_err_auth_error_432");
            });
        };
    }
    // input token from body or query, and populate req.body.u with userid.
    function authOptional(assigner) {
        return _auth(assigner, true);
    }
    function auth(assigner) {
        return _auth(assigner, false);
    }
    function enableAgid(req, res, next) {
        req.body.agid = 1;
        next();
    }
    var whitelistedCrossDomainRoutes = [
        /^\/api\/v[0-9]+\/launchPrep/,
        /^\/api\/v[0-9]+\/setFirstCookie/,
    ];
    var whitelistedDomains = __spreadArray(__spreadArray([
        Config.getServerHostname()
    ], Config.whitelistItems), [
        "localhost:5000",
        "localhost:5001",
        "localhost:5002",
        "canvas.instructure.com",
        "canvas.uw.edu",
        "canvas.shoreline.edu",
        "shoreline.instructure.com",
        "facebook.com",
        "api.twitter.com",
        "connect.stripe.com",
        "", // for API
    ]);
    var whitelistedBuckets = {
        "pol.is": "pol.is",
        "embed.pol.is": "pol.is",
        "survey.pol.is": "survey.pol.is",
        "preprod.pol.is": "preprod.pol.is"
    };
    function hasWhitelistMatches(host) {
        var hostWithoutProtocol = host;
        if (host.startsWith("http://")) {
            hostWithoutProtocol = host.slice(7);
        }
        else if (host.startsWith("https://")) {
            hostWithoutProtocol = host.slice(8);
        }
        for (var i = 0; i < whitelistedDomains.length; i++) {
            var w = whitelistedDomains[i];
            if (hostWithoutProtocol.endsWith(w || "")) {
                // ok, the ending matches, now we need to make sure it's the same, or a subdomain.
                if (hostWithoutProtocol === w) {
                    return true;
                }
                if (hostWithoutProtocol[hostWithoutProtocol.length - ((w || "").length + 1)] === ".") {
                    // separated by a dot, so it's a subdomain.
                    return true;
                }
            }
        }
        return false;
    }
    function addCorsHeader(req, res, next) {
        var host = "";
        if (domainOverride) {
            host = req.protocol + "://" + domainOverride;
        }
        else {
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
        var result = /^[^\/]*\/\/[^\/]*/.exec(host);
        if (result && result[0]) {
            host = result[0];
        }
        // check if the route is on a special list that allows it to be called cross domain (by polisHost.js for example)
        var routeIsWhitelistedForAnyDomain = _.some(whitelistedCrossDomainRoutes, function (regex) {
            return regex.test(req.path);
        });
        if (!domainOverride &&
            !hasWhitelistMatches(host) &&
            !routeIsWhitelistedForAnyDomain) {
            winston.log("info", "not whitelisted");
            winston.log("info", req.headers);
            winston.log("info", req.path);
            return next("unauthorized domain: " + host);
        }
        if (host === "") {
            // API
        }
        else {
            res.header("Access-Control-Allow-Origin", host);
            res.header("Access-Control-Allow-Headers", "Cache-Control, Pragma, Origin, Authorization, Content-Type, X-Requested-With");
            res.header("Access-Control-Allow-Methods", "GET, PUT, POST, DELETE, OPTIONS");
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
    var strToHex = Utils.strToHex;
    var hexToStr = Utils.hexToStr;
    function handle_GET_launchPrep(req, res) {
        var _a;
        var setOnPolisDomain = !domainOverride;
        var origin = ((_a = req === null || req === void 0 ? void 0 : req.headers) === null || _a === void 0 ? void 0 : _a.origin) || "";
        if (setOnPolisDomain && origin.match(/^http:\/\/localhost:[0-9]{4}/)) {
            setOnPolisDomain = false;
        }
        if (!req.cookies[COOKIES.PERMANENT_COOKIE]) {
            setPermanentCookie(req, res, setOnPolisDomain, makeSessionToken());
        }
        setCookieTestCookie(req, res, setOnPolisDomain);
        setCookie(req, res, setOnPolisDomain, "top", "ok", {
            httpOnly: false
        });
        // using hex since it doesn't require escaping like base64.
        var dest = hexToStr(req.p.dest);
        res.redirect(dest);
    }
    function handle_GET_tryCookie(req, res) {
        var _a;
        var setOnPolisDomain = !domainOverride;
        var origin = ((_a = req === null || req === void 0 ? void 0 : req.headers) === null || _a === void 0 ? void 0 : _a.origin) || "";
        if (setOnPolisDomain && origin.match(/^http:\/\/localhost:[0-9]{4}/)) {
            setOnPolisDomain = false;
        }
        if (!req.cookies[COOKIES.TRY_COOKIE]) {
            setCookie(req, res, setOnPolisDomain, COOKIES.TRY_COOKIE, "ok", {
                httpOnly: false
            });
        }
        res.status(200).json({});
    }
    var pcaCacheSize = Config.cacheMathResults ? 300 : 1;
    var pcaCache = new LruCache({
        max: pcaCacheSize
    });
    var lastPrefetchedMathTick = -1;
    function processMathObject(o) {
        function remapSubgroupStuff(g) {
            if (_.isArray(g.val)) {
                g.val = g.val.map(function (x) {
                    return { id: Number(x.id), val: x };
                });
            }
            else {
                g.val = _.keys(g.val).map(function (id) {
                    return { id: Number(id), val: g.val[id] };
                });
            }
            return g;
        }
        // Normalize so everything is arrays of objects (group-clusters is already in this format,
        // but needs to have the val: subobject style too).
        if (_.isArray(o["group-clusters"])) {
            // NOTE this is different since group-clusters is already an array.
            o["group-clusters"] = o["group-clusters"].map(function (g) {
                return { id: Number(g.id), val: g };
            });
        }
        if (!_.isArray(o["repness"])) {
            o["repness"] = _.keys(o["repness"]).map(function (gid) {
                return { id: Number(gid), val: o["repness"][gid] };
            });
        }
        if (!_.isArray(o["group-votes"])) {
            o["group-votes"] = _.keys(o["group-votes"]).map(function (gid) {
                return { id: Number(gid), val: o["group-votes"][gid] };
            });
        }
        if (!_.isArray(o["subgroup-repness"])) {
            o["subgroup-repness"] = _.keys(o["subgroup-repness"]).map(function (gid) {
                return { id: Number(gid), val: o["subgroup-repness"][gid] };
            });
            o["subgroup-repness"].map(remapSubgroupStuff);
        }
        if (!_.isArray(o["subgroup-votes"])) {
            o["subgroup-votes"] = _.keys(o["subgroup-votes"]).map(function (gid) {
                return { id: Number(gid), val: o["subgroup-votes"][gid] };
            });
            o["subgroup-votes"].map(remapSubgroupStuff);
        }
        if (!_.isArray(o["subgroup-clusters"])) {
            o["subgroup-clusters"] = _.keys(o["subgroup-clusters"]).map(function (gid) {
                return { id: Number(gid), val: o["subgroup-clusters"][gid] };
            });
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
        function toObj(a) {
            var obj = {};
            if (!a) {
                return obj;
            }
            for (var i = 0; i < a.length; i++) {
                obj[a[i].id] = a[i].val;
                obj[a[i].id].id = a[i].id;
            }
            return obj;
        }
        function toArray(a) {
            if (!a) {
                return [];
            }
            return a.map(function (g) {
                var id = g.id;
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
    function getPca(zid, math_tick) {
        var cached = pcaCache.get(zid);
        if (cached && cached.expiration < Date.now()) {
            cached = null;
        }
        var cachedPOJO = cached && cached.asPOJO;
        if (cachedPOJO) {
            if (cachedPOJO.math_tick <= (math_tick || 0)) {
                INFO("mathpoll related", "math was cached but not new: zid=", zid, "cached math_tick=", cachedPOJO.math_tick, "query math_tick=", math_tick);
                return Promise.resolve(null);
            }
            else {
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
        var queryStart = Date.now();
        return pgQueryP_readOnly("select * from math_main where zid = ($1) and math_env = ($2);", [zid, Config.mathEnv]).then(function (rows) {
            var queryEnd = Date.now();
            var queryDuration = queryEnd - queryStart;
            addInRamMetric("pcaGetQuery", queryDuration);
            if (!rows || !rows.length) {
                INFO("mathpoll related; after cache miss, unable to find data for", {
                    zid: zid,
                    math_tick: math_tick,
                    math_env: Config.mathEnv
                });
                return null;
            }
            var item = rows[0].data;
            if (rows[0].math_tick) {
                item.math_tick = Number(rows[0].math_tick);
            }
            if (item.math_tick <= (math_tick || 0)) {
                INFO("mathpoll related", "after cache miss, unable to find newer item", zid, math_tick);
                return null;
            }
            INFO("mathpoll related", "after cache miss, found item, adding to cache", zid, math_tick);
            processMathObject(item);
            return updatePcaCache(zid, item).then(function (o) {
                return o;
            }, function (err) {
                return err;
            });
        });
    }
    function updatePcaCache(zid, item) {
        return new Promise(function (resolve, reject) {
            delete item.zid; // don't leak zid
            var asJSON = JSON.stringify(item);
            var buf = new Buffer(asJSON, "utf-8");
            zlib.gzip(buf, function (err, jsondGzipdPcaBuffer) {
                if (err) {
                    return reject(err);
                }
                var o = {
                    asPOJO: item,
                    asJSON: asJSON,
                    asBufferOfGzippedJson: jsondGzipdPcaBuffer,
                    expiration: Date.now() + 3000
                };
                // save in LRU cache, but don't update the lastPrefetchedMathTick
                pcaCache.set(zid, o);
                resolve(o);
            });
        });
    }
    function redirectIfHasZidButNoConversationId(req, res, next) {
        if (req.body.zid && !req.body.conversation_id) {
            winston.log("info", "redirecting old zid user to about page");
            res.writeHead(302, {
                Location: "https://pol.is/about"
            });
            return res.end();
        }
        return next();
    }
    function handle_GET_math_pca(req, res) {
        // migrated off this path, old clients were causing timeout issues by polling repeatedly without waiting for a
        // result for a previous poll.
        res.status(304).end();
    }
    // Cache the knowledge of whether there are any pca results for a given zid.
    // Needed to determine whether to return a 404 or a 304.
    // zid -> boolean
    var pcaResultsExistForZid = {};
    function handle_GET_math_pca2(req, res) {
        var zid = req.p.zid;
        var math_tick = req.p.math_tick;
        var ifNoneMatch = req.p.ifNoneMatch;
        if (ifNoneMatch) {
            if (!_.isUndefined(math_tick)) {
                return fail(res, 400, "Expected either math_tick param or If-Not-Match header, but not both.");
            }
            if (ifNoneMatch.includes("*")) {
                math_tick = 0;
            }
            else {
                var entries = ifNoneMatch.split(/ *, */).map(function (x) {
                    return Number(x
                        .replace(/^[wW]\//, "")
                        .replace(/^"/, "")
                        .replace(/"$/, ""));
                });
                // supporting multiple values for the ifNoneMatch header doesn't really make sense, so I've arbitrarily
                // chosen _.min to decide on one.
                math_tick = _.min(entries);
            }
        }
        else if (_.isUndefined(math_tick)) {
            math_tick = -1;
        }
        function finishWith304or404() {
            if (pcaResultsExistForZid[zid]) {
                res.status(304).end();
            }
            else {
                res.status(404).end();
            }
        }
        getPca(zid, math_tick)
            .then(function (data) {
            if (data) {
                // The buffer is gzipped beforehand to cut down on server effort in re-gzipping the same json string for each response.
                // We can't cache this endpoint on Cloudflare because the response changes too freqently, so it seems like the best way
                // is to cache the gzipped json'd buffer here on the server.
                res.set({
                    "Content-Type": "application/json",
                    "Content-Encoding": "gzip",
                    Etag: '"' + data.asPOJO.math_tick + '"'
                });
                res.send(data.asBufferOfGzippedJson);
            }
            else {
                // check whether we should return a 304 or a 404
                if (_.isUndefined(pcaResultsExistForZid[zid])) {
                    // This server doesn't know yet if there are any PCA results in the DB
                    // So try querying from -1
                    return getPca(zid, -1).then(function (data) {
                        var exists = !!data;
                        pcaResultsExistForZid[zid] = exists;
                        finishWith304or404();
                    });
                }
                else {
                    finishWith304or404();
                }
            }
        })["catch"](function (err) {
            fail(res, 500, err);
        });
    }
    function getZidForRid(rid) {
        return pgQueryP("select zid from reports where rid = ($1);", [rid]).then(function (row) {
            if (!row || !row.length) {
                return null;
            }
            return row[0].zid;
        });
    }
    function handle_POST_math_update(req, res) {
        var zid = req.p.zid;
        var uid = req.p.uid;
        var math_env = Config.mathEnv;
        var math_update_type = req.p.math_update_type;
        isModerator(zid, uid).then(function (hasPermission) {
            if (!hasPermission) {
                return fail(res, 500, "handle_POST_math_update_permission");
            }
            return pgQueryP("insert into worker_tasks (task_type, task_data, task_bucket, math_env) values ('update_math', $1, $2, $3);", [
                JSON.stringify({
                    zid: zid,
                    math_update_type: math_update_type
                }),
                zid,
                math_env,
            ])
                .then(function () {
                res.status(200).json({});
            })["catch"](function (err) {
                return fail(res, 500, "polis_err_POST_math_update", err);
            });
        });
    }
    function handle_GET_math_correlationMatrix(req, res) {
        var rid = req.p.rid;
        var math_env = Config.mathEnv;
        var math_tick = req.p.math_tick;
        console.log(req.p);
        function finishAsPending() {
            res.status(202).json({
                status: "pending"
            });
        }
        function hasCommentSelections() {
            return pgQueryP("select * from report_comment_selections where rid = ($1) and selection = 1;", [rid]).then(function (rows) {
                return rows.length > 0;
            });
        }
        var requestExistsPromise = pgQueryP("select * from worker_tasks where task_type = 'generate_report_data' and math_env=($2) " +
            "and task_bucket = ($1) " +
            // "and attempts < 3 " +
            "and (task_data->>'math_tick')::int >= ($3) " +
            "and finished_time is NULL;", [rid, math_env, math_tick]);
        var resultExistsPromise = pgQueryP("select * from math_report_correlationmatrix where rid = ($1) and math_env = ($2) and math_tick >= ($3);", [rid, math_env, math_tick]);
        Promise.all([resultExistsPromise, getZidForRid(rid)])
            .then(function (a) {
            var rows = a[0];
            var zid = a[1];
            if (!rows || !rows.length) {
                return requestExistsPromise.then(function (requests_rows) {
                    var shouldAddTask = !requests_rows || !requests_rows.length;
                    if (shouldAddTask) {
                        return hasCommentSelections().then(function (hasSelections) {
                            if (!hasSelections) {
                                return res.status(202).json({
                                    status: "polis_report_needs_comment_selection"
                                });
                            }
                            return pgQueryP("insert into worker_tasks (task_type, task_data, task_bucket, math_env) values ('generate_report_data', $1, $2, $3);", [
                                JSON.stringify({
                                    rid: rid,
                                    zid: zid,
                                    math_tick: math_tick
                                }),
                                rid,
                                math_env,
                            ]).then(finishAsPending);
                        });
                    }
                    finishAsPending();
                });
            }
            res.json(rows[0].data);
        })["catch"](function (err) {
            return fail(res, 500, "polis_err_GET_math_correlationMatrix", err);
        });
    }
    function doAddDataExportTask(math_env, email, zid, atDate, format, task_bucket) {
        return pgQueryP("insert into worker_tasks (math_env, task_data, task_type, task_bucket) values ($1, $2, 'generate_export_data', $3);", [
            math_env,
            {
                email: email,
                zid: zid,
                "at-date": atDate,
                format: format
            },
            task_bucket, // TODO hash the params to get a consistent number?
        ]);
    }
    if (Config.runPeriodicExportTests &&
        !devMode &&
        Config.mathEnv === "preprod") {
        var runExportTest = function () {
            var math_env = "prod";
            var email = Config.adminEmailDataExportTest;
            var zid = 12480;
            var atDate = Date.now();
            var format = "csv";
            var task_bucket = Math.abs((Math.random() * 999999999999) >> 0);
            doAddDataExportTask(math_env, email, zid, atDate, format, task_bucket).then(function () {
                setTimeout(function () {
                    pgQueryP("select * from worker_tasks where task_type = 'generate_export_data' and task_bucket = ($1);", [task_bucket]).then(function (rows) {
                        var ok = rows && rows.length;
                        var newOk;
                        if (ok) {
                            newOk = rows[0].finished_time > 0;
                        }
                        if (ok && newOk) {
                            console.log("runExportTest success");
                        }
                        else {
                            console.log("runExportTest failed");
                            emailBadProblemTime("Math export didn't finish.");
                        }
                    });
                }, 10 * 60 * 1000); // wait 10 minutes before verifying
            });
        };
        setInterval(runExportTest, 6 * 60 * 60 * 1000); // every 6 hours
    }
    function handle_GET_dataExport(req, res) {
        getUserInfoForUid2(req.p.uid)
            .then(function (user) {
            return doAddDataExportTask(Config.mathEnv, user.email, req.p.zid, req.p.unixTimestamp * 1000, req.p.format, Math.abs((Math.random() * 999999999999) >> 0))
                .then(function () {
                res.json({});
            })["catch"](function (err) {
                fail(res, 500, "polis_err_data_export123", err);
            });
        })["catch"](function (err) {
            fail(res, 500, "polis_err_data_export123b", err);
        });
    }
    function handle_GET_dataExport_results(req, res) {
        var url = s3Client.getSignedUrl("getObject", {
            Bucket: "polis-datadump",
            Key: Config.mathEnv + "/" + req.p.filename,
            Expires: 60 * 60 * 24 * 7
        });
        res.redirect(url);
    }
    function getBidIndexToPidMapping(zid, math_tick) {
        math_tick = math_tick || -1;
        return pgQueryP_readOnly("select * from math_bidtopid where zid = ($1) and math_env = ($2);", [zid, Config.mathEnv]).then(function (rows) {
            if (zid === 12480) {
                console.log("bidToPid", rows[0].data);
            }
            if (!rows || !rows.length) {
                // Could actually be a 404, would require more work to determine that.
                return new Error("polis_err_get_pca_results_missing");
            }
            else if (rows[0].data.math_tick <= math_tick) {
                return new Error("polis_err_get_pca_results_not_new");
            }
            else {
                return rows[0].data;
            }
        });
    }
    function handle_GET_bidToPid(req, res) {
        var zid = req.p.zid;
        var math_tick = req.p.math_tick;
        getBidIndexToPidMapping(zid, math_tick).then(function (doc) {
            var b2p = doc.bidToPid;
            res.json({
                bidToPid: b2p
            });
        }, function (err) {
            res.status(304).end();
        });
    }
    function getXids(zid) {
        return new MPromise("getXids", function (resolve, reject) {
            pgQuery_readOnly("select pid, xid from xids inner join " +
                "(select * from participants where zid = ($1)) as p on xids.uid = p.uid " +
                " where owner in (select org_id from conversations where zid = ($1));", [zid], function (err, result) {
                if (err) {
                    reject("polis_err_fetching_xids");
                    return;
                }
                resolve(result.rows);
            });
        });
    }
    function handle_GET_xids(req, res) {
        var uid = req.p.uid;
        var zid = req.p.zid;
        isOwner(zid, uid).then(function (owner) {
            if (owner) {
                getXids(zid).then(function (xids) {
                    res.status(200).json(xids);
                }, function (err) {
                    fail(res, 500, "polis_err_get_xids", err);
                });
            }
            else {
                fail(res, 403, "polis_err_get_xids_not_authorized");
            }
        }, function (err) {
            fail(res, 500, "polis_err_get_xids", err);
        });
    }
    function handle_POST_xidWhitelist(req, res) {
        var xid_whitelist = req.p.xid_whitelist;
        var len = xid_whitelist.length;
        var owner = req.p.uid;
        var entries = [];
        try {
            for (var i = 0; i < len; i++) {
                entries.push("(" + escapeLiteral(xid_whitelist[i]) + "," + owner + ")");
            }
        }
        catch (err) {
            return fail(res, 400, "polis_err_bad_xid", err);
        }
        pgQueryP("insert into xid_whitelist (xid, owner) values " +
            entries.join(",") +
            " on conflict do nothing;", [])
            .then(function (result) {
            res.status(200).json({});
        })["catch"](function (err) {
            return fail(res, 500, "polis_err_POST_xidWhitelist", err);
        });
    }
    function getBidsForPids(zid, math_tick, pids) {
        var dataPromise = getBidIndexToPidMapping(zid, math_tick);
        var mathResultsPromise = getPca(zid, math_tick);
        return Promise.all([dataPromise, mathResultsPromise]).then(function (items) {
            var b2p = items[0].bidToPid || []; // not sure yet if "|| []" is right here.
            var mathResults = items[1].asPOJO;
            function findBidForPid(pid) {
                var yourBidi = -1;
                for (var bidi = 0; bidi < b2p.length; bidi++) {
                    var pids_1 = b2p[bidi];
                    if (pids_1.indexOf(pid) !== -1) {
                        yourBidi = bidi;
                        break;
                    }
                }
                var yourBid = indexToBid[yourBidi];
                if (yourBidi >= 0 && _.isUndefined(yourBid)) {
                    console.error("polis_err_math_index_mapping_mismatch", "pid was", pid, "bidToPid was", JSON.stringify(b2p));
                    yell("polis_err_math_index_mapping_mismatch");
                    yourBid = -1;
                }
                return yourBid;
            }
            var indexToBid = mathResults["base-clusters"].id;
            var bids = pids.map(findBidForPid);
            var pidToBid = _.object(pids, bids);
            return pidToBid;
        });
    }
    function handle_GET_bid(req, res) {
        var uid = req.p.uid;
        var zid = req.p.zid;
        var math_tick = req.p.math_tick;
        var dataPromise = getBidIndexToPidMapping(zid, math_tick);
        var pidPromise = getPidPromise(zid, uid);
        var mathResultsPromise = getPca(zid, math_tick);
        Promise.all([dataPromise, pidPromise, mathResultsPromise])
            .then(function (items) {
            var b2p = items[0].bidToPid || []; // not sure yet if "|| []" is right here.
            var pid = items[1];
            var mathResults = items[2].asPOJO;
            if (pid < 0) {
                // NOTE: this API should not be called in /demo mode
                fail(res, 500, "polis_err_get_bid_bad_pid");
                return;
            }
            var indexToBid = mathResults["base-clusters"].id;
            var yourBidi = -1;
            for (var bidi = 0; bidi < b2p.length; bidi++) {
                var pids = b2p[bidi];
                if (pids.indexOf(pid) !== -1) {
                    yourBidi = bidi;
                    break;
                }
            }
            var yourBid = indexToBid[yourBidi];
            if (yourBidi >= 0 && _.isUndefined(yourBid)) {
                console.error("polis_err_math_index_mapping_mismatch", "pid was", pid, "bidToPid was", JSON.stringify(b2p));
                yell("polis_err_math_index_mapping_mismatch");
                yourBid = -1;
            }
            res.json({
                bid: yourBid
            });
        }, function (err) {
            res.status(304).end();
        })["catch"](function (err) {
            fail(res, 500, "polis_err_get_bid_misc", err);
        });
    }
    function handle_POST_auth_password(req, res) {
        var pwresettoken = req.p.pwresettoken;
        var newPassword = req.p.newPassword;
        getUidForPwResetToken(pwresettoken, function (err, userParams) {
            if (err) {
                console.error(err);
                fail(res, 500, "Password Reset failed. Couldn't find matching pwresettoken.", err);
                return;
            }
            var uid = Number(userParams.uid);
            Password.generateHashedPassword(newPassword, function (err, hashedPassword) {
                return pgQueryP("insert into jianiuevyew (uid, pwhash) values " +
                    "($1, $2) on conflict (uid) " +
                    "do update set pwhash = excluded.pwhash;", [uid, hashedPassword]).then(function (rows) {
                    res.status(200).json("Password reset successful.");
                    clearPwResetToken(pwresettoken, function (err) {
                        if (err) {
                            yell(err);
                            console.error("polis_err_auth_pwresettoken_clear_fail");
                        }
                    });
                }, function (err) {
                    console.error(err);
                    fail(res, 500, "Couldn't reset password.", err);
                });
            });
        });
    }
    var getServerNameWithProtocol = Config.getServerNameWithProtocol;
    function handle_POST_auth_pwresettoken(req, res) {
        var email = req.p.email;
        var server = getServerNameWithProtocol(req);
        // let's clear the cookies here, in case something is borked.
        clearCookies(req, res);
        function finish() {
            res
                .status(200)
                .json("Password reset email sent, please check your email.");
        }
        getUidByEmail(email).then(function (uid) {
            setupPwReset(uid, function (err, pwresettoken) {
                sendPasswordResetEmail(uid, pwresettoken, server, function (err) {
                    if (err) {
                        console.error(err);
                        fail(res, 500, "Error: Couldn't send password reset email.");
                        return;
                    }
                    finish();
                });
            });
        }, function () {
            sendPasswordResetEmailFailure(email, server);
            finish();
        });
    }
    // Email.sendPasswordResetEmailFailure;
    function getUidByEmail(email) {
        email = email.toLowerCase();
        return pgQueryP_readOnly("SELECT uid FROM users where LOWER(email) = ($1);", [email]).then(function (rows) {
            if (!rows || !rows.length) {
                throw new Error("polis_err_no_user_matching_email");
            }
            return rows[0].uid;
        });
    }
    function clearCookie(req, res, cookieName) {
        var _a, _b, _c;
        var origin = ((_a = req === null || req === void 0 ? void 0 : req.headers) === null || _a === void 0 ? void 0 : _a.origin) || "";
        if (domainOverride || origin.match(/^http:\/\/localhost:[0-9]{4}/)) {
            (_b = res === null || res === void 0 ? void 0 : res.clearCookie) === null || _b === void 0 ? void 0 : _b.call(res, cookieName, {
                path: "/"
            });
        }
        else {
            (_c = res === null || res === void 0 ? void 0 : res.clearCookie) === null || _c === void 0 ? void 0 : _c.call(res, cookieName, {
                path: "/",
                domain: ".pol.is"
            });
        }
    }
    function clearCookies(req, res) {
        var _a, _b, _c, _d;
        var origin = ((_a = req === null || req === void 0 ? void 0 : req.headers) === null || _a === void 0 ? void 0 : _a.origin) || "";
        var cookieName;
        if (domainOverride || origin.match(/^http:\/\/localhost:[0-9]{4}/)) {
            for (cookieName in req.cookies) {
                if (COOKIES_TO_CLEAR[cookieName]) {
                    (_b = res === null || res === void 0 ? void 0 : res.clearCookie) === null || _b === void 0 ? void 0 : _b.call(res, cookieName, {
                        path: "/"
                    });
                }
            }
        }
        else {
            for (cookieName in req.cookies) {
                if (COOKIES_TO_CLEAR[cookieName]) {
                    (_c = res === null || res === void 0 ? void 0 : res.clearCookie) === null || _c === void 0 ? void 0 : _c.call(res, cookieName, {
                        path: "/",
                        domain: ".pol.is"
                    });
                }
            }
        }
        winston.log("info", "after clear res set-cookie: " +
            JSON.stringify((_d = res === null || res === void 0 ? void 0 : res._headers) === null || _d === void 0 ? void 0 : _d["set-cookie"]));
    }
    function doCookieAuth(assigner, isOptional, req, res, next) {
        var token = req.cookies[COOKIES.TOKEN];
        getUserInfoForSessionToken(token, res, function (err, uid) {
            if (err) {
                clearCookies(req, res); // TODO_MULTI_DATACENTER_CONSIDERATION
                if (isOptional) {
                    next();
                }
                else {
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
    function hashStringToInt32(s) {
        var h = 1;
        if (typeof s !== "string" || !s.length) {
            return 99;
        }
        for (var i = 0; i < s.length; i++) {
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
    function handle_POST_metrics(req, res) {
        var enabled = false;
        if (!enabled) {
            return res.status(200).json({});
        }
        var pc = req.cookies[COOKIES.PERMANENT_COOKIE];
        var hashedPc = hashStringToInt32(pc);
        var uid = req.p.uid || null;
        var durs = req.p.durs.map(function (dur) {
            if (dur === -1) {
                dur = null;
            }
            return dur;
        });
        var clientTimestamp = req.p.clientTimestamp;
        var ages = req.p.times.map(function (t) {
            return clientTimestamp - t;
        });
        var now = Date.now();
        var timesInTermsOfServerTime = ages.map(function (a) {
            return now - a;
        });
        var len = timesInTermsOfServerTime.length;
        var entries = [];
        for (var i = 0; i < len; i++) {
            entries.push("(" +
                [
                    uid || "null",
                    req.p.types[i],
                    durs[i],
                    hashedPc,
                    timesInTermsOfServerTime[i],
                ].join(",") +
                ")");
        }
        pgQueryP("insert into metrics (uid, type, dur, hashedPc, created) values " +
            entries.join(",") +
            ";", [])
            .then(function (result) {
            res.json({});
        })["catch"](function (err) {
            fail(res, 500, "polis_err_metrics_post", err);
        });
    }
    function handle_GET_zinvites(req, res) {
        // if uid is not conversation owner, fail
        pgQuery_readOnly("SELECT * FROM conversations WHERE zid = ($1) AND owner = ($2);", [req.p.zid, req.p.uid], function (err, results) {
            if (err) {
                fail(res, 500, "polis_err_fetching_zinvite_invalid_conversation_or_owner", err);
                return;
            }
            if (!results || !results.rows) {
                res.writeHead(404);
                res.json({
                    status: 404
                });
                return;
            }
            pgQuery_readOnly("SELECT * FROM zinvites WHERE zid = ($1);", [req.p.zid], function (err, results) {
                if (err) {
                    fail(res, 500, "polis_err_fetching_zinvite_invalid_conversation_or_owner_or_something", err);
                    return;
                }
                if (!results || !results.rows) {
                    res.writeHead(404);
                    res.json({
                        status: 404
                    });
                    return;
                }
                res.status(200).json({
                    codes: results.rows
                });
            });
        });
    }
    function generateConversationURLPrefix() {
        // not 1 or 0 since they look like "l" and "O"
        return "" + _.random(2, 9);
    }
    function generateSUZinvites(numTokens) {
        return new Promise(function (resolve, reject) {
            generateToken(31 * numTokens, 
            // For now, pseodorandom bytes are probably ok. Anticipating API call will generate lots of these at once,
            // possibly draining the entropy pool. Revisit this if the otzinvites really need to be unguessable.
            true, function (err, longStringOfTokens) {
                if (err) {
                    reject(new Error("polis_err_creating_otzinvite"));
                    return;
                }
                winston.log("info", longStringOfTokens);
                var otzinviteArrayRegexMatch = longStringOfTokens === null || longStringOfTokens === void 0 ? void 0 : longStringOfTokens.match(/.{1,31}/g);
                // Base64 encoding expands to extra characters, so trim to the number of tokens we want.
                var otzinviteArray = otzinviteArrayRegexMatch === null || otzinviteArrayRegexMatch === void 0 ? void 0 : otzinviteArrayRegexMatch.slice(0, numTokens);
                otzinviteArray = otzinviteArray === null || otzinviteArray === void 0 ? void 0 : otzinviteArray.map(function (suzinvite) {
                    return generateConversationURLPrefix() + suzinvite;
                });
                winston.log("info", otzinviteArray);
                resolve(otzinviteArray);
            });
        });
    }
    function handle_POST_zinvites(req, res) {
        var generateShortUrl = req.p.short_url;
        pgQuery("SELECT * FROM conversations WHERE zid = ($1) AND owner = ($2);", [req.p.zid, req.p.uid], function (err, results) {
            if (err) {
                fail(res, 500, "polis_err_creating_zinvite_invalid_conversation_or_owner", err);
                return;
            }
            generateAndRegisterZinvite(req.p.zid, generateShortUrl)
                .then(function (zinvite) {
                res.status(200).json({
                    zinvite: zinvite
                });
            })["catch"](function (err) {
                fail(res, 500, "polis_err_creating_zinvite", err);
            });
        });
    }
    function checkZinviteCodeValidity(zid, zinvite, callback) {
        pgQuery_readOnly("SELECT * FROM zinvites WHERE zid = ($1) AND zinvite = ($2);", [zid, zinvite], function (err, results) {
            if (err || !results || !results.rows || !results.rows.length) {
                callback(1);
            }
            else {
                callback(null); // ok
            }
        });
    }
    var zidToConversationIdCache = new LruCache({
        max: 1000
    });
    function getZinvite(zid, dontUseCache) {
        var cachedConversationId = zidToConversationIdCache.get(zid);
        if (!dontUseCache && cachedConversationId) {
            return Promise.resolve(cachedConversationId);
        }
        return pgQueryP_metered("getZinvite", "select * from zinvites where zid = ($1);", [zid]).then(function (rows) {
            var conversation_id = (rows && rows[0] && rows[0].zinvite) || void 0;
            if (conversation_id) {
                zidToConversationIdCache.set(zid, conversation_id);
            }
            return conversation_id;
        });
    }
    function getZinvites(zids) {
        if (!zids.length) {
            return Promise.resolve(zids);
        }
        zids = _.map(zids, function (zid) {
            return Number(zid); // just in case
        });
        zids = _.uniq(zids);
        var uncachedZids = zids.filter(function (zid) {
            return !zidToConversationIdCache.get(zid);
        });
        var zidsWithCachedConversationIds = zids
            .filter(function (zid) {
            return !!zidToConversationIdCache.get(zid);
        })
            .map(function (zid) {
            return {
                zid: zid,
                zinvite: zidToConversationIdCache.get(zid)
            };
        });
        function makeZidToConversationIdMap(arrays) {
            var zid2conversation_id = {};
            arrays.forEach(function (a) {
                a.forEach(function (o) {
                    zid2conversation_id[o.zid] = o.zinvite;
                });
            });
            return zid2conversation_id;
        }
        return new MPromise("getZinvites", function (resolve, reject) {
            if (uncachedZids.length === 0) {
                resolve(makeZidToConversationIdMap([zidsWithCachedConversationIds]));
                return;
            }
            pgQuery_readOnly("select * from zinvites where zid in (" +
                uncachedZids.join(",") +
                ");", [], function (err, result) {
                if (err) {
                    reject(err);
                }
                else {
                    resolve(makeZidToConversationIdMap([
                        result.rows,
                        zidsWithCachedConversationIds,
                    ]));
                }
            });
        });
    }
    function addConversationId(o, dontUseCache) {
        if (!o.zid) {
            // if no zid, resolve without fetching zinvite.
            return Promise.resolve(o);
        }
        return getZinvite(o.zid, dontUseCache).then(function (conversation_id) {
            o.conversation_id = conversation_id;
            return o;
        });
    }
    function addConversationIds(a) {
        var zids = [];
        for (var i = 0; i < a.length; i++) {
            if (a[i].zid) {
                zids.push(a[i].zid);
            }
        }
        if (!zids.length) {
            return Promise.resolve(a);
        }
        return getZinvites(zids).then(function (zid2conversation_id) {
            return a.map(function (o) {
                o.conversation_id = zid2conversation_id[o.zid];
                return o;
            });
        });
    }
    function finishOne(res, o, dontUseCache, altStatusCode) {
        addConversationId(o, dontUseCache)
            .then(function (item) {
            // ensure we don't expose zid
            if (item.zid) {
                delete item.zid;
            }
            var statusCode = altStatusCode || 200;
            res.status(statusCode).json(item);
        }, function (err) {
            fail(res, 500, "polis_err_finishing_responseA", err);
        })["catch"](function (err) {
            fail(res, 500, "polis_err_finishing_response", err);
        });
    }
    function finishArray(res, a) {
        addConversationIds(a)
            .then(function (items) {
            // ensure we don't expose zid
            if (items) {
                for (var i = 0; i < items.length; i++) {
                    if (items[i].zid) {
                        delete items[i].zid;
                    }
                }
            }
            res.status(200).json(items);
        }, function (err) {
            fail(res, 500, "polis_err_finishing_response2A", err);
        })["catch"](function (err) {
            fail(res, 500, "polis_err_finishing_response2", err);
        });
    }
    function checkSuzinviteCodeValidity(zid, suzinvite, callback) {
        pgQuery("SELECT * FROM suzinvites WHERE zid = ($1) AND suzinvite = ($2);", [zid, suzinvite], function (err, results) {
            if (err || !results || !results.rows || !results.rows.length) {
                callback(1);
            }
            else {
                callback(null); // ok
            }
        });
    }
    function getSUZinviteInfo(suzinvite) {
        return new Promise(function (resolve, reject) {
            pgQuery("SELECT * FROM suzinvites WHERE suzinvite = ($1);", [suzinvite], function (err, results) {
                if (err) {
                    return reject(err);
                }
                if (!results || !results.rows || !results.rows.length) {
                    return reject(new Error("polis_err_no_matching_suzinvite"));
                }
                resolve(results.rows[0]);
            });
        });
    }
    function deleteSuzinvite(suzinvite) {
        return new Promise(function (resolve, reject) {
            pgQuery("DELETE FROM suzinvites WHERE suzinvite = ($1);", [suzinvite], function (err, results) {
                if (err) {
                    // resolve, but complain
                    yell("polis_err_removing_suzinvite");
                }
                resolve();
            });
        });
    }
    function xidExists(xid, owner, uid) {
        return pgQueryP("select * from xids where xid = ($1) and owner = ($2) and uid = ($3);", [xid, owner, uid]).then(function (rows) {
            return rows && rows.length;
        });
    }
    function createXidEntry(xid, owner, uid) {
        return new Promise(function (resolve, reject) {
            pgQuery("INSERT INTO xids (uid, owner, xid) VALUES ($1, $2, $3);", [uid, owner, xid], function (err, results) {
                if (err) {
                    console.error(err);
                    reject(new Error("polis_err_adding_xid_entry"));
                    return;
                }
                resolve();
            });
        });
    }
    function saveParticipantMetadataChoicesP(zid, pid, answers) {
        return new Promise(function (resolve, reject) {
            saveParticipantMetadataChoices(zid, pid, answers, function (err) {
                if (err) {
                    reject(err);
                }
                else {
                    resolve(0);
                }
            });
        });
    }
    function saveParticipantMetadataChoices(zid, pid, answers, callback) {
        // answers is a list of pmaid
        if (!answers || !answers.length) {
            // nothing to save
            return callback(0);
        }
        var q = "select * from participant_metadata_answers where zid = ($1) and pmaid in (" +
            answers.join(",") +
            ");";
        pgQuery(q, [zid], function (err, qa_results) {
            if (err) {
                winston.log("info", "adsfasdfasd");
                return callback(err);
            }
            qa_results = qa_results.rows;
            qa_results = _.indexBy(qa_results, "pmaid");
            // construct an array of params arrays
            answers = answers.map(function (pmaid) {
                var pmqid = qa_results[pmaid].pmqid;
                return [zid, pid, pmaid, pmqid];
            });
            // make simultaneous requests to insert the choices
            async.map(answers, function (x, cb) {
                pgQuery("INSERT INTO participant_metadata_choices (zid, pid, pmaid, pmqid) VALUES ($1,$2,$3,$4);", x, function (err, results) {
                    if (err) {
                        winston.log("info", "sdkfuhsdu");
                        return cb(err);
                    }
                    cb(0);
                });
            }, function (err) {
                if (err) {
                    winston.log("info", "ifudshf78ds");
                    return callback(err);
                }
                // finished with all the inserts
                callback(0);
            });
        });
    }
    function createParticpantLocationRecord(zid, uid, pid, lat, lng, source) {
        return pgQueryP("insert into participant_locations (zid, uid, pid, lat, lng, source) values ($1,$2,$3,$4,$5,$6);", [zid, uid, pid, lat, lng, source]);
    }
    var LOCATION_SOURCES = {
        Twitter: 400,
        Facebook: 300,
        HTML5: 200,
        IP: 100,
        manual_entry: 1
    };
    function getUsersLocationName(uid) {
        return Promise.all([
            pgQueryP_readOnly("select * from facebook_users where uid = ($1);", [
                uid,
            ]),
            pgQueryP_readOnly("select * from twitter_users where uid = ($1);", [uid]),
        ]).then(function (o) {
            var fb = o[0] && o[0][0];
            var tw = o[1] && o[1][0];
            if (fb && _.isString(fb.location)) {
                return {
                    location: fb.location,
                    source: LOCATION_SOURCES.Facebook
                };
            }
            else if (tw && _.isString(tw.location)) {
                return {
                    location: tw.location,
                    source: LOCATION_SOURCES.Twitter
                };
            }
            return null;
        });
    }
    function populateParticipantLocationRecordIfPossible(zid, uid, pid) {
        INFO("asdf1", zid, uid, pid);
        getUsersLocationName(uid)
            .then(function (locationData) {
            if (!locationData) {
                INFO("asdf1.nope");
                return;
            }
            INFO(locationData);
            geoCode(locationData.location)
                .then(function (o) {
                createParticpantLocationRecord(zid, uid, pid, o.lat, o.lng, locationData.source)["catch"](function (err) {
                    if (!isDuplicateKey(err)) {
                        yell("polis_err_creating_particpant_location_record");
                        console.error(err);
                    }
                });
            })["catch"](function (err) {
                yell("polis_err_geocoding_01");
                console.error(err);
            });
        })["catch"](function (err) {
            yell("polis_err_fetching_user_location_name");
            console.error(err);
        });
    }
    function updateLastInteractionTimeForConversation(zid, uid) {
        return pgQueryP("update participants set last_interaction = now_as_millis(), nsli = 0 where zid = ($1) and uid = ($2);", [zid, uid]);
    }
    function populateGeoIpInfo(zid, uid, ipAddress) {
        var userId = Config.maxmindUserID;
        var licenseKey = Config.maxmindLicenseKey;
        var url = "https://geoip.maxmind.com/geoip/v2.1/city/";
        var contentType = "application/vnd.maxmind.com-city+json; charset=UTF-8; version=2.1";
        // "city" is     $0.0004 per query
        // "insights" is $0.002  per query
        var insights = false;
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
                Authorization: "Basic " +
                    new Buffer(userId + ":" + licenseKey, "utf8").toString("base64")
            }
        })
            .then(function (response) {
            var parsedResponse = JSON.parse(response);
            console.log("BEGIN MAXMIND RESPONSE");
            console.log(response);
            console.log("END MAXMIND RESPONSE");
            return pgQueryP("update participants_extended set modified=now_as_millis(), country_iso_code=($4), encrypted_maxmind_response_city=($3), " +
                "location=ST_GeographyFromText('SRID=4326;POINT(" +
                parsedResponse.location.latitude +
                " " +
                parsedResponse.location.longitude +
                ")'), latitude=($5), longitude=($6) where zid = ($1) and uid = ($2);", [
                zid,
                uid,
                encrypt(response),
                parsedResponse.country.iso_code,
                parsedResponse.location.latitude,
                parsedResponse.location.longitude,
            ]);
        });
    }
    // SECOND_QUARTER;
    // SECOND_HALF;
}
