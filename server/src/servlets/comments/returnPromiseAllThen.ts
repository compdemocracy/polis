

return Promise.all([
  pidPromise,
  conversationInfoPromise,
  isModeratorPromise,
  commentExistsPromise,
]).then(
  function (results: any[]) {

    const pid = results[0];
    const conv = results[1];
    const is_moderator = results[2];
    const commentExists = results[3];

    if (!is_moderator && mustBeModerator) {
      fail(res, 403, "polis_err_post_comment_auth");
      return;
    }

    if (pid < 0) {
      // NOTE: this API should not be called in /demo mode
      fail(res, 500, "polis_err_post_comment_bad_pid");
      return;
    }

    if (commentExists) {
      fail(res, 409, "polis_err_post_comment_duplicate");
      return;
    }

    if (!conv.is_active) {
      fail(res, 403, "polis_err_conversation_is_closed");
      return;
    }

    if (_.isUndefined(txt)) {
      throw "polis_err_post_comments_missing_txt";
    }
    const bad = hasBadWords(txt);

    return isSpamPromise
      .then(
        function (spammy: any) {
          winston.log(
            "info",
            "spam test says: " +
              txt +
              " " +
              (spammy ? "spammy" : "not_spammy")
          );
          return spammy;
        },
        function (err: any) {
          winston.log("info", err);
          return false; // spam check failed, continue assuming "not spammy".
        }
      )
      .then(function (spammy: any) {
        const velocity = 1;
        let active = true;
        const classifications = [];
        if (bad && conv.profanity_filter) {
          active = false;
          classifications.push("bad");
        }
        if (spammy && conv.spam_filter) {
          active = false;
          classifications.push("spammy");
        }
        if (conv.strict_moderation) {
          active = false;
        }

        let mod = 0; // hasn't yet been moderated.

        // moderators' comments are automatically in (when prepopulating).
        if (is_moderator && is_seed) {
          mod = polisTypes.mod.ok;
          active = true;
        }
        const authorUid = ptpt ? ptpt.uid : uid;

        Promise.all([detectLanguage(txt)]).then((a: any[]) => {
          const detections = a[0];
          const detection = Array.isArray(detections)
            ? detections[0]
            : detections;
          const lang = detection.language;
          const lang_confidence = detection.confidence;

          return pgQueryP(
            "INSERT INTO COMMENTS " +
              "(pid, zid, txt, velocity, active, mod, uid, tweet_id, quote_src_url, anon, is_seed, created, tid, lang, lang_confidence) VALUES " +
              "($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, default, null, $12, $13) RETURNING *;",
            [
              pid,
              zid,
              txt,
              velocity,
              active,
              mod,
              authorUid,
              twitter_tweet_id || null,
              quote_src_url || null,
              anon || false,
              is_seed || false,
              lang,
              lang_confidence,
            ]
          ).then(
            function (docs: any[]) {
              const comment = docs && docs[0];
              const tid = comment && comment.tid;

              if (bad || spammy || conv.strict_moderation) {
                getNumberOfCommentsWithModerationStatus(
                  zid,
                  polisTypes.mod.unmoderated
                )
                  .catch(function (err: any) {
                    yell("polis_err_getting_modstatus_comment_count");
                    return void 0;
                  })
                  .then(function (n: number) {
                    if (n === 0) {
                      return;
                    }
                    pgQueryP_readOnly(
                      "select * from users where site_id = (select site_id from page_ids where zid = ($1)) UNION select * from users where uid = ($2);",
                      [zid, conv.owner]
                    ).then(function (users: any) {
                      const uids = _.pluck(users, "uid");
                      // also notify polis team for moderation
                      uids.forEach(function (uid?: any) {
                        sendCommentModerationEmail(req, uid, zid, n);
                      });
                    });
                  });
              } else {
                addNotificationTask(zid);
              }

              // It should be safe to delete this. Was added to postpone the no-auto-vote change for old conversations.
              if (is_seed && _.isUndefined(vote) && zid <= 17037) {
                vote = 0;
              }

              let createdTime = comment.created;
              const votePromise = _.isUndefined(vote)
                ? Promise.resolve()
                : votesPost(uid, pid, zid, tid, vote, 0, false);

              return (
                votePromise
                  .then(
                    function (o: { vote: { created: any } }) {
                      if (o && o.vote && o.vote.created) {
                        createdTime = o.vote.created;
                      }

                      setTimeout(function () {
                        updateConversationModifiedTime(
                          zid,
                          createdTime
                        );
                        updateLastInteractionTimeForConversation(
                          zid,
                          uid
                        );
                        if (!_.isUndefined(vote)) {
                          updateVoteCount(zid, pid);
                        }
                      }, 100);
                      res.json({
                        tid: tid,
                        currentPid: currentPid,
                      });
                    },
                    function (err: any) {
                      fail(res, 500, "polis_err_vote_on_create", err);
                    }
                  )
              );
            },
            function (err: { code: string | number }) {
              if (err.code === "23505" || err.code === 23505) {
                // duplicate comment
                fail(
                  res,
                  409,
                  "polis_err_post_comment_duplicate",
                  err
                );
              } else {
                fail(res, 500, "polis_err_post_comment", err);
              }
            }
          ); // insert
        }); // lang
      });
  },

  function (errors: any[]) {
    if (errors[0]) {
      fail(res, 500, "polis_err_getting_pid", errors[0]);
      return;
    }
    if (errors[1]) {
      fail(res, 500, "polis_err_getting_conv_info", errors[1]);
      return;
    }
  }
);