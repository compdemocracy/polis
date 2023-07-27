import React, { useState, useEffect } from "react";
import Strings from "../strings/participation_en_us";
import PolisNet from "../util/net";
import anon_profile from "./anon_profile";
import { Bucket } from "./Bucket";
var _ = require("lodash");

const Visualization3 = ( {} ) => {
  useEffect(() => {
    (async () => {
    console.log("Strings", Strings)
    myPid = await getMyPid();
    await buildPcaObject();
    buildFancyCommentsObject().then(
      function(comments) {
        console.log("fancyComments", comments);
      }
    );
    votesByMe = await fetchVotesByMe();
    printVotesByMe();
    console.log("participantsOfInterestVotes", participantsOfInterestVotes);
    const ptptois = await buildParticipantsOfInterestIncludingSelf();
    console.log("ptpois", ptptois);
    await prepAndSendVisData();
    })();

  }, []);

  // Jake - globals, don't like this at all
  // these should be combined into some sort of object
  // and passed as parameters

  var myPid = "unknownpid";
  
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

  var projectionPeopleCache = [];
  var bigBuckets = [];
  var bidToBigBucket = {};
  var clustersCache = {};
  var groupVotes = null;
  // var nextCommentCache = null;

  var consensusComments = null;

  var modOutTids = {};

  const conversation_id = "7ajfd9j53y";
  let lastServerTokenForPCA = -1;
  let participantsOfInterestVotes = null; // change this global variable to a parameter at some point
  let participantsOfInterestBids = [];  // change this global variable to a parameter at some point

  var votesForTidBidPromise = $.Deferred(); // change this to something other than jquery in the future?

  var votesByMe = null;


  // normally this would be passed in via props, but since this is being
  // developed as an isolated component, we will call the API for it again here
  const getMyPid = () => {
    return PolisNet.polisGet("/api/v3/participationInit", {
      conversation_id: conversation_id,
      pid: "mypid",
      lang: "acceptLang",
    });
  }

  const fetchPcaData = () => {
    return PolisNet.polisGet("/api/v3/math/pca2", {
      conversation_id: conversation_id,
      cacheBust: (Math.random() * 1e9 >> 0),
    }, {
      "If-None-Match": '"' + lastServerTokenForPCA + '"',
    });
  };

  const fetchFamousVotes = () => {
    return PolisNet.polisGet("/api/v3/votes/famous", {
      conversation_id: conversation_id,
      math_tick: lastServerTokenForPCA,
    })
  }

  const fetchComments = (params) => {
    return PolisNet.polisGet("/api/v3/comments", {
      conversation_id: conversation_id,
      include_social: true,
    }, params)
    // in the original client-participation code,
    // there are two object attributes that are added onto
    // this response: commentText and participantStarred,
    // but their values are never used or modified.
    // see client-participation/js/models/vote.js
  }

  const fetchVotesByMe = () => {
    return PolisNet.polisGet("/api/v3/votes", {
      conversation_id: conversation_id,
      pid: "mypid",
    })
  }

  const printVotesByMe = async () => {
    const v = await fetchVotesByMe();
    console.log("votesByMe", v)
  }

  const buildFamousVotesObject = async () => {
    const myPid = await getMyPid(); // remove in the future
    const PTPOI_BID_OFFSET = 1e10;
    let x = await fetchFamousVotes();
    x = x || {};
    // assign fake bids for these projected participants
    _.each(x, function(ptpt, pid) {
      pid = parseInt(pid);
      var bucketId = pid + PTPOI_BID_OFFSET; // should be safe to say there aren't 10 billion buckets, so we can use this range
      if (pid === myPid) {
        myBid = bucketId;
      }
      ptpt.fakeBid = bucketId;

      // default anon picture, may be overwritten
      ptpt.picture = anon_profile;

      if (ptpt.facebook &&
        ptpt.facebook.fb_user_id // TEMP - needed since I deleted some entries from facebook_users
      ) {
        ptpt.hasFacebook = true;
        var width = 48; // same as twitter, normally 50x50
        var height = 48; // same as twitter, normally 50x50
        ptpt.picture_size = 48;
        if (window.devicePixelRatio > 1) {
          // on retina, we'll show 32x32, but fetch 64x64 images
          width = 96; // facebook will return 64x64 images if we're on a retina device
          height = 96; // facebook will return 64x64 images if we're on a retina device
          ptpt.picture_size = 48;
        }

        // https://developers.facebook.com/docs/graph-api/reference/v2.2/user/picture
        ptpt.facebook.picture = "https://graph.facebook.com/v2.2/" + ptpt.facebook.fb_user_id + "/picture?width=" + width + "&height=" + height;
        ptpt.picture = ptpt.facebook.picture;
      }

      // override with Twitter if they have it
      if (ptpt.twitter) {
        ptpt.picture = ptpt.twitter.profile_image_url_https;
        ptpt.picture_size = 48; // twitter's _normal.JPG size. _mini would be 24, and _bigger would be 73
        ptpt.hasTwitter = true;
      }

      if (ptpt.xInfo) {
        ptpt.picture = ptpt.xInfo.x_profile_image_url;
        ptpt.picture_size = 48;
        ptpt.hasTwitter = false;
        ptpt.hasFacebook = false;
      }

      // override with custom polis picture if they have it
      if (ptpt.polis) {
        ptpt.picture = ptpt.polis.polis_pic;
      }
    });
    participantsOfInterestVotes = x;
    participantsOfInterestBids = _.map(_.values(participantsOfInterestVotes), "bid");
  }

  function arraysToObjects(objWithArraysAsProperties) {
    /* jshint -W089 */
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
    /* jshint +W089 */
    return objects;
  }

  function sum(arrayOfNumbers) {
    var count = 0;
    var len = arrayOfNumbers.length;
    for (var i = 0; i < len; i++) {
      count += arrayOfNumbers[i];
    }
    return count;
  }

  function removeItemFromArray(bid, cluster) {
    var index = cluster.indexOf(bid);
    if (index >= 0) {
      cluster = cluster.splice(index, 1);
    }
    return cluster;
  }

  function removeEmptyBucketsFromClusters(clusters) {
    var buckets = projectionPeopleCache;
    for (var i = 0; i < buckets.length; i++) {
      var bucket = buckets[i];
      if (bucket.count <= 0 &&
        !bucket.containsSelf // but don't remove PTPTOIs from cluster
      ) {
        for (var gid = 0; gid < clusters.length; gid++) {
          removeItemFromArray(bucket.bid, clusters[gid].members);
        }
      }
    }
  }

  const getClusters = () => {
    var clusters = _.cloneDeep(clustersCache);
    // addParticipantsOfInterestToClusters(clusters);
    removeEmptyBucketsFromClusters(clusters);

    for (var i = 0; i < clusters.length; i++) {
      clusters[i]["n-members"] = cachedPcaData["group-votes"][i]["n-members"];
    }
    return clusters;
  }

  const getBidToGid = (clusters) => {
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

  const removeSelfFromBucketsAndClusters = (buckets, clusters) => {
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

  // from client-participation/js/stores/polis.js:1226 getFamousVotes.then(...)
  const bucketize = (pcaData) => {
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

    // Jake - commented this out because it is from Backbone
    // eb.trigger(eb.participantCount, participantCount);
    // if (_.isNumber(pcaData.voteCount)) {
    //   eb.trigger(eb.voteCount, pcaData.voteCount);
    // }
    //var myself = people.find(p => p.pid === getPid());
    //people = _.without(people, myself);
    //people.push(myself);

    // Jake - these are global variables too
    // ideally we should pass this around as an object
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

    // Jake - commented this out for now but it will be used in
    //  findRepresentativeMetadata() and getTidsForGroup()
    // 
    // clustersCachePromise.resolve();

    // o = prepProjection(buckets);
    // return null;
    return pcaData;
  }


  const buildPcaObject = async () => {
    let pcaData = await fetchPcaData();

    if (_.isNumber(pcaData.math_tick)) {
      lastServerTokenForPCA = pcaData.math_tick;
    } else {
      console.error("got invlid math_tick");
    }

    consensusComments = pcaData.consensus;
    groupVotes = pcaData["group-votes"];

    // create map for if a comment should not appear in visualization?
    modOutTids = {};
    var modOut = pcaData["mod-out"];
    if (modOut) {
      modOut.forEach(function(x) {
        modOutTids[x] = true;
      });
    }

    await buildFamousVotesObject();
    pcaData = bucketize(pcaData);
  }

  // Jake - try and remove the JQuery in the future
  const buildFancyCommentsObject = (options) => {
    options = $.extend(options, { translate: true, lang: navigator.language });
    return $.when(fetchComments(options), votesForTidBidPromise).then(function(args /* , dont need second arg */ ) {

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

  function projectParticipant(pid, votesVectorInAscii_adpu_format) {
    var votesToUseForProjection = [];
    if (pid === myPid) {
      votesToUseForProjection = votesByMe.map(function(v) {
        return {
          vote: v["vote"],
          tid: v["tid"]
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

  function getPid() {
    if (!(myPid >= 0)) {
      //     alert("bad pid: " + pid);
    }
    return myPid;
  }

  function projectSelf() {
    var votesToUseForProjection = votesByMe.map(function(v) {
      return {
        vote: v["vote"],
        tid: v["tid"]
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
      pic: anon_profile,
      picture_size: -1
    });
    return bucket;
  }

  const buildParticipantsOfInterestIncludingSelf = () => {
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

  function withProjectedSelf(people) {
    people = people || [];

    var alreadyHaveSelfDot = _.some(people, function(p) {
      return p.containsSelf;
    });
    if (!alreadyHaveSelfDot) {
      people = _.clone(people); // shallow copy
      people.unshift(bucketizeSelf(projectSelf(), -1));
    }
    return people;
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
    // var unitVectorToCentroid = Utils.toUnitVector(vectorToCentroidX, vectorToCentroidY);
    // var adjustedVectorX = howFar * unitVectorToCentroid[0];
    // var adjustedVectorY = howFar * unitVectorToCentroid[1];
    var adjustedVectorX = vectorToCentroidX * howFar;
    var adjustedVectorY = vectorToCentroidY * howFar;
    return {
      x: x + adjustedVectorX,
      y: y + adjustedVectorY
    };
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
      hasTwitter: !!ptptoiData.hasTwitter,
      hasFacebook: !!ptptoiData.hasFacebook,
      twitter: ptptoiData.twitter || {},
      facebook: ptptoiData.facebook || {},
      ptptoi: true,
      proj: o.proj,
      count: 1,
      bid: ptptoiData.fakeBid
    });
    return bucket;
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

    // if(Utils.isDemoMode()) {
    //     participantsOfInterestVotes[myPid] = {
    //         bid: -1,
    //         // created: "1416276055476"
    //         // modified: "1416276055476"
    //         // uid: 91268
    //         // zid: 12460
    //         //votes: "daaauduuuuuuudauu" // Votes will be found in a local collection
    //         picture: "https://umbc.givecorps.com/assets/user-icon-silhouette-ae9ddcaf4a156a47931d5719ecee17b9.png",
    //         twitter: {
    //             pid: myPid,
    //             // followers_count: 23
    //             // friends_count: 47
    //             profile_image_url_https: "https://umbc.givecorps.com/assets/user-icon-silhouette-ae9ddcaf4a156a47931d5719ecee17b9.png",
    //             // screen_name: "mbjorkegren"
    //             // twitter_user_id: 1131541
    //             verified: false
    //         },
    //         facebook: {
    //             // ...
    //         }
    //     };
    // }


    var bidToGid = getBidToGid();
    _.each(participantsOfInterestVotes, function(ptpt, pid) {
      var magicPid = Number(pid) + 10000000000;
      var gid = bidToGid[magicPid];
      // clusters[gid].ptptoiCount = (clusters[gid].ptptoiCount || 0) + 1;
      // clustersCache[gid].ptptois = _.union(clustersCache[gid].ptptois||[], magicPid);            // SO BAD
      var votesVectorInAscii_adpu_format = ptpt.votes || "";
      pid = parseInt(pid);

      // pid += 1000000000; // TODO figure out what bids to assign to ptptoi buckets, these fake pids are currently used for that
      var temp = projectParticipant(
        pid,
        votesVectorInAscii_adpu_format
      );
      temp.gid = gid;
      var p = bucketizeParticipantOfInterest(temp, ptpt);
      people.push(p);
    });

    function averageTheThings(items, getter) {
      var total = 0;
      _.each(items, function(item) {
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

    _.each(clusters, function(cluster) {
      var ptptoiMembers = cluster.members.filter(function(bid) {
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
    buckets2 = _.filter(buckets2, function(bucket) {
      return bucket.count > 0;
    });

    // inset each ptptoi towards the center of its cluster
    _.each(buckets2, function(b) {
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

  function prepCommentsProjection() {
    if (!Utils.projectComments) {
      return [];
    }
    var repfulTids = {};
    if (Utils.projectRepfulTids) {
      _.each(repness, function(gid) {
        _.each(repness[gid], function(c) {
          if (c['repful-for'] === "agree") {
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

  function prepAndSendVisData() {
    var o = prepProjection(projectionPeopleCache);
    var buckets = o.buckets;
    buckets.sort(function(a, b) {
      return b.priority - a.priority;
    });
    var clusters = o.clusters;
    var projectedComments = prepCommentsProjection();
    if (buckets.length) {
      sendUpdatedVisData(buckets, clusters, participantCount, projectedComments);
    }
  }
  

  return (
    <h1>Hello world</h1>
  )
}

export default Visualization3;