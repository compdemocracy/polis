import React, { useState, useEffect } from "react";
import Strings from "../strings/participation_en_us";
import PolisNet from "../util/net";
import anon_profile from "./anon_profile";
import { Bucket } from "./Bucket";
var _ = require("lodash");

const Visualization3 = ( {} ) => {
  useEffect(() => {
    console.log(Strings)
    buildPcaObject();
  }, []);

  // Jake - globals, don't like this at all
  // these should be combined into some sort of object
  // and passed as parameters
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

  // var projectionPeopleCache = [];
  var bigBuckets = [];
  var bidToBigBucket = {};
  // var clustersCache = {};
  var groupVotes = null;
  // var nextCommentCache = null;

  var consensusComments = null;

  // var modOutTids = {};

  const conversation_id = "7ajfd9j53y";
  let lastServerTokenForPCA = -1;
  let participantsOfInterestVotes = null; // change this global variable to a parameter at some point
  let participantsOfInterestBids = [];  // change this global variable to a parameter at some point

  var votesForTidBidPromise = $.Deferred(); // change this to something other than jquery in the future?


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

  const getClusters = () => {
    var clusters = deepcopy(clustersCache);
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
    clustersCachePromise.resolve();

    // o = prepProjection(buckets);
    // return null;
    return pcaData;
  }


  const buildPcaObject = async () => {
    const pcaData = await fetchPcaData();
    console.log(pcaData)

    if (_.isNumber(pcaData.math_tick)) {
      lastServerTokenForPCA = pcaData.math_tick;
    } else {
      console.error("got invlid math_tick");
    }

    consensusComments = pcaData.consensus;
    groupVotes = pcaData["group-votes"];

    // create map for if a comment should not appear in visualization?
    let modOutTids = {};
    var modOut = pcaData["mod-out"];
    if (modOut) {
      modOut.forEach(function(x) {
        modOutTids[x] = true;
      });
    }

    buildFamousVotesObject();
    pcaData = bucketize(pcaData);
  }
  

  return (
    <h1>Hello world</h1>
  )
}

export default Visualization3;