// Copyright (C) 2012-present, The Authors. This program is free software: you can redistribute it and/or  modify it under the terms of the GNU Affero General Public License, version 3, as published by the Free Software Foundation. This program is distributed in the hope that it will be useful, but WITHOUT ANY WARRANTY; without even the implied warranty of MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the GNU Affero General Public License for more details. You should have received a copy of the GNU Affero General Public License along with this program.  If not, see <http://www.gnu.org/licenses/>.

var eb = require("../eventBus");
var deepcopy = require("deepcopy");
var PostMessageUtils = require("../util/postMessageUtils");
var preloadHelper = require("../util/preloadHelper");
var Utils = require("../util/utils");
var Net = require("../util/net");
var $ = require("jquery");
var _ = require("lodash");
var d3 = require("../3rdparty/d3.v4.min");

var PTPOI_BID_OFFSET = 1e10;

var polisPost = Net.polisPost;
var polisPut = Net.polisPut;
var polisGet = Net.polisGet;

module.exports = function (params) {
  var polisTypes = {
    reactions: {
      push: 1,
      pull: -1,
      pass: 0,
      trash: "trash",
      see: "see"
    },
    staractions: {
      unstar: 0,
      star: 1
    }
  };
  window.polisTypes = polisTypes;

  var commentsToVoteOn = {}; // tid -> comment

  var votesPath = "api/v3/votes";
  var starsPath = "api/v3/stars";
  var trashesPath = "api/v3/trashes";
  var commentsPath = "api/v3/comments";
  var nextCommentPath = "api/v3/nextComment";
  var finishedTutorialPath = "api/v3/tutorial";

  var pcaPath = "api/v3/math/pca2";
  var votesFamousPath = "api/v3/votes/famous";
  var bidiToPidsPath = "api/v3/bidToPid";

  var conversationsPath = "api/v3/conversations";
  var convSubPath = "api/v3/convSubscriptions";

  var particpantGeoLocationsPath = "api/v3/locations";

  var queryParticipantsByMetadataPath = "api/v3/query_participants_by_metadata";

  var ptptCommentModPath = "api/v3/ptptCommentMod";
  var participants_extended_path = "api/v3/participants_extended";

  var xidsPath = "api/v3/xids";

  var logger = params.logger;

  var lastServerTokenForPCA = -1;
  var lastServerTokenForComments = -1;
  var lastServerTokenForBidiToPid = -1;

  var initReadyCallbacks = $.Callbacks();
  var authStateChangeCallbacks = $.Callbacks();
  var personUpdateCallbacks = $.Callbacks();
  var commentsAvailableCallbacks = $.Callbacks();

  var firstPcaCallPromise = $.Deferred();
  var firstSuccessfulPcaCallPromise = $.Deferred();
  var clustersCachePromise = $.Deferred();
  var votesForTidBidPromise = $.Deferred();

  var projectionPeopleCache = [];
  var bigBuckets = [];
  var bidToBigBucket = {};
  var clustersCache = {};
  var participantsOfInterestVotes = null;
  var participantsOfInterestBids = [];
  var groupVotes = null;
  var nextCommentCache = null;

  var consensusComments = null;

  var modOutTids = {};

  // collections
  var votesByMe = params.votesByMe;
  if (Utils.isDemoMode()) {
    votesByMe.trigger("change", votesByMe);
  }

  var pcX = {};
  var pcY = {};
  var pcaCenter;
  var repness; // gid -> [{data about most representative comments}]
  var votesForTidBid = {}; // tid -> bid -> {A: agree count, B: disagree count}
  var participantCount = 0;
  var bidToPids = {};
  var pidToBidCache = null;
  var myBid;
  var cachedPcaData = void 0;
  var pollingScheduledCallbacks = [];
  var tokenStore = params.tokenStore;
  var conversation_id = params.conversation_id;
  var myPid = -1;
  eb.on(eb.pidChange, function (newPid) {
    myPid = newPid;
    prepAndSendVisData();
  });
  var USE_JETPACK_FOR_SELF = false; //(myPid % 2 === 1); // AB test where odd pids get jetpack
  var usePreloadMath = true;
  var usePreloadFamous = true;

  function removeEmptyBucketsFromClusters(clusters) {
    var buckets = projectionPeopleCache;
    for (var i = 0; i < buckets.length; i++) {
      var bucket = buckets[i];
      if (
        bucket.count <= 0 &&
        !bucket.containsSelf // but don't remove PTPTOIs from cluster
      ) {
        for (var gid = 0; gid < clusters.length; gid++) {
          removeItemFromArray(bucket.bid, clusters[gid].members);
        }
      }
    }
  }

  function moveTowards(x, y, dest, howFar) {
    if (!dest) {
      return {
        x: x,
        y: y
      };
    }
    var vectorToCentroidX = dest[0] - x;
    var vectorToCentroidY = dest[1] - y;
    var adjustedVectorX = vectorToCentroidX * howFar;
    var adjustedVectorY = vectorToCentroidY * howFar;
    return {
      x: x + adjustedVectorX,
      y: y + adjustedVectorY
    };
  }

  function getClusters() {
    var clusters = deepcopy(clustersCache);
    removeEmptyBucketsFromClusters(clusters);

    for (var i = 0; i < clusters.length; i++) {
      clusters[i]["n-members"] = cachedPcaData["group-votes"][i]["n-members"];
    }
    return clusters;
  }

  // TODO rename
  function syncAllCommentsForCurrentStimulus() {
    // more like sync?
    var dfd = $.Deferred();
    var params = {
      lastServerToken: new Date(0).getTime(),
      not_voted_by_pid: myPid,
      conversation_id: conversation_id
      //?
    };

    function fail() {
      dfd.reject(0);
    }
    getComments(params).then(
      function (comments) {
        if (!comments) {
          logger.log("no new comments for stimulus");
          dfd.resolve(0);
          return;
        }
        var IDs = _.map(comments, "tid");
        var oldkeys = _.keys(commentsToVoteOn).map(function (tid) {
          return parseInt(tid, 10);
        });
        var newIDs = _.difference(IDs, oldkeys);
        comments.forEach(function (ev) {
          var d = ev.created;
          if (d > lastServerTokenForComments) {
            lastServerTokenForComments = d;
          }
        });
        var newComments = comments.filter(function (ev) {
          return _.includes(newIDs, ev.tid);
        });
        for (var i = 0; i < newComments.length; i++) {
          var tid = newComments[i].tid;
          var alreadyVotedOn = !!votesByMe.findWhere({
            tid: tid
          });
          if (!alreadyVotedOn) {
            commentsToVoteOn[tid] = newComments[i];
          }
        }
        var numComments = _.keys(commentsToVoteOn).length;
        if (numComments) {
          commentsAvailableCallbacks.fire();
          dfd.resolve(numComments);
        } else {
          fail();
        }
        // }, fail);
      },
      function (err) {
        logger.error("failed to fetch comments");
        logger.dir(err);
        fail();
      }
    );
    return dfd.promise();
  }

  function getNextComment(o) {
    var params = {
      not_voted_by_pid: myPid,
      limit: 1,
      conversation_id: conversation_id
    };

    if (Utils.uiLanguage()) {
      params.lang = Utils.uiLanguage();
    }

    if (Utils.isDemoMode()) {
      params.without = _.map(votesByMe, "tid");
    }

    if (o && !_.isUndefined(o.notTid)) {
      // Don't return the comment that's currently showing.
      // We expect the server to know what we've voted on,
      // but not what client is currently viewing.
      if (!params.without) {
        params.without = [];
      }
      params.without.push(o.notTid);
    }

    var p = polisGet(nextCommentPath, params);
    p.then(function (c) {
      if (c && c.created) {
        nextCommentCache = c;
      } else {
        nextCommentCache = null;
      }
      if (c && !_.isUndefined(c.currentPid)) {
        processPidResponse(c.currentPid);
      }
    });
    return p;
  }

  function submitComment(model) {
    if (Utils.isDemoMode()) {
      return $.Deferred().resolve().promise();
    }

    model = $.extend(model, {
      // server will find the pid
      conversation_id: conversation_id,
      agid: 1
    });

    if (typeof model.txt !== "string" || model.txt.length === 0) {
      logger.error("bad comment");
      return $.Deferred().reject("Invalid comment text.").promise();
    }

    // Fire the POST request, but do not return its promise chain to the caller.
    polisPost(commentsPath, model)
      .done(function (response) {
        // This code runs when the background POST successfully completes.
        setTimeout(PostMessageUtils.postCommentEvent);

        // PID_FLOW
        if (!_.isUndefined(response.currentPid)) {
          processPidResponse(response.currentPid);
        }
      })
      .fail(function (jqXHR, textStatus, errorThrown) {
        logger.error("Background comment submission failed:", textStatus, errorThrown);
      });

    // Immediately return a new, resolved promise to the caller
    // to signal that the action was "successful" from the user's perspective.
    return $.Deferred().resolve().promise();
  }

  function clearComment(tid) {
    delete commentsToVoteOn[tid];
  }

  function processPidResponse(returnedPid) {
    if (returnedPid !== myPid) {
      console.log(`[PID Update] Changing from ${myPid} to ${returnedPid}`);

      // Validate the new PID
      if (!_.isNumber(returnedPid) || returnedPid < -1) {
        console.error("[PID Update] ERROR: Invalid PID received:", returnedPid);
        return;
      }

      myPid = returnedPid;
      eb.trigger(eb.pidChange, returnedPid);
    }
  }

  function disagree(commentId, starred, high_priority) {
    clearComment(commentId, "push");
    var o = {
      high_priority: high_priority,
      vote: polisTypes.reactions.push,
      tid: commentId
    };
    if (!_.isUndefined(starred)) {
      o.starred = starred;
    }
    return react(o);
  }

  // returns promise {nextComment: {tid:...}} or {} if no further comments
  function react(params) {
    if (params.conversation_id && params.conversation_id !== conversation_id) {
      if (params.vote !== polisTypes.reactions.see) {
        console.error("wrong stimulus");
      }
    }
    if (typeof params.tid === "undefined") {
      console.error("missing tid");
      console.error(params);
    }
    if (Utils.isDemoMode()) {
      return getNextComment({
        notTid: params.tid // Also don't show the comment that was just voted on.
      }).then(function (c) {
        var o = {};
        if (c && c.created) {
          o.nextComment = c;
          nextCommentCache = c;
        } else {
          nextCommentCache = null;
        }
        return o;
      });
    }

    if (Utils.uiLanguage()) {
      params = $.extend(
        {
          lang: Utils.uiLanguage()
        },
        params
      );
    }

    var promise = polisPost(
      votesPath,
      $.extend({}, params, {
        pid: myPid,
        conversation_id: conversation_id,
        agid: 1
      })
    );
    promise = promise.then(function (response) {
      // Handle JWT token from response
      if (response.auth && response.auth.token) {
        // Store the JWT token for future requests
        var PolisStorage = require("../util/polisStorage");
        PolisStorage.setJwtToken(response.auth.token);
      }

      // PID_FLOW
      if (!_.isUndefined(response.currentPid)) {
        processPidResponse(response.currentPid);
      }
      var c = response.nextComment;
      if (c && c.translations && c.translations.length) {
        c.translations = Utils.getBestTranslation(c.translations, Utils.uiLanguage());
      }
      return response;
    });

    return promise;
  }

  function agree(commentId, starred, high_priority) {
    clearComment(commentId);
    var o = {
      high_priority: high_priority,
      vote: polisTypes.reactions.pull,
      tid: commentId
    };
    if (!_.isUndefined(starred)) {
      o.starred = starred;
    }
    return react(o);
  }

  function pass(tid, starred, high_priority) {
    clearComment(tid);
    var o = {
      high_priority: high_priority,
      vote: polisTypes.reactions.pass,
      tid: tid
    };
    if (!_.isUndefined(starred)) {
      o.starred = starred;
    }
    return react(o);
  }

  function trash(tid) {
    clearComment(tid, "trash");

    if (Utils.isDemoMode()) {
      return $.Deferred().resolve();
    }

    return polisPost(trashesPath, {
      tid: tid,
      trashed: 1,
      conversation_id: conversation_id
    });
  }

  function doStarAction(params) {
    if (params.conversation_id && params.conversation_id !== conversation_id) {
      console.error("wrong stimulus");
    }
    if (typeof params.tid === "undefined") {
      console.error("missing tid");
      console.error(params);
    }
    if (typeof params.starred === "undefined") {
      console.error("missing star type");
      console.error(params);
    }

    if (Utils.isDemoMode()) {
      return $.Deferred().resolve();
    }

    return polisPost(
      starsPath,
      $.extend({}, params, {
        conversation_id: conversation_id
      })
    );
  }

  function unstar(tid) {
    return doStarAction({
      starred: polisTypes.staractions.unstar,
      tid: tid
    });
  }

  function star(tid) {
    return doStarAction({
      starred: polisTypes.staractions.star,
      tid: tid
    });
  }

  function mod(tid, flags) {
    return polisPost(ptptCommentModPath, {
      conversation_id: conversation_id,
      tid: tid,
      spam: !!flags.spam,
      offtopic: !!flags.offtopic,
      important: !!flags.important
    });
  }

  function invite(xids) {
    return polisPost("api/v3/users/invite", {
      single_use_tokens: true,
      conversation_id: conversation_id,
      xids: xids
    });
  }

  function Bucket() {
    if (_.isNumber(arguments[0])) {
      console.error("error 324");
    } else {
      var o = arguments[0];
      this.bid = o.id || o.bid;
      this.gid = o.gid;
      this.count = o.count;
      if (o.clusterCount) {
        // TODO stop with this pattern
        this.clusterCount = o.clusterCount; // TODO stop with this pattern
      }
      if (!_.isUndefined(o.ptptoiCount)) {
        // TODO stop with this pattern
        this.ptptoiCount = o.ptptoiCount; // TODO stop with this pattern
      }
      if (o.containsSelf) {
        // TODO stop with this pattern
        this.containsSelf = true; // TODO stop with this pattern
      }
      if (o.ptptoi) {
        // TODO stop with this pattern
        this.ptptoi = true; // TODO stop with this pattern
      }
      this.priority = o.priority || 0;

      if (o.isSummaryBucket) {
        // TODO stop with this pattern
        this.isSummaryBucket = true; // TODO stop with this pattern
        if (_.isUndefined(o.gid)) {
          console.error("bug ID 'cricket'");
        }
      }
      this.proj = o.proj;

      if (!_.isUndefined(o.gid)) {
        // TODO stop with this pattern
        this.gid = parseInt(o.gid); // TODO stop with this pattern
      }

      this.pic = o.pic;
      this.picture_size = o.picture_size;
    }
  }

  Bucket.prototype.containsPid = function (pid) {
    if (!this.ppl) {
      // TODO dfd
      return false;
    }
    for (var i = 0; i < this.ppl.length; i++) {
      if (this.ppl[i].pid === pid) {
        return true;
      }
    }
    return false;
  };

  Bucket.prototype.getPeople = function () {
    // return getUserInfoByBid(this.bid);
    // TODO make service call instead.
    var dfd = $.Deferred();
    if (this.ppl) {
      dfd.resolve(this.ppl);
    } else {
      dfd.resolve([
        {
          pid: 123,
          email: "person1@att.net"
        },
        {
          pid: 234,
          email: "person2@att.net"
        }
      ]);
    }
    return dfd.promise();
  };

  function bucketizeSelf(self, selfDotBid) {
    var bucket = new Bucket({
      priority: 999999,
      containsSelf: true,
      gid: self.gid,
      proj: self.proj,
      count: 1,
      bid: selfDotBid,
      pic: Utils.getAnonPicUrl(),
      picture_size: -1
    });
    return bucket;
  }

  function bucketizeParticipantOfInterest(o, ptptoiData) {
    if (!ptptoiData.picture_size) {
      if (ptptoiData.isSelf) {
        ptptoiData.picture_size = 48;
      } else {
        ptptoiData.picture_size = 48; // just set it for now
        // console.error('missing picture_size', ptptoiData);
      }
    }
    var bucket = new Bucket({
      priority: ptptoiData.priority,
      pic: ptptoiData.picture,
      picture_size: ptptoiData.picture_size,
      containsSelf: o.containsSelf,
      gid: o.gid,
      ptptoi: true,
      proj: o.proj,
      count: 1,
      bid: ptptoiData.fakeBid
    });
    return bucket;
  }

  function getBidToGid(clusters) {
    var bidToGid = {};
    clusters = clusters || getClusters(); // TODO cleanup
    var gids = _.keys(clusters);
    for (var g = 0; g < gids.length; g++) {
      var gid = Number(gids[g]);
      var cluster = clusters[gid];
      for (var i = 0; i < cluster.members.length; i++) {
        var bid = cluster.members[i];
        bidToGid[bid] = gid;
      }
    }
    return bidToGid;
  }

  function doFindRepresentativeMetadata(choices, p2b, b2g) {
    var groupedChoices = _.groupBy(choices, "pmqid");
    var questionsWithAnswersWithChoices = {};
    _.each(groupedChoices, function (choicesForQuestion, pmqid) {
      var allChoicesForAnswer = _.groupBy(choicesForQuestion, "pmaid");
      var allChoicesForAnswerGrouped = {};
      _.each(allChoicesForAnswer, function (choices) {
        _.each(choices, function (c) {
          c.bid = p2b[c.pid];
          c.gid = b2g[c.bid];
        });
      });
      var counts = {};
      _.each(allChoicesForAnswer, function (choices, pmaid) {
        var groupedAnswers = _.groupBy(choices, "gid");
        allChoicesForAnswerGrouped[pmaid] = groupedAnswers;
        counts[pmaid] = {};
        _.each(groupedAnswers, function (answersForGroup, gid) {
          counts[pmaid][gid] = answersForGroup.length;
        });
      });
      questionsWithAnswersWithChoices[pmqid] = {
        groups: allChoicesForAnswerGrouped,
        counts: counts
      };
    });

    return questionsWithAnswersWithChoices;
  }

  function findRepresentativeMetadata() {
    return $.when(getPidToBidMappingFromCache(), getXids(), clustersCachePromise).then(
      function (
        // answersResponse,
        choicesResponse,
        mappings,
        _xids,
        _foo
      ) {
        var choices = choicesResponse[0];
        var p2b = mappings.p2b;
        var b2g = getBidToGid();

        return doFindRepresentativeMetadata(choices, p2b, b2g);
      }
    );
  }

  function getXids() {
    return polisGet(xidsPath, {
      conversation_id: conversation_id
    });
  }

  function getXidToPid() {
    return getXids().then(function (items) {
      var x2p = {};
      for (var i = 0; i < items.length; i++) {
        x2p[items[i].xid] = items[i].pid;
      }
      return x2p;
    });
  }

  // TODO account for "N/A", "null", etc
  // returns {
  //     info : [ {name: "city", cardinality: 2, type: "string"},...]
  //     rows : [ [data,...],...]
  //     xids : [xid for row 0, xid for row 1, ...]
  // }
  function parseMetadataFromCSV(rawCsvFile) {
    return getXidToPid().then(
      function (x2p) {
        var notNumberColumns = [];
        var notIntegerColumns = [];
        var valueSets = [];
        var rows = d3.csv.parseRows(rawCsvFile);
        var rowCount = rows.length;
        var colCount = rows[0].length;
        var xidsUnaccounted = {};
        var xidHash = {};

        // Check row lengths
        for (var r = 0; r < rowCount; r++) {
          if (rows[r].length !== colCount) {
            console.error("row length does not match length of first row. (for row number " + r + ")");
            return;
          }
        }

        // Remove redundant columns (from a SQL join, for example)
        function columnsEqual(a, b) {
          for (var r = 0; r < rowCount; r++) {
            var row = rows[r];
            if (row[a] !== row[b]) {
              return false;
            }
          }
          return true;
        }
        var duplicateColumns = [];
        for (var c = 0; c < colCount - 1; c++) {
          for (var d = c + 1; d < colCount; d++) {
            if (columnsEqual(c, d)) {
              duplicateColumns.push({
                name: rows[0][d],
                col: d
              });
            }
          }
        }
        if (duplicateColumns.length) {
          console.error("removing duplicate columns: " + _.map(duplicateColumns, "name"));
        }
        // Remove duplicate columns
        (function () {
          for (var r = 0; r < rowCount; r++) {
            var row = rows[r];
            for (var d = 0; d < duplicateColumns.length; d++) {
              row.splice(duplicateColumns[d].col, 1);
            }
          }
        })();
        colCount = rows[0].length;

        // Replace the column names in the 0th row with objects with metadata.
        (function () {
          for (var c = 0; c < colCount; c++) {
            rows[0][c] = {
              name: rows[0][c],
              type: "integer", // may be disproven and become "float" or "string"
              cardinality: 0
            };
          }
        })();

        _.each(x2p, function (pid, xid) {
          xidsUnaccounted[xid] = true;
          xidHash[xid] = true;
        });

        var xidsFoundPerColumn = [];
        (function () {
          for (var c = 0; c < colCount; c++) {
            xidsFoundPerColumn[c] = 0;
            valueSets[c] = {};
          }
        })();
        // determine xid column
        (function () {
          for (var r = 0; r < rowCount; r++) {
            var row = rows[r];
            if (r > 0) {
              for (var c = 0; c < colCount; c++) {
                var cell = row[c];

                // Determine the columns where the xids are
                if (xidHash[cell]) {
                  xidsFoundPerColumn[c] += 1;
                }
                if (xidsUnaccounted[cell]) {
                  // Mark the xid as seen
                  delete xidsUnaccounted[cell];
                }
              }
            }
          }
        })();

        if (_.size(xidsUnaccounted)) {
          console.error(
            "The attached data-source is missing data on participants with these xids: " + xidsUnaccounted.join(" ")
          );
        }

        // Find the Xid Column
        var xidColumn = 0;

        function argMaxForIndexOrKey(items) {
          var max = -Infinity;
          var maxArg = null;
          _.each(items, function (val, arg) {
            if (val > max) {
              max = val;
              maxArg = arg;
            }
          });
          return {
            arg: maxArg,
            max: max
          };
        }

        var o = argMaxForIndexOrKey(xidsFoundPerColumn);
        xidColumn = o.arg;
        var maxXidCount = o.max;
        if (maxXidCount === 0) {
          console.error("xid column missing, please be sure to include a column with xids");
          return;
        }

        // TODO check xidsUnaccounted within this column only.
        console.error("the xid column appears to be called " + rows[0][xidColumn].name);

        // Remove extra rows (which have no corresponsing xids)
        rows = _.filter(rows, function (row) {
          var xid = row[xidColumn];
          return !_.isUndefined(x2p[xid]);
        });
        rowCount = rows.length;

        (function () {
          for (var r = 0; r < rowCount; r++) {
            var row = rows[r];
            if (r > 0) {
              for (var c = 0; c < colCount; c++) {
                var cell = row[c];
                // find the cardinality
                valueSets[c][cell] = true;

                // determine if the columns can be parsed as numbers
                if (notNumberColumns[c]) {
                  continue;
                }
                var n = parseFloat(cell);
                var nInt = parseInt(cell);
                if (isNaN(n)) {
                  notNumberColumns[c] = true;
                  notIntegerColumns[c] = true;
                } else if (n !== nInt) {
                  notIntegerColumns[c] = true;
                }
              }
            }
          }
        })();

        // Assign Cardinality
        _.each(valueSets, function (values, c) {
          rows[0][c].cardinality = _.keys(values).length;
        });

        // Assing Types
        _.each(notIntegerColumns, function (isNotInt, c) {
          var isNumber = !notNumberColumns[c];
          if (isNotInt) {
            if (isNumber) {
              rows[0][c].type = "float";
            } else {
              rows[0][c].type = "string";
            }
          }
        });

        var hasNumericalColumns = false;
        (function () {
          for (var c = 0; c < colCount; c++) {
            var isNumberColumn = !notNumberColumns[c];
            if (isNumberColumn) {
              hasNumericalColumns = true;
              break;
            }
          }
        })();
        if (hasNumericalColumns) {
          (function () {
            for (var r = 0; r < rowCount; r++) {
              var row = rows[r];
              if (r > 0) {
                for (var ci = 0; ci < colCount; ci++) {
                  if (!notNumberColumns[ci]) {
                    row[ci] = parseFloat(row[ci]);
                    if (isNaN(row[ci])) {
                      console.error(
                        'expected number for cell with value "' +
                          row[ci] +
                          '" in column named "' +
                          rows[0][ci].name +
                          '"'
                      );
                    }
                  }
                }
              }
            }
          })();
        }
        // Remove xid column
        var xids = [];
        for (var ri = 0; ri < rowCount; ri++) {
          var xid = rows[ri].splice(xidColumn, 1)[0];
          xids.push(xid);
        }
        var infoRow = rows.shift();
        xids.shift(); // Remove the info row for the xid column

        var pids = _.map(xids, function (xid) {
          return x2p[xid];
        });

        var result = {
          info: infoRow,
          rows: rows,
          xids: xids,
          pids: pids
        };
        return result;
      },
      function (err) {
        console.error(err);
      }
    );
  }

  function getMathMain() {
    return cachedPcaData;
  }

  function fetchLatestPca() {
    return fetchPca(pcaPath, lastServerTokenForPCA);
  }

  function fetchPca(path, timestamp) {
    if (Utils.isHidden() && firstPcaCallPromise.state() === "resolved") {
      // Don't poll when the document isn't visible. (and we've already fetched the pca)
      return $.Deferred().reject();
    }

    function fetchIt() {
      return polisGet(
        path,
        {
          // math_tick: timestamp,
          conversation_id: conversation_id,
          cacheBust: (Math.random() * 1e9) >> 0
        },
        {
          "If-None-Match": '"' + timestamp + '"'
        }
      );
    }

    var promise;
    if (usePreloadMath) {
      promise = preloadHelper.firstMathPromise.pipe(function (pcaData) {
        usePreloadMath = false;
        if (pcaData) {
          return $.Deferred().resolve(pcaData, null, {
            status: 200
          });
        }
        return fetchIt();
      }, fetchIt);
    } else {
      promise = fetchIt();
    }

    var p2 = promise.then(
      function (pcaData, textStatus, xhr) {
        usePreloadMath = false;
        if (304 === xhr.status) {
          // not nodified
          firstPcaCallPromise.resolve();
          return $.Deferred().reject();
        }
        cachedPcaData = pcaData;

        if (_.isNumber(pcaData.math_tick)) {
          lastServerTokenForPCA = pcaData.math_tick;
        }
        consensusComments = pcaData.consensus;
        groupVotes = pcaData["group-votes"];

        modOutTids = {};
        var modOut = pcaData["mod-out"];
        if (modOut) {
          modOut.forEach(function (x) {
            modOutTids[x] = true;
          });
        }

        return getFamousVotes()
          .then(function () {
            if (!pcaData.pca) {
              return $.Deferred().reject("missing pca");
            }
            // Check for missing comps... TODO solve
            if (!pcaData.pca.comps) {
              return $.Deferred().reject("missing pca comps");
            }
            var buckets = arraysToObjects(pcaData["base-clusters"]);
            participantCount = sum(pcaData["base-clusters"].count);
            repness = pcaData["repness"];

            eb.trigger(eb.participantCount, participantCount);
            if (_.isNumber(pcaData.voteCount)) {
              eb.trigger(eb.voteCount, pcaData.voteCount);
            }

            pcX = pcaData.pca.comps[0];
            pcY = pcaData.pca.comps[1];
            pcaCenter = pcaData.pca.center;

            // in case of malformed PCs (seen on conversations with only one comment)
            pcX = pcX || [];
            pcY = pcY || [];

            // gid -> {members: [bid1, bid2, ...], ...}
            var clusters = _.keyBy(pcaData["group-clusters"], "id");

            var bidToGid = getBidToGid(clusters);
            var bucketPerGroup = {};
            _.each(buckets, function (bucket) {
              var gid = bidToGid[bucket.id];
              bucketPerGroup[gid] = bucketPerGroup[gid] || [];
              bucketPerGroup[gid].push(bucket);
              bucket.gid = gid;
            });

            bidToBigBucket = {};
            bigBuckets = _.map(bucketPerGroup, function (bucketsForGid, gid) {
              gid = parseInt(gid);
              var bigBucket = _.reduce(
                bucketsForGid,
                function (o, bucket) {
                  if (_.includes(participantsOfInterestBids, bucket.id)) {
                    return o;
                  }
                  o.count += bucket.count;
                  o.bids.push(bucket.id); // not currently consumed by vis
                  o.id = o.id + "_" + bucket.id; // TODO not sure, but this is proof-of-concept code
                  return o;
                },
                {
                  members: [],
                  id: "bigBucketBid_",
                  bids: [],
                  gid: gid,
                  count: 0, // total ptpt count
                  clusterCount: groupVotes[gid]["n-members"],
                  x: clusters[gid].center[0],
                  y: clusters[gid].center[1],
                  isSummaryBucket: true
                }
              );
              for (var i = 0; i < bigBucket.bids.length; i++) {
                bidToBigBucket[bigBucket.bids[i]] = bigBucket.id;
              }
              clusters[gid].members = _.union(clusters[gid].members, [bigBucket.id]);
              return bigBucket;
            });

            // remove the buckets that only contain a ptptoi
            buckets = _.filter(buckets, function (b) {
              var hasPtptOI = _.includes(participantsOfInterestBids, b.id);
              if (hasPtptOI) {
                if (b.count === 1) {
                  return false;
                }
              }
              return true;
            });

            // mutate - move x and y into a proj sub-object, so the vis can animate x and y
            _.each(buckets, function (b) {
              b.proj = {
                x: b.x,
                y: b.y
              };
              delete b.x;
              delete b.y;
            });

            // Convert to Bucket objects.
            buckets = _.map(buckets, function (b) {
              return new Bucket(b);
            });

            // ----------------- AGAIN for bigBuckets ---------------------
            _.each(bigBuckets, function (b) {
              b.proj = {
                x: b.x,
                y: b.y
              };
              delete b.x;
              delete b.y;
            });

            // Convert to Bucket objects.
            bigBuckets = _.map(bigBuckets, function (b) {
              return new Bucket(b);
            });

            // -------------- PROCESS VOTES INFO --------------------------
            var gidToBigBucketId = {};
            _.each(bigBuckets, function (b) {
              gidToBigBucketId[b.gid] = b.bid;
            });
            votesForTidBid = {};
            // Collect all unique tids from all groups to be robust
            var allTids = {};
            if (groupVotes) {
              _.each(groupVotes, function (groupData) {
                if (groupData && groupData.votes) {
                  _.each(groupData.votes, function (voteData, tid) {
                    allTids[tid] = true;
                  });
                }
              });
            }

            _.each(_.keys(allTids), function (tid) {
              var A = {};
              var D = {};
              var S = {};
              _.each(clusters, function (cluster) {
                var gid = cluster.id;
                var bigBucketBid = gidToBigBucketId[gid];
                // Safely access nested properties, defaulting to 0
                A[bigBucketBid] = _.get(groupVotes, [gid, "votes", tid, "A"], 0);
                D[bigBucketBid] = _.get(groupVotes, [gid, "votes", tid, "D"], 0);
                S[bigBucketBid] = _.get(groupVotes, [gid, "votes", tid, "S"], 0);
              });
              votesForTidBid[tid] = {
                A: A,
                D: D,
                S: S
              };
            });

            votesForTidBidPromise.resolve(); // NOTE this may already be resolved.

            // -------------- END PROCESS VOTES INFO --------------------------

            var temp = removeSelfFromBucketsAndClusters(buckets, clusters);
            buckets = temp.buckets;
            clustersCache = temp.clusters;

            projectionPeopleCache = buckets;
            clustersCachePromise.resolve();

            return null;
          })
          .fail(function (err) {
            console.warn("[Polis] Error in PCA processing:", err);
          });
      },
      function (xhr) {
        if (404 === xhr.status) {
          firstPcaCallPromise.resolve();
        } else if (500 === xhr.status) {
          console.error("Error in PCA request:", xhr);
        }
      }
    );

    p2.then(function () {
      firstPcaCallPromise.resolve();
      firstSuccessfulPcaCallPromise.resolve();
    });
    return p2;
  }

  function removeItemFromArray(bid, cluster) {
    var index = cluster.indexOf(bid);
    if (index >= 0) {
      cluster = cluster.splice(index, 1);
    }
    return cluster;
  }

  function removeSelfFromBucketsAndClusters(buckets, clusters) {
    for (var b = 0; b < buckets.length; b++) {
      var bucket = buckets[b];

      // remove PTPTOIs from their buckets
      for (var i = 0; i < participantsOfInterestBids.length; i++) {
        if (participantsOfInterestBids.indexOf(bucket.bid) >= 0) {
          // Don't decrement if this participant is self, since we subtract for the blue dot below
          if (bucket.bid !== myBid) {
            bucket.count -= 1;
          }
        }
      }

      // remove self
      if (bucket.bid === myBid) {
        bucket.count -= 1;
      }
    }
    return {
      buckets: buckets,
      clusters: clusters
    };
  }

  function arraysToObjects(objWithArraysAsProperties) {
    var objects = [];
    var len = -1;
    for (var k in objWithArraysAsProperties) {
      var nextLen = objWithArraysAsProperties[k].length;
      if (len !== -1 && len !== nextLen) {
        console.error("mismatched lengths");
      }
      len = nextLen;
    }
    for (var i = 0; i < len; i++) {
      var o = {};
      for (var key in objWithArraysAsProperties) {
        o[key] = objWithArraysAsProperties[key][i];
      }
      objects.push(o);
    }
    return objects;
  }

  function withProjectedSelf(people) {
    people = people || [];

    var alreadyHaveSelfDot = _.some(people, function (p) {
      return p.containsSelf;
    });
    if (!alreadyHaveSelfDot) {
      people = _.clone(people); // shallow copy
      people.unshift(bucketizeSelf(projectSelf(), -1));
    }
    return people;
  }

  function withParticipantsOfInterest(people, clusters) {
    if (!participantsOfInterestVotes) {
      return {
        buckets: people,
        clusters: clusters
      };
    }
    people = people || [];
    people = _.clone(people); // shallow copy

    var bidToGid = getBidToGid();
    _.each(participantsOfInterestVotes, function (ptpt, pid) {
      var magicPid = Number(pid) + 10000000000;
      var gid = bidToGid[magicPid];
      var votesVectorInAscii_adpu_format = ptpt.votes || "";
      pid = parseInt(pid);

      // pid += 1000000000; // TODO figure out what bids to assign to ptptoi buckets, these fake pids are currently used for that
      var temp = projectParticipant(pid, votesVectorInAscii_adpu_format);
      temp.gid = gid;
      var p = bucketizeParticipantOfInterest(temp, ptpt);
      people.push(p);
    });

    function averageTheThings(items, getter) {
      var total = 0;
      _.each(items, function (item) {
        var val = getter(item);
        total += val;
      });
      return total / items.length;
    }

    var bidToNode = _.keyBy(people, "bid");

    function getxy(bid, dim) {
      var node = bidToNode[bid];
      if (!node) {
        console.error("missing node for bid: " + bid);
        return 0;
      }
      return node.proj[dim];
    }

    function getX(bid) {
      return getxy(bid, "x");
    }

    function getY(bid) {
      return getxy(bid, "y");
    }

    function getBigBucketForGroup(gid) {
      for (var i = 0; i < people.length; i++) {
        var isBigBucket = false;
        if ("string" === typeof people[i].bid) {
          if (people[i].bid.match(/^bigBucketBid/)) {
            isBigBucket = true;
          }
        }
        if (isBigBucket && people[i].gid === gid) {
          return people[i];
        }
      }
      return null;
    }

    _.each(clusters, function (cluster) {
      var ptptoiMembers = cluster.members.filter(function (bid) {
        return bid >= 10000000000; // magicPid
      });
      // use the center of the ptpois if possible
      var centerX = averageTheThings(ptptoiMembers, getX);
      var centerY = averageTheThings(ptptoiMembers, getY);
      // otherwise, just use the center of the cluster, since there are no ptptois
      if (_.isNaN(centerX)) {
        centerX = cluster.center[0];
      }
      if (_.isNaN(centerY)) {
        centerY = cluster.center[1];
      }
      var associatedBigBucket = getBigBucketForGroup(cluster.id);
      associatedBigBucket.proj.x = centerX;
      associatedBigBucket.proj.y = centerY;
    });

    return {
      buckets: people,
      clusters: clusters
    };
  }

  function sendUpdatedVisData(people, clusters, participantCount, projectedComments) {
    // make deep copy so the vis doesn't muck with the model
    people = _.map(people, function (p) {
      var deep = true;
      return $.extend(deep, {}, p);
    });
    personUpdateCallbacks.fire(people || [], clusters || [], participantCount, projectedComments);
  }

  function authenticated() {
    return !!tokenStore.get();
  }

  function getCommentsForProjection(params) {
    var ascending = params.sort > 0;
    var count = params.count;
    var projection = params.projection;

    function compare(a, b) {
      if (ascending) {
        return a.projection[projection] - b.projection[projection];
      } else {
        return b.projection[projection] - a.projection[projection];
      }
    }

    var comments;
    return polisGet(pcaPath, {
      conversation_id: conversation_id
    })
      .pipe(function (pcaData) {
        comments = pcaData.pca.principal_components;
        var keys = _.keys(comments);
        comments = keys.map(function (key) {
          return {
            id: key,
            projection: comments[key]
          };
        });
        comments.sort(compare);
        if (count >= 0) {
          comments = comments.slice(0, count);
        }
        return comments;
      })
      .pipe(function (commentIds) {
        return getComments(
          commentIds.map(function (comment) {
            return comment.id;
          })
        );
      })
      .pipe(function (results) {
        // they arrive out of order, so map results onto the array that has the right ordering.
        return comments.map(function (comment) {
          return results.find((r) => r.tid === comment.id);
        });
      });
  }

  function sum(arrayOfNumbers) {
    var count = 0;
    var len = arrayOfNumbers.length;
    for (var i = 0; i < len; i++) {
      count += arrayOfNumbers[i];
    }
    return count;
  }

  function getFancyComments(options) {
    options = $.extend(options, { translate: true, lang: navigator.language });
    return $.when(getComments(options), votesForTidBidPromise).then(function (args /* , dont need second arg */) {
      var comments = args[0];
      // don't need args[1], just used as a signal

      // votesForTidBid should be defined since votesForTidBidPromise has resolved.
      return _.map(comments, function (x) {
        // Count the agrees and disagrees for each comment.
        var bidToVote = votesForTidBid[x.tid];
        if (bidToVote) {
          x.A = sum(_.values(bidToVote.A));
          x.D = sum(_.values(bidToVote.D));
        } else {
          x.A = 0;
          x.D = 0;
        }
        return _.clone(x);
      });
    });
  }

  function getComments(params) {
    params = $.extend(
      {
        conversation_id: conversation_id
        // not_pid: getPid() // don't want to see own coments
      },
      params
    );
    return polisGet(commentsPath, params);
  }

  function getLocations(gid) {
    return polisGet(particpantGeoLocationsPath, {
      conversation_id: conversation_id,
      gid: gid
    });
  }

  function getTidsForConsensus() {
    if (!consensusComments) {
      return [];
    }
    var x = [];
    if (consensusComments.agree && consensusComments.agree.length) {
      var agrees = _.map(consensusComments.agree, function (c) {
        c.a = true;
        return c;
      });
      Array.prototype.push.apply(x, agrees);
    }
    if (consensusComments.disagree && consensusComments.disagree.length) {
      var disagrees = _.map(consensusComments.disagree, function (c) {
        c.d = true;
        return c;
      });
      Array.prototype.push.apply(x, disagrees);
    }
    return x;
  }

  function getTidsForGroup(gid) {
    var dfd = $.Deferred();
    // delay since clustersCache might not be populated yet.
    $.when(votesForTidBidPromise, clustersCachePromise).done(function () {
      var tidToR = _.keyBy(repness[gid], "tid");
      var tids = _.map(repness[gid], "tid");

      // resolve deferred
      dfd.resolve({
        tidToR: tidToR,
        tids: tids
      });
    });
    return dfd.promise();
  }

  function getReactionsToComment(tid) {
    var dfd = $.Deferred();

    votesForTidBidPromise.then(function () {
      var buckets = $.extend({}, votesForTidBid[tid]);

      _.each(participantsOfInterestVotes, function (o, pid) {
        pid = parseInt(pid);
        if (!o.votes || pid === myPid) {
          return;
        }
        var votesVectorInAscii_adpu_format = o.votes;
        var voteForPtpoi = votesVectorInAscii_adpu_format[tid];
        if (voteForPtpoi === "a") {
          // buckets.A[pid] = buckets.A[pid] || {};
          buckets.A[o.fakeBid] = 1;
          buckets.D[o.fakeBid] = 0;
        }
        if (voteForPtpoi === "d") {
          // buckets.D[pid] = buckets.D[pid] || {};
          buckets.A[o.fakeBid] = 0;
          buckets.D[o.fakeBid] = 1;
        }
        if (voteForPtpoi === "u") {
          buckets.S[o.fakeBid] = 0; // unseen
        } else {
          buckets.S[o.fakeBid] = 1; // seen
        }
        // buckets[o.fakeBid] = votesVectorInAscii_adpu_format[tid];
      });
      var myVotes = votesByMe.filter(function (vote) {
        return tid === vote.get("tid");
      });
      buckets.A[myBid] =
        _.filter(myVotes, function (v) {
          return v.get("vote") === polisTypes.reactions.pull;
        }).length > 0
          ? 1
          : 0;
      buckets.D[myBid] =
        _.filter(myVotes, function (v) {
          return v.get("vote") === polisTypes.reactions.push;
        }).length > 0
          ? 1
          : 0;
      buckets.S[myBid] =
        buckets.A[myBid] ||
        buckets.D[myBid] ||
        _.filter(myVotes, function (v) {
          return v.get("vote") === polisTypes.reactions.pass;
        }).length > 0
          ? 1
          : 0;

      // TODO reduce vote count for the bucket self is in.
      if (!buckets) {
        console.warn("no votes found for tid: " + tid);
        buckets = {
          A: [],
          D: [],
          S: []
        };
      }
      dfd.resolve(buckets);
    });
    return dfd.promise();
  }

  function createConversation(title, body) {
    return polisPost(conversationsPath, {
      title: title,
      body: body
    });
  }

  function getConversations() {
    return polisGet(conversationsPath, {});
  }

  function queryParticipantsByMetadata(pmaids) {
    return polisPost(queryParticipantsByMetadataPath, {
      pmaids: pmaids,
      conversation_id: conversation_id
    });
  }

  // basic defaultdict implementation
  function DD(f) {
    this.m = {};
    this.f = f;
  }
  // basic defaultarray implementation
  function DA(f) {
    this.m = [];
    this.f = f;
  }
  DD.prototype.g = DA.prototype.g = function (k) {
    if (Object.prototype.hasOwnProperty.call(this.m, k)) {
      return this.m[k];
    }
    var v = this.f(k);
    this.m[k] = v;
    return v;
  };
  DD.prototype.s = DA.prototype.s = function (k, v) {
    this.m[k] = v;
  };

  function getFamousVotes() {
    var o = {
      conversation_id: conversation_id,
      math_tick: lastServerTokenForPCA
    };
    var promise = usePreloadFamous ? preloadHelper.firstFamousPromise : polisGet(votesFamousPath, o);

    return promise.then(function (x) {
      usePreloadFamous = false;
      x = x || {};
      // assign fake bids for these projected participants
      _.each(x, function (ptpt, pid) {
        pid = parseInt(pid);
        // should be safe to say there aren't 10 billion buckets, so we can use this range
        var bucketId = pid + PTPOI_BID_OFFSET;
        if (pid === myPid) {
          myBid = bucketId;
        }
        ptpt.fakeBid = bucketId;

        // default anon picture, may be overwritten
        ptpt.picture = Utils.getAnonPicUrl();
        ptpt.picture_size = 48;

        if (ptpt.xInfo) {
          ptpt.picture = ptpt.xInfo.x_profile_image_url;
          ptpt.picture_size = 48;
        }

        // override with custom polis picture if they have it
        if (ptpt.polis) {
          ptpt.picture = ptpt.polis.polis_pic;
        }
      });
      participantsOfInterestVotes = x;
      participantsOfInterestBids = _.map(_.values(participantsOfInterestVotes), "bid");
    });
  }

  function projectSelf() {
    var votesToUseForProjection = votesByMe.map(function (v) {
      return {
        vote: v.get("vote"),
        tid: v.get("tid")
      };
    });
    return project({
      pid: myPid,
      isBlueDot: true,
      votes: votesToUseForProjection
    });
  }

  function projectParticipant(pid, votesVectorInAscii_adpu_format) {
    var votesToUseForProjection = [];
    if (pid === myPid) {
      votesToUseForProjection = votesByMe.map(function (v) {
        return {
          vote: v.get("vote"),
          tid: v.get("tid")
        };
      });
    } else {
      var len = votesVectorInAscii_adpu_format.length;
      for (var i = 0; i < len; i++) {
        var c = votesVectorInAscii_adpu_format[i];
        if (c !== "u" /* && c !== "p" */) {
          // TODO think about "p", and whether it should be counted in the jetpack vote count
          if (c === "a") {
            votesToUseForProjection.push({
              vote: -1,
              tid: i
            });
          } else if (c === "d") {
            votesToUseForProjection.push({
              vote: 1,
              tid: i
            });
          } else if (c === "p") {
            votesToUseForProjection.push({
              vote: 0,
              tid: i
            });
          } else {
            console.error("bad vote encoding " + c);
          }
        }
      }
    }
    return project({
      pid: pid,
      containsSelf: pid === myPid,
      isBlueDot: pid === myPid, // TODO needed?
      isPtptoi: true,
      votes: votesToUseForProjection
    });
  }

  function project(o) {
    var x = 0;
    var y = 0;

    if (!o.votes.length) {
      return {
        pid: o.pid,
        isBlueDot: o.isBlueDot,
        containsSelf: o.containsSelf,
        isPtptoi: o.isPtptoi,
        proj: {
          x: x,
          y: y
        }
      };
    }

    for (var i = 0; i < o.votes.length; i++) {
      var v = o.votes[i];
      var tid = v.tid;
      if (modOutTids[tid]) {
        continue;
      }
      var vote = v.vote;

      var dxi = (vote - (pcaCenter[tid] || 0)) * (pcX[tid] || 0);
      var dyi = (vote - (pcaCenter[tid] || 0)) * (pcY[tid] || 0);
      if (!_.isNaN(dxi) && !_.isNaN(dyi)) {
        x += dxi;
        y += dyi;
      }
    }

    var numComments = pcaCenter.length;
    var numVotes = o.votes.length;

    if (numVotes > 0 && (o.pid !== -1 || USE_JETPACK_FOR_SELF)) {
      var jetpack_aka_sparsity_compensation_factor = Math.sqrt(numComments / numVotes);
      x *= jetpack_aka_sparsity_compensation_factor;
      y *= jetpack_aka_sparsity_compensation_factor;
    }

    return {
      pid: o.pid,
      isBlueDot: o.isBlueDot,
      containsSelf: o.containsSelf,
      proj: {
        x: x,
        y: y
      }
    };
  }

  function updateMyProjection() {
    var o = prepProjection(projectionPeopleCache);
    var people = o.buckets;
    var clusters = o.clusters;
    var projectedComments = prepCommentsProjection();
    sendUpdatedVisData(people, clusters, participantCount, projectedComments);
  }

  function convert_bidiToPids_to_bidToPids(bidiToPids) {
    return firstPcaCallPromise.then(function () {
      var mathMain = getMathMain();
      var indexToBid = mathMain["base-clusters"].id;

      var bidToPids = {};
      for (var i = 0; i < bidiToPids.length; i++) {
        var bid = indexToBid[i];
        var pids = bidiToPids[i];
        bidToPids[bid] = pids;
      }

      return bidToPids;
    });
  }

  function getPidToBidMappingFromCache() {
    if (lastServerTokenForBidiToPid >= lastServerTokenForPCA && lastServerTokenForBidiToPid > 0) {
      return $.Deferred().resolve({
        p2b: pidToBidCache,
        b2p: bidToPids,
        bid: myBid
      });
    } else {
      return getPidToBidMapping();
    }
  }

  function getPidToBidMapping() {
    return polisGet(bidiToPidsPath, {
      math_tick: lastServerTokenForBidiToPid, // use the same
      conversation_id: conversation_id
    })
      .then(function (data, textStatus, xhr) {
        if (304 === xhr.status) {
          return {
            p2b: pidToBidCache,
            b2p: bidToPids
          };
        }
        lastServerTokenForBidiToPid = data.math_tick;
        return convert_bidiToPids_to_bidToPids(data.bidToPid);
      })
      .then(function (bidToPids) {
        var p2b = {};
        _.each(bidToPids, function (memberPids, bid) {
          for (var i = 0; i < memberPids.length; i++) {
            var pid = memberPids[i];
            p2b[pid] = bid;
          }
        });
        pidToBidCache = p2b;

        return {
          p2b: pidToBidCache,
          b2p: bidToPids
        };
      });
  }

  function addPollingScheduledCallback(f) {
    pollingScheduledCallbacks.push(f);
  }

  function poll() {
    var pcaPromise = fetchLatestPca();
    pcaPromise.done(updateMyProjection);
    pcaPromise.done(function () {
      // TODO Trigger based on votes themselves incrementing, not waiting on the PCA.
      // TODO Look into socket.io for notifying that the math_tick has changed.
      _.each(pollingScheduledCallbacks, function (f) {
        f();
      });
    });

    function continuePolling() {
      setTimeout(poll, 5 * 1000); // could compute remaining part of interval.
    }
    pcaPromise.then(continuePolling, continuePolling);
  }

  function startPolling() {
    setTimeout(poll, 0);
    // setInterval(poll, 5000);
  }

  function prepProjection(buckets2) {
    if (bigBuckets.length) {
      buckets2 = bigBuckets;
    }
    // buckets = reprojectForSubsetOfComments(buckets2);
    var clusters = [];
    if (buckets2.length) {
      clusters = getClusters();
    }

    var o = withParticipantsOfInterest(buckets2, clusters);
    buckets2 = o.buckets;
    clusters = o.clusters;
    buckets2 = withProjectedSelf(buckets2);

    // remove empty buckets
    buckets2 = _.filter(buckets2, function (bucket) {
      return bucket.count > 0;
    });

    // inset each ptptoi towards the center of its cluster
    _.each(buckets2, function (b) {
      var cluster = clustersCache[b.gid];
      var center = null;
      if (cluster) {
        center = cluster.center;
      }
      b.proj = moveTowards(b.proj.x, b.proj.y, center, 0.0);
    });

    return {
      buckets: buckets2,
      clusters: clusters
    };
  }

  function getGroupInfo(gid) {
    if (gid === -1) {
      return {
        count: 0,
        votes: {
          A: [],
          D: [],
          gA: 0,
          gD: 0
        }
      };
    }
    return {
      count: groupVotes[gid]["n-members"],
      repness: repness[gid],
      votes: groupVotes[gid]["votes"]
    };
  }

  function prepCommentsProjection() {
    if (!Utils.projectComments) {
      return [];
    }
    var repfulTids = {};
    if (Utils.projectRepfulTids) {
      _.each(repness, function (gid) {
        _.each(repness[gid], function (c) {
          if (c["repful-for"] === "agree") {
            repfulTids[c.tid] = true;
          }
        });
      });
    }

    var numComments = pcaCenter.length;

    var numVotes = 1; // pretend the comment is a person who voted for only itself
    var jetpack_aka_sparsity_compensation_factor = Math.sqrt(numComments / numVotes);

    var projectedComments = [];
    if (pcX.length && pcY.length) {
      for (var i = 0; i < pcX.length; i++) {
        var shouldAdd = true;
        if (Utils.projectRepfulTids && !repfulTids[i]) {
          shouldAdd = false;
        }
        if (shouldAdd) {
          var x = pcX[i];
          var y = pcY[i];
          x *= jetpack_aka_sparsity_compensation_factor;
          y *= jetpack_aka_sparsity_compensation_factor;
          projectedComments.push({
            tid: i,
            proj: {
              x: x,
              y: y
            }
          });
        }
      }
    }
    return projectedComments;
  }

  function finishedTutorial() {
    return polisPost(finishedTutorialPath, {
      step: 1
    });
  }

  function getParticipantsOfInterestForGid(gid) {
    if (_.isUndefined(gid) || gid === null) {
      console.warn("getParticipantsOfInterestForGid with null gid");
      return [];
    }
    var cluster = clustersCache[gid].members;
    var items = [];
    _.each(participantsOfInterestVotes, function (data) {
      var bid = data.bid;
      if (cluster.indexOf(bid) >= 0) {
        items.push(data);
      }
    });
    return items;
  }

  function getParticipantsOfInterest() {
    return participantsOfInterestVotes;
  }

  function getParticipantsOfInterestIncludingSelf() {
    var alreadyHaveSelf = participantsOfInterestVotes[myPid];
    var result = _.clone(participantsOfInterestVotes);
    if (alreadyHaveSelf) {
      // nothing to do
    } else {
      result[myPid] = bucketizeSelf(projectSelf(), -1);
      result[myPid].isSelf = true;
    }
    result[myPid].picture_size = 48;

    var b2g = getBidToGid();

    return _.keys(result).map(function (key) {
      var o = result[key];
      var votesVectorInAscii_adpu_format = o.votes || "";
      var pid = parseInt(o.pid);

      var temp = projectParticipant(pid, votesVectorInAscii_adpu_format);
      o.x = temp.proj.x;
      o.y = temp.proj.y;

      o.gid = b2g[o.bid];
      o.isSelf = temp.isBlueDot || o.bid === -1;

      return o;
    });
  }

  function getGroup(gid) {
    return clustersCache[gid] && clustersCache[gid].members;
  }

  function convSub(params) {
    return polisPost(convSubPath, params);
  }

  function unvotedCommentsExist() {
    return !!nextCommentCache;
  }

  function setNextCachedComment(firstCommentPromise) {
    firstCommentPromise.then(function (c) {
      if (c && c.created) {
        nextCommentCache = c;
      } else {
        nextCommentCache = null;
      }
      if (c && !_.isUndefined(c.currentPid)) {
        processPidResponse(c.currentPid);
      }
    });
  }

  function prepAndSendVisData() {
    firstSuccessfulPcaCallPromise.then(function () {
      var o = prepProjection(projectionPeopleCache);
      var buckets = o.buckets;
      buckets.sort(function (a, b) {
        return b.priority - a.priority;
      });
      var clusters = o.clusters;
      var projectedComments = prepCommentsProjection();
      if (buckets.length) {
        sendUpdatedVisData(buckets, clusters, participantCount, projectedComments);
      }
    });
  }

  function getPtptCount() {
    // TODO we need the count of participants that are considered the vis, not the total number of ptpts.
    return cachedPcaData.n;
  }

  function getVotedOnTids() {
    return votesByMe.map(function (vote) {
      return vote.get("tid");
    });
  }

  function getVotesByMe() {
    return (
      votesByMe &&
      votesByMe.models &&
      votesByMe.models.map(function (m) {
        return m.attributes;
      })
    );
  }

  function addToVotesByMe(o) {
    votesByMe.add(o, {
      merge: true
    });
  }

  function getConsensus() {
    if (!cachedPcaData) {
      return [];
    }
    return cachedPcaData["consensus"];
  }

  function getGroupAwareConsensus() {
    if (!cachedPcaData) {
      return [];
    }
    return cachedPcaData["group-aware-consensus"];
  }

  function getGroupVotes(gid_or_all) {
    if (!cachedPcaData) {
      return {};
    }
    // for now add up all the vote counts across all groups since
    // we don't have stats for that yet.
    if (gid_or_all === "all") {
      var x = {};
      var gv = cachedPcaData["group-votes"];
      _.each(gv, function (data) {
        _.each(data.votes, function (counts, tid) {
          var z = (x[tid] = x[tid] || { agreed: 0, disagreed: 0, saw: 0 });
          z.agreed += counts.A;
          z.disagreed += counts.D;
          z.saw += counts.S;
        });
      });
      return x;
    }

    return cachedPcaData["group-votes"][gid_or_all];
  }

  function put_participants_extended(params) {
    params = $.extend(params, {
      conversation_id: conversation_id
    });

    return polisPut(participants_extended_path, params);
  }

  return {
    addToVotesByMe: addToVotesByMe,
    authenticated: authenticated,
    getNextComment: getNextComment,
    unvotedCommentsExist: unvotedCommentsExist,
    // TODO refactor this out, which will be easier if serverClient is a singleton, and gains responsibility for fetching the first comment
    setNextCachedComment: setNextCachedComment,
    getCommentsForProjection: getCommentsForProjection,
    getTidsForGroup: getTidsForGroup,
    getTidsForConsensus: getTidsForConsensus,
    getVotedOnTids: getVotedOnTids,
    getVotesByMe: getVotesByMe,
    getGroupInfo: getGroupInfo,
    getGroup: getGroup,
    getFancyComments: getFancyComments,
    getReactionsToComment: getReactionsToComment,
    getPidToBidMapping: getPidToBidMappingFromCache,
    getMathMain: getMathMain,
    getGroupAwareConsensus: getGroupAwareConsensus,
    getConsensus: getConsensus,
    getGroupVotes: getGroupVotes,
    disagree: disagree,
    agree: agree,
    pass: pass,
    trash: trash,
    star: star,
    unstar: unstar,
    mod: mod,
    invite: invite,
    convSub: convSub,
    queryParticipantsByMetadata: queryParticipantsByMetadata,
    syncAllCommentsForCurrentStimulus: syncAllCommentsForCurrentStimulus,
    addInitReadyListener: initReadyCallbacks.add,
    addAuthStatChangeListener: authStateChangeCallbacks.add,
    removePersonUpdateListener: personUpdateCallbacks.remove,
    addPersonUpdateListener: function () {
      personUpdateCallbacks.add.apply(personUpdateCallbacks, arguments);
      prepAndSendVisData();
    },
    finishedTutorial: finishedTutorial,
    addCommentsAvailableListener: commentsAvailableCallbacks.add,
    createConversation: createConversation,
    getConversations: getConversations,
    getLocations: getLocations,
    findRepresentativeMetadata: findRepresentativeMetadata,
    parseMetadataFromCSV: parseMetadataFromCSV,
    getParticipantsOfInterest: getParticipantsOfInterest,
    getParticipantsOfInterestForGid: getParticipantsOfInterestForGid,
    getParticipantsOfInterestIncludingSelf: getParticipantsOfInterestIncludingSelf,
    getPtptCount: getPtptCount,
    put_participants_extended: put_participants_extended,
    updateMyProjection: updateMyProjection,
    startPolling: startPolling,
    // simple way to centralize polling actions, and ensure they happen near each-other (to save battery)
    addPollingScheduledCallback: addPollingScheduledCallback,
    // jumpTo: jumpTo,
    submitComment: submitComment
  };
};
