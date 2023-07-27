import React, { useState, useEffect } from "react";
// var Strings = require("../strings/participation_en_us");
import Root from "../vis2/vis2";
import PolisNet from "../util/net";
import anon_profile from "./anon_profile";

const Visualization2 = () => {
  var lastServerTokenForPCA = -1;
  var lastServerTokenForComments = -1;
  var lastServerTokenForBidiToPid = -1;

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
  var usePreloadMath = false;

  var consensusComments = null;

  var modOutTids = {};

  // collections
  // var votesByMe = params.votesByMe;
  var votesByMe = {}

  var myPid = 1 //change later

  const conversation_id = "7ajfd9j53y";

  useEffect(() => {
    // routes we need to call
    // comments
    // pca2
    // votes
  });

  function fetchPca(path, timestamp) {
    if (
      // Utils.isHidden() && 
      firstPcaCallPromise.state() === "resolved") {
      // Don't poll when the document isn't visible. (and we've already fetched the pca)
      return $.Deferred().reject();
    }

    function fetchIt() {
      return PolisNet.polisGet(path, {
        // math_tick: timestamp,
        conversation_id: conversation_id,
        cacheBust: (Math.random() * 1e9 >> 0)
      }, {
        "If-None-Match": '"' + timestamp + '"',
      });
    }

    var promise;
    if (usePreloadMath) {
      promise = preloadHelper.firstMathPromise.pipe(function(pcaData) {
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

    var p2 = promise.then(function(pcaData, textStatus, xhr) {
        usePreloadMath = false;
        if (304 === xhr.status) {
          // not nodified
          firstPcaCallPromise.resolve();
          return $.Deferred().reject();
        }
        cachedPcaData = pcaData;

        if (_.isNumber(pcaData.math_tick)) {
          lastServerTokenForPCA = pcaData.math_tick;
        } else {
          console.error("got invlid math_tick");
        }
        consensusComments = pcaData.consensus;
        groupVotes = pcaData["group-votes"];


        modOutTids = {};
        var modOut = pcaData["mod-out"];
        if (modOut) {
          modOut.forEach(function(x) {
            modOutTids[x] = true;
          });
        }


        return getFamousVotes().then(function() {

          // Check for missing comps... TODO solve
          if (!pcaData.pca || !pcaData.pca.comps) {
            console.error("missing comps");
            return $.Deferred().reject();
          }
          var buckets = arraysToObjects(pcaData["base-clusters"]);
          participantCount = sum(pcaData["base-clusters"].count);
          repness = pcaData["repness"];
          // TODO we should include the vectors for each comment (with the comments?)
          ///commentVectors = pcaData.commentVectors;

          // TODO this is not runnable, just a rough idea. (data isn't structured like this)
          ///var people = pcaData.people;

          eb.trigger(eb.participantCount, participantCount);
          if (_.isNumber(pcaData.voteCount)) {
            eb.trigger(eb.voteCount, pcaData.voteCount);
          }
          //var myself = people.find(p => p.pid === getPid());
          //people = _.without(people, myself);
          //people.push(myself);

          pcX = pcaData.pca.comps[0];
          pcY = pcaData.pca.comps[1];
          pcaCenter = pcaData.pca.center;

          // in case of malformed PCs (seen on conversations with only one comment)
          pcX = pcX || [];
          pcY = pcY || [];



          // gid -> {members: [bid1, bid2, ...], ...}
          var clusters = _.keyBy(pcaData["group-clusters"], "id");


          // buckets = _.map(pcaData["group-clusters"], function(cluster) {
          //     var anonBucket = _.clone(cluster);
          //     anonBucket.x = anonBucket.center[0];
          //     anonBucket.y = anonBucket.center[1];
          //     anonBucket.id = 4;
          //     return anonBucket;
          // });


          var bidToGid = getBidToGid(clusters);
          var bucketPerGroup = {};
          _.each(buckets, function(bucket) {
            var gid = bidToGid[bucket.id];
            bucketPerGroup[gid] = bucketPerGroup[gid] || [];
            bucketPerGroup[gid].push(bucket);
            bucket.gid = gid;
          });


          bidToBigBucket = {};
          // bigBuckets = [1,2,3];
          bigBuckets = _.map(bucketPerGroup,
            function(bucketsForGid, gid) {
              gid = parseInt(gid);
              var bigBucket = _.reduce(bucketsForGid, function(o, bucket) {
                if (_.includes(participantsOfInterestBids, bucket.id)) {
                  // debugger;
                  // o.ptptoiCount += 1;
                  return o;
                }
                // o.members = _.union(o.members, bucket.members);
                o.count += bucket.count;
                o.bids.push(bucket.id); // not currently consumed by vis

                // cumulative moving average  (SHOULD PROBABLY BE WEIGHTED)
                // bucket.count makes larger buckets weigh more.
                // o.x = ((bucket.x - o.x)) / o.bucketCount;
                // o.y = ((bucket.y - o.y)) / o.bucketCount;
                o.id = o.id + "_" + bucket.id; // TODO not sure, but this is proof-of-concept code
                return o;
              }, {
                members: [],
                id: "bigBucketBid_",
                bids: [],
                gid: gid,
                count: 0, // total ptpt count
                clusterCount: groupVotes[gid]["n-members"],
                // ptptoiCount: getParticipantsOfInterestForGid(gid).length,
                x: clusters[gid].center[0],
                y: clusters[gid].center[1],
                isSummaryBucket: true
              });
              for (var i = 0; i < bigBucket.bids.length; i++) {
                bidToBigBucket[bigBucket.bids[i]] = bigBucket.id;
              }
              clusters[gid].members = _.union(clusters[gid].members, [bigBucket.id]);
              return bigBucket;
            }
          );

          // bigBuckets.forEach(function(bb) {

          //     bb.ptptoiCount = _.intersection(participantsOfInterestBids, bb.bids).length; // getParticipantsOfInterestForClusterBids(bb.bids).length;
          // });

          // buckets = _.values(gidToBuckets);
          // buckets = buckets2;




          // remove the buckets that only contain a ptptoi
          buckets = _.filter(buckets, function(b) {
            var hasPtptOI = _.includes(participantsOfInterestBids, b.id);
            if (hasPtptOI) {
              if (b.count === 1) {
                return false;
              }
            }
            return true;
          });





          // mutate - move x and y into a proj sub-object, so the vis can animate x and y
          _.each(buckets, function(b) {
            b.proj = {
              x: b.x,
              y: b.y
            };
            delete b.x;
            delete b.y;
          });

          // Convert to Bucket objects.
          buckets = _.map(buckets, function(b) {
            return new Bucket(b);
          });

          // ----------------- AGAIN for bigBuckets ---------------------
          _.each(bigBuckets, function(b) {
            b.proj = {
              x: b.x,
              y: b.y
            };
            delete b.x;
            delete b.y;
          });

          // Convert to Bucket objects.
          bigBuckets = _.map(bigBuckets, function(b) {
            return new Bucket(b);
          });



          // -------------- PROCESS VOTES INFO --------------------------
          var gidToBigBucketId = {};
          _.each(bigBuckets, function(b) {
            gidToBigBucketId[b.gid] = b.bid;
          });
          votesForTidBid = {};
          _.each(groupVotes[0].votes, function(o, tid) {
            var A = {};
            var D = {};
            var S = {};
            _.each(clusters, function(cluster) {
              var gid = cluster.id;
              var bigBucketBid = gidToBigBucketId[gid];
              A[bigBucketBid] = groupVotes[gid]["votes"][tid].A;
              D[bigBucketBid] = groupVotes[gid]["votes"][tid].D;
              S[bigBucketBid] = groupVotes[gid]["votes"][tid].S;
            });
            votesForTidBid[tid] = {
              A: A,
              D: D,
              S: S,
            };
          });

          votesForTidBidPromise.resolve(); // NOTE this may already be resolved.

          // -------------- END PROCESS VOTES INFO --------------------------



          var temp = removeSelfFromBucketsAndClusters(buckets, clusters);
          buckets = temp.buckets;
          clustersCache = temp.clusters;

          projectionPeopleCache = buckets;
          clustersCachePromise.resolve();

          // o = prepProjection(buckets);
          return null;
        });
      },
      function(xhr) {
        if (404 === xhr.status) {
          firstPcaCallPromise.resolve();
        } else if (500 === xhr.status) {
          // alert("failed to get pca data");
        }
      });

    p2.then(function() {
      firstPcaCallPromise.resolve();
      firstSuccessfulPcaCallPromise.resolve();
    });
    return p2;
  }

  function getComments(params) {
    params = $.extend({
      conversation_id: conversation_id,
      include_social: true,
      // not_pid: getPid() // don't want to see own coments
    }, params);
    return PolisNet.polisGet("api/v3/comments", params);
  }

  function getFancyComments(options) {
    options = $.extend(options, { translate: true, lang: navigator.language });
    return $.when(getComments(options), votesForTidBidPromise).then(function(args /* , dont need second arg */ ) {

      var comments = args[0];
      // don't need args[1], just used as a signal

      // votesForTidBid should be defined since votesForTidBidPromise has resolved.
      return _.map(comments, function(x) {
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

  function getMathMain() {
    return fetchPca("api/v3/math/pca2", lastServerTokenForPCA);
  }

  function getPid() {
    if (!_.isId(myPid)) {
      //     alert("bad pid: " + pid);
    }
    return myPid;
  }

  function projectSelf() {
    var votesToUseForProjection = votesByMe.map(function(v) {
      return {
        vote: v.get("vote"),
        tid: v.get("tid")
      };
    });
    return project({
      pid: getPid(),
      isBlueDot: true,
      votes: votesToUseForProjection
    });
  }

  function bucketizeSelf(self, selfDotBid) {
    var bucket = new Bucket({
      priority: 999999,
      containsSelf: true,
      gid: self.gid,
      hasTwitter: !!self.hasTwitter,
      hasFacebook: !!self.hasFacebook,
      twitter: self.twitter || {},
      facebook: self.facebook || {},
      proj: self.proj,
      count: 1,
      bid: selfDotBid,
      // pic: Utils.getAnonPicUrl(),
      pic: anon_profile,
      picture_size: -1
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

  function projectParticipant(pid, votesVectorInAscii_adpu_format) {
    var votesToUseForProjection = [];
    if (pid === myPid) {
      votesToUseForProjection = votesByMe.map(function(v) {
        return {
          vote: v.get("vote"),
          tid: v.get("tid")
        };
      });
    } else {
      var len = votesVectorInAscii_adpu_format.length;
      for (var i = 0; i < len; i++) {
        var c = votesVectorInAscii_adpu_format[i];
        if (c !== "u" /* && c !== "p" */ ) { // TODO think about "p", and whether it should be counted in the jetpack vote count
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
            alert("bad vote encoding " + c);
          }
        }
      }
    }
    return project({
      pid: pid,
      containsSelf: (pid === myPid),
      isBlueDot: (pid === myPid), // TODO needed?
      isPtptoi: true,
      votes: votesToUseForProjection
    });
  }

  function getParticipantsOfInterestIncludingSelf() {
    var alreadyHaveSelf = participantsOfInterestVotes[myPid];
    // _.some(participantsOfInterestVotes, function(p) {
    //   console.log('pid', myPid, p.pid);
    //   if (myPid === p.pid) {
    //     console.log(p);
    //   }
    //   return myPid === p.pid;
    // });
    var result = _.clone(participantsOfInterestVotes);
    if (alreadyHaveSelf) {
      // nothing to do
    } else {
      result[myPid] = bucketizeSelf(projectSelf(), -1);
      result[myPid].isSelf = true;
    }
    result[myPid].picture_size = 48;

    var b2g = getBidToGid();

    return _.keys(result).map(function(key) {
      var o = result[key];
      var votesVectorInAscii_adpu_format = o.votes || "";
      var pid = parseInt(o.pid);

      var temp = projectParticipant(pid, votesVectorInAscii_adpu_format);
      o.x = temp.proj.x;
      o.y = temp.proj.y;

      o.gid = b2g[o.bid];
      o.isSelf = temp.isBlueDot || o.bid === -1;
      // if (o.isSelf && o.pid === -1) { // use local votes based projection for anon self case. (rely on votesVectorInAscii_adpu_format for non-anon self)
      //   var projectedSelf = projectSelf();
      //   o.x = projectedSelf.proj.x;
      //   o.y = projectedSelf.proj.y;
      // }


      return o;
    });
  }

  function fetchVotesByMe() {
    console.log("fetchVotesByMe")
    PolisNet.polisGet(
      "/api/v3/votes",
      $.extend({}, params, {
        conversation_id: conversation_id,
        pid: "mypid",
      }),
    )
      .then((res) => {
        console.log("fetchVotesByMe success... printing response")
        console.log(res)
        votesByMe = res
      })
      .fail((err) => {
      });
  }

  function getVotesByMe() {
    // return votesByMe && votesByMe.models && votesByMe.models.map(function(m) {
    //   return m.attributes;
    // });
    console.log("getVotesByMe")
    console.log(votesByMe)
    return votesByMe
  }

  /*
  updateVotesByMeCollection: function(isFirstFetch) {
    if (Utils.isDemoMode()) {
      return;
    }
    if (isFirstFetch) {
      preloadHelper.firstVotesByMePromise.then(function(votes) {
        this.votesByMe.add(votes);
      }.bind(this));
    } else {
      this.votesByMe.fetch({
        data: $.param({
          conversation_id: this.conversation_id,
          pid: "mypid",
        }),
        reset: false
      });
    }
  },
  */

  // renderVis parameters
  // Strings: copy file from client-participation?
  // math_main: cachedPcaData, comes from pca2 route but can be null?
  // comments: comes from getFancyComments()
  // tidsToShow: if the user doesn't click on a group, then no comments in particular will be shown
  // ptptios: calls getParticipantsOfInterestIncludingSelf()
  // votesByMe: calls getVotesByMe()
  // onVoteClicked: not sure exactly what this is for??
  // onCurationChange: look at client-participation/js/views/participation.js:379

  return (
    <Root
      comments={getFancyComments()}
      math_main={getMathMain()}
      tidsToShow={[]}
      ptptois={getParticipantsOfInterestIncludingSelf()}
      votesByMe={getVotesByMe()}
      onVoteClicked={() => {}}
      onCurationChange={() => {}}
      Strings={Strings}
    />
  );
};

export default Visualization2;
