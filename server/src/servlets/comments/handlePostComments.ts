function handle_POST_comments(
  req: {
    p: {
      zid?: any;
      uid?: any;
      txt?: any;
      pid?: any;
      vote?: any;
      twitter_tweet_id?: any;
      quote_twitter_screen_name?: any;
      quote_txt?: any;
      quote_src_url?: any;
      anon?: any;
      is_seed?: any;
    };
    headers?: Headers;
    connection?: { remoteAddress: any; socket: { remoteAddress: any } };
    socket?: { remoteAddress: any };
  },
  res: { json: (arg0: { tid: any; currentPid: any }) => void }
) {
  const zid = req.p.zid;
  const xid = void 0; //req.p.xid;
  let uid = req.p.uid;
  let txt = req.p.txt;
  let pid = req.p.pid; // PID_FLOW may be undefined
  let currentPid = pid;
  const vote = req.p.vote;
  const twitter_tweet_id = req.p.twitter_tweet_id;
  const quote_twitter_screen_name = req.p.quote_twitter_screen_name;
  const quote_txt = req.p.quote_txt;
  const quote_src_url = req.p.quote_src_url;
  const anon = req.p.anon;
  const is_seed = req.p.is_seed;
  const mustBeModerator = !!quote_txt || !!twitter_tweet_id || anon;

  // either include txt, or a tweet id
  if (
    (_.isUndefined(txt) || txt === "") &&
    (_.isUndefined(twitter_tweet_id) || twitter_tweet_id === "") &&
    (_.isUndefined(quote_txt) || quote_txt === "")
  ) {
    fail(res, 400, "polis_err_param_missing_txt");
    return;
  }

  if (quote_txt && _.isUndefined(quote_src_url)) {
    fail(res, 400, "polis_err_param_missing_quote_src_url");
    return;
  }

  function doGetPid() {
    // PID_FLOW
    if (_.isUndefined(pid)) {
      return getPidPromise(req.p.zid, req.p.uid, true).then((pid: number) => {
        if (pid === -1) {
          return addParticipant(req.p.zid, req.p.uid).then(function (
            rows: any[]
          ) {
            const ptpt = rows[0];
            pid = ptpt.pid;
            currentPid = pid;
            return pid;
          });
        } else {
          return pid;
        }
      });
    }
    return Promise.resolve(pid);
  }
  let twitterPrepPromise = Promise.resolve();
  if (twitter_tweet_id) {
    twitterPrepPromise = prepForTwitterComment(twitter_tweet_id, zid);
  } else if (quote_twitter_screen_name) {
    twitterPrepPromise = prepForQuoteWithTwitterUser(
      quote_twitter_screen_name,
      zid
    );
  }

  twitterPrepPromise
    .then(
      function (info: { ptpt: any; tweet: any }) {
        const ptpt = info && info.ptpt;
        // let twitterUser = info && info.twitterUser;
        const tweet = info && info.tweet;

        if (tweet) {
          txt = tweet.text;
        } else if (quote_txt) {
          txt = quote_txt;
        }

        const ip =
          // TODO This header may contain multiple IP addresses. Which should we report?
          req?.headers?.["x-forwarded-for"] ||
          req?.connection?.remoteAddress ||
          req?.socket?.remoteAddress ||
          req?.connection?.socket.remoteAddress;

        const isSpamPromise = isSpam({
          comment_content: txt,
          comment_author: uid,
          permalink: "https://pol.is/" + zid,
          user_ip: ip,
          user_agent: req?.headers?.["user-agent"],
          referrer: req?.headers?.referer,
        });
        isSpamPromise.catch(function (err: any) {
          winston.log("info", err);
        });
        const isModeratorPromise = isModerator(zid, uid);

        const conversationInfoPromise = getConversationInfo(zid);

        let shouldCreateXidRecord = false;

        let pidPromise;
        if (ptpt) {
          pidPromise = Promise.resolve(ptpt.pid);
        } else {
          const xidUserPromise =
            !_.isUndefined(xid) && !_.isNull(xid)
              ? getXidStuff(xid, zid)
              : Promise.resolve();
          pidPromise = xidUserPromise.then(
            (xidUser: UserType | "noXidRecord") => {
              shouldCreateXidRecord = xidUser === "noXidRecord";
              if (typeof xidUser === "object") {
                uid = xidUser.uid;
                pid = xidUser.pid;
                return pid;
              } else {
                return doGetPid().then((pid: any) => {
                  if (shouldCreateXidRecord) {
                    return createXidRecordByZid(zid, uid, xid).then(() => {
                      return pid;
                    });
                  }
                  return pid;
                });
              }
            }
          );
        }

        const commentExistsPromise = commentExists(zid, txt);

        return; // RETURN PROMISE_ALL_THEN;
      },
      function (err: any) {
        fail(res, 500, "polis_err_fetching_tweet", err);
      }
    )
    .catch(function (err: any) {
      fail(res, 500, "polis_err_post_comment_misc", err);
    });
  }

// handleGetVotesMe;

