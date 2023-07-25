import React from "react";

function fetchPca(path, timestamp) {
  if (Utils.isHidden() && firstPcaCallPromise.state() === "resolved") {
    // Don't poll when the document isn't visible. (and we've already fetched the pca)
    return $.Deferred().reject();
  }

  function fetchIt() {
    return polisGet(path, {
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

const updateVis2 = () => {
  var that = this;

  if (this.model.get("vis_type") !== Constants.VIS_TYPE.PCA) {
    return;
  }


  // TODO don't do a separate AJAX call for the comments.
  this.serverClient.getFancyComments().then(function(comments) {
    function doRenderVis() {

      var mathMain = that.serverClient.getMathMain();
      var tidsToShow = []; //that.serverClient.getVotedOnTids();
      if (_.isNull(that.curationType)) {

      } else if (that.curationType === "majority") {
        tidsToShow = [];
        Array.prototype.push.apply(tidsToShow, mathMain.consensus.agree.map(function(c) { return c.tid; }));
        Array.prototype.push.apply(tidsToShow, mathMain.consensus.disagree.map(function(c) { return c.tid; }));
      } else if (that.curationType === "differences") {

      } else if (_.isNumber(that.curationType)) {
        tidsToShow = [];
        var gid = that.curationType;
        Array.prototype.push.apply(tidsToShow, mathMain.repness[gid].map(function(c) { return c.tid; }));
      } else {
        console.error("unknown curationType:", that.curationType);
      }

      if (!window.renderVis) {
        console.error("window.renderVis missing");
        return;
      }
      window.renderVis(
        document.getElementById("vis2_root"),
        {
          Strings: Strings,
          math_main: mathMain,
          comments: comments,
          tidsToShow: tidsToShow,
          ptptois: that.serverClient.getParticipantsOfInterestIncludingSelf(),
          votesByMe: that.serverClient.getVotesByMe(),
          onVoteClicked: onVoteClicked,
          onCurationChange: onCurationChange,
          // comments: this.allCommentsCollection.models,
        }
      );
    }

    function onVoteClicked(o) {
      var dfd = $.Deferred().reject();
      if (o.vote === window.polisTypes.reactions.pull) {
        dfd = that.serverClient.agree(o.tid);
      } else if (o.vote === window.polisTypes.reactions.push) {
        dfd = that.serverClient.disagree(o.tid);
      } else if (o.vote === window.polisTypes.reactions.pass) {
        dfd = that.serverClient.pass(o.tid);
      }
      dfd.then(function() {
        that.serverClient.addToVotesByMe({
          vote: o.vote,
          tid: o.tid,
          conversation_id: that.conversation_id,
        });
        doRenderVis();
      }, function() {
        alert("error changing vote");
      });

    }

    function onCurationChange(newCurationType) {
      that.curationType = newCurationType;
      doRenderVis();
    }

    doRenderVis();
  });
}

const Visualization = () => {
  
}