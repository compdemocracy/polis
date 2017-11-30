import * as globals from "../components/globals";
import createHull from "hull.js";

const graphUtil = (comments, math, badTids) => {

    const allXs = [];
    const allYs = [];

    const commentsByTid = _.keyBy(comments, "tid");
    const indexToTid = math.tids;
    const tidToIndex = [];
    for (let i = 0; i < indexToTid.length; i++) {
      tidToIndex[indexToTid[i]] = i;
    }

    // comments
    const commentsPoints = [];
    const compsX = math.pca.comps[0];
    const compsY = math.pca.comps[1];
    let rejectedCount = 0;
    for (let i = 0; i < compsX.length; i++) {
      if (comments[i]) {
        let tid = comments[i].tid;
        let index = tidToIndex[tid];
        let x = compsX[index];
        let y = compsY[index];
        // if (i === 32) { // TODO_DEMO_HACK use force layout instead
        //   x += 0.02;
        //   y += 0.01;
        // }
        if (!badTids[tid]) {
          if (commentsByTid[tid]) {
            commentsPoints.push({
              x: x,
              y: y,
              tid: tid,
              txt: commentsByTid[tid].txt,
            });
          } else {
            rejectedCount += 1;
            // console.log('skipping rejected', i, rejectedCount);
          }
        } else {
          // console.log('skipping bad', i);
        }
      }
    }

    const baseClusterIdToGid = (baseClusterId) => {
      var clusters = math["group-clusters"];
      for (let i = 0; i < clusters.length; i++) {
        if (clusters[i].members.indexOf(baseClusterId) >= 0) {
          return clusters[i].id;
        }
      }
    }

    // participants
    const clusterXs = math["base-clusters"].x;
    const clusterYs = math["base-clusters"].y;
    const bids = math["base-clusters"].id;
    let baseClusters = [];
    for (let i = 0; i < clusterXs.length; i++) {
      baseClusters.push({
        x: clusterXs[i],
        y: clusterYs[i],
        id: bids[i],
        gid: baseClusterIdToGid(bids[i]),
      });
      allXs.push(clusterXs[i]);
      allYs.push(clusterYs[i]);
    }

    let border = 100;
    let minClusterX = _.min(allXs);
    let maxClusterX = _.max(allXs);
    let minClusterY = _.min(allYs);
    let maxClusterY = _.max(allYs);
    const xx = d3.scaleLinear().domain([minClusterX, maxClusterX]).range([border, globals.side - border]);
    const yy = d3.scaleLinear().domain([minClusterY, maxClusterY]).range([border, globals.side - border]);

    const xCenter = globals.side / 2;
    const yCenter = globals.side / 2;

    var greatestAbsPtptX = _.maxBy(baseClusters, (pt) => { return Math.abs(pt.x); }).x;
    var greatestAbsPtptY = _.maxBy(baseClusters, (pt) => { return Math.abs(pt.y); }).y;
    var greatestAbsCommentX = _.maxBy(commentsPoints, (pt) => { return Math.abs(pt.x); }).x;
    var greatestAbsCommentY = _.maxBy(commentsPoints, (pt) => { return Math.abs(pt.y); }).y;

    var maxCommentX = _.maxBy(commentsPoints, (pt) => { return pt.x; }).x;
    var minCommentX = _.minBy(commentsPoints, (pt) => { return pt.x; }).x;
    var maxCommentY = _.maxBy(commentsPoints, (pt) => { return pt.y; }).y;
    var minCommentY = _.minBy(commentsPoints, (pt) => { return pt.y; }).y;

    // xGreatestMapped = xCenter + xScale * maxCommentX
    // globals.side - border = xCenter + xScale * maxCommentX
    // globals.side - border - xCenter = xScale * maxCommentX
    var xScaleCandidateForRightSide = (globals.side - border - xCenter) / maxCommentX;
    var yScaleCandidateForBottomSide = (globals.side - border - yCenter) / maxCommentY;

    // xLowestMapped = xCenter + xScale * minCommentX
    // border = xCenter + xScale * minCommentX
    // border - xCenter = xScale * minCommentX
    // (border - xCenter) / minCommentX = xScale
    var xScaleCandidateForLeftSide = (border - xCenter) / minCommentX;
    var yScaleCandidateForTopSide = (border - yCenter) / minCommentY;

    // TODO_VOTE_FLIP: we can probably remove the -1 below if we flip the vote values.
    var commentScaleupFactorX = -1 * Math.min(
      Math.abs(xScaleCandidateForRightSide),
      Math.abs(xScaleCandidateForLeftSide));

    var commentScaleupFactorY = -1 * Math.min(
      Math.abs(yScaleCandidateForBottomSide),
      Math.abs(yScaleCandidateForTopSide));

    const baseClustersScaled = baseClusters.map((p) => {
      return {
        gid: p.gid,
        id: p.id,
        x: xx(p.x),
        y: yy(p.y)
      }
    })

    const baseClustersScaledAndGrouped = {}

    baseClustersScaled.forEach((baseCluster) => {
      if (baseClustersScaledAndGrouped[baseCluster.gid]) {
        baseClustersScaledAndGrouped[baseCluster.gid].push(baseCluster);
      } else {
        baseClustersScaledAndGrouped[baseCluster.gid] = [baseCluster];
      }
    });

    const hulls = [];

    _.each(baseClustersScaledAndGrouped, (group) => {
      const pairs = group.map((g) => { /* create an array of arrays */
        return [g.x, g.y]
      })
      const hull = createHull(
        pairs,
        400
      )
      hulls.push({
        group,
        hull,
      })
    })

    return {
      xx,
      yy,
      commentsPoints,
      xCenter,
      yCenter,
      baseClustersScaled,
      commentScaleupFactorX,
      commentScaleupFactorY,
      hulls,
    }

}

export default graphUtil;
