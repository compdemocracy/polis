// Copyright (C) 2012-present, The Authors. This program is free software: you can redistribute it and/or  modify it under the terms of the GNU Affero General Public License, version 3, as published by the Free Software Foundation. This program is distributed in the hope that it will be useful, but WITHOUT ANY WARRANTY; without even the implied warranty of MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the GNU Affero General Public License for more details. You should have received a copy of the GNU Affero General Public License along with this program.  If not, see <http://www.gnu.org/licenses/>.

import * as globals from "../components/globals";
import createHull from "hull.js";

const graphUtil = (comments, math, badTids) => {

    const allXs = [];
    const allYs = [];

    const commentsByTid = comments.reduce((accumulator, comment) => {
      accumulator[comment.tid] = comment;
      return accumulator;
    }, {});
    const indexToTid = math.tids;
    const tidToIndex = [];
    for (let i = 0; i < indexToTid.length; i++) {
      tidToIndex[indexToTid[i]] = i;
    }
    // comments
    const commentsPoints = [];
    const projX = math.pca['comment-projection'][0];
    const projY = math.pca['comment-projection'][1];
    // let rejectedCount = 0;
    for (let i = 0; i < projX.length; i++) {
      if (comments[i]) {
        let tid = comments[i].tid;
        let index = tidToIndex[tid];
        let x = projX[index];
        let y = projY[index];
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
            // rejectedCount += 1;
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
    // let minClusterX = _.min(allXs);
    // let maxClusterX = _.max(allXs);
    // let minClusterY = _.min(allYs);
    // let maxClusterY = _.max(allYs);

    let greatestAbsPtptX = baseClusters.reduce((max, pt) => {
      return Math.max(max, Math.abs(pt.x));
    }, 0); // Initialize max to 0
    
    let greatestAbsPtptY = baseClusters.reduce((max, pt) => {
      return Math.max(max, Math.abs(pt.y));
    }, 0); // Initialize max to 0
    
    // var greatestAbsCommentX = Math.abs(_.maxBy(commentsPoints, (pt) => { return Math.abs(pt.x); }).x);
    // var greatestAbsCommentY = Math.abs(_.maxBy(commentsPoints, (pt) => { return Math.abs(pt.y); }).y);




    const xx = window.d3.scaleLinear().domain([-greatestAbsPtptX, greatestAbsPtptX]).range([border, globals.side - border]);
    const yy = window.d3.scaleLinear().domain([-greatestAbsPtptY, greatestAbsPtptY]).range([border, globals.side - border]);

    const xCenter = globals.side / 2;
    const yCenter = globals.side / 2;

    let maxCommentX = commentsPoints.length > 0 ? commentsPoints[0].x : undefined; // Handle empty array
    for (let i = 1; i < commentsPoints.length; i++) {
      if (commentsPoints[i].x > maxCommentX) {
        maxCommentX = commentsPoints[i].x;
      }
    }

    // Find minCommentX
    let minCommentX = commentsPoints.length > 0 ? commentsPoints[0].x : undefined; // Handle empty array
    for (let i = 1; i < commentsPoints.length; i++) {
      if (commentsPoints[i].x < minCommentX) {
        minCommentX = commentsPoints[i].x;
      }
    }

    // Find maxCommentY
    let maxCommentY = commentsPoints.length > 0 ? commentsPoints[0].y : undefined; // Handle empty array
    for (let i = 1; i < commentsPoints.length; i++) {
      if (commentsPoints[i].y > maxCommentY) {
        maxCommentY = commentsPoints[i].y;
      }
    }

    // Find minCommentY
    let minCommentY = commentsPoints.length > 0 ? commentsPoints[0].y : undefined; // Handle empty array
    for (let i = 1; i < commentsPoints.length; i++) {
      if (commentsPoints[i].y < minCommentY) {
        minCommentY = commentsPoints[i].y;
      }
    }

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

    var commentScaleupFactorX = Math.min(
      Math.abs(xScaleCandidateForRightSide),
      Math.abs(xScaleCandidateForLeftSide));

    var commentScaleupFactorY = Math.min(
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

    for (const group of Object.entries(baseClustersScaledAndGrouped)) {
      // Destructure the group entry (key and value)
      const [groupName, groupPoints] = group;
    
      // Create an array of coordinate pairs
      const pairs = groupPoints.map((g) => [g.x, g.y]);
    
      // Calculate the convex hull
      const hull = createHull(pairs, 400);
    
      // Push the result to hulls
      hulls.push({
        group: groupName,
        hull,
      });
    }

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
