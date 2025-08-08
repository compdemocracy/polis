// Copyright (C) 2012-present, The Authors. This program is free software: you can redistribute it and/or  modify it under the terms of the GNU Affero General Public License, version 3, as published by the Free Software Foundation. This program is distributed in the hope that it will be useful, but WITHOUT ANY WARRANTY; without even the implied warranty of MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the GNU Affero General Public License for more details. You should have received a copy of the GNU Affero General Public License along with this program.  If not, see <http://www.gnu.org/licenses/>.

import * as globals from "../components/globals";
import createHull from "hull.js";

const graphUtil = (comments, math, badTids) => {
    // Add comprehensive type safety and default values
    const safeComments = Array.isArray(comments) ? comments : [];
    const safeMath = math || {};
    const safeBadTids = badTids || {};
    
    // Check if we have the minimum required data
    if (!safeMath.pca || !safeMath.pca['comment-projection'] || !Array.isArray(safeMath.tids)) {
        console.warn('GraphUtil: Missing or invalid PCA data, returning empty results');
        return {
            xx: [],
            yy: [],
            commentsPoints: [],
            xCenter: 0,
            yCenter: 0,
            baseClustersScaled: [],
            commentScaleupFactorX: 1,
            commentScaleupFactorY: 1,
            hulls: []
        };
    }

    const allXs = [];
    const allYs = [];

    const commentsByTid = safeComments.reduce((accumulator, comment) => {
      if (comment && typeof comment.tid !== 'undefined') {
        accumulator[comment.tid] = comment;
      }
      return accumulator;
    }, {});
    
    const indexToTid = safeMath.tids || [];
    const tidToIndex = [];
    for (let i = 0; i < indexToTid.length; i++) {
      if (typeof indexToTid[i] !== 'undefined') {
        tidToIndex[indexToTid[i]] = i;
      }
    }
    
    // comments
    const commentsPoints = [];
    const projX = safeMath.pca['comment-projection'][0] || [];
    const projY = safeMath.pca['comment-projection'][1] || [];
    // let rejectedCount = 0;
    for (let i = 0; i < Math.min(projX.length, projY.length, safeComments.length); i++) {
      if (safeComments[i] && typeof safeComments[i].tid !== 'undefined') {
        let tid = safeComments[i].tid;
        let index = tidToIndex[tid];
        
        // Ensure index is valid and projections exist
        if (typeof index !== 'undefined' && 
            typeof projX[index] === 'number' && 
            typeof projY[index] === 'number') {
          let x = projX[index];
          let y = projY[index];
          
          if (!safeBadTids[tid]) {
            if (commentsByTid[tid]) {
              commentsPoints.push({
                x: x,
                y: y,
                tid: tid,
                txt: commentsByTid[tid].txt || '',
              });
            }
          }
        }
      }
    }

    const baseClusterIdToGid = (baseClusterId) => {
      var clusters = safeMath["group-clusters"] || [];
      for (let i = 0; i < clusters.length; i++) {
        if (clusters[i] && clusters[i].members && clusters[i].members.indexOf(baseClusterId) >= 0) {
          return clusters[i].id;
        }
      }
    }

    // participants
    const baseClustersData = safeMath["base-clusters"] || {};
    const clusterXs = baseClustersData.x || [];
    const clusterYs = baseClustersData.y || [];
    const bids = baseClustersData.id || [];
    let baseClusters = [];
    
    const minLength = Math.min(clusterXs.length, clusterYs.length, bids.length);
    for (let i = 0; i < minLength; i++) {
      if (typeof clusterXs[i] === 'number' && typeof clusterYs[i] === 'number') {
        baseClusters.push({
          x: clusterXs[i],
          y: clusterYs[i],
          id: bids[i],
          gid: baseClusterIdToGid(bids[i]),
        });
        allXs.push(clusterXs[i]);
        allYs.push(clusterYs[i]);
      }
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
    
      // Only create hulls if we have enough points and valid data
      if (Array.isArray(groupPoints) && groupPoints.length >= 3) {
        try {
          // Create an array of coordinate pairs, filtering out invalid coordinates
          const pairs = groupPoints
            .filter(g => g && typeof g.x === 'number' && typeof g.y === 'number' && 
                        !isNaN(g.x) && !isNaN(g.y))
            .map((g) => [g.x, g.y]);
        
          // Only create hull if we have enough valid points
          if (pairs.length >= 3) {
            const hull = createHull(pairs, 400);
            
            if (hull && hull.length > 0) {
              hulls.push({
                group: groupName,
                hull,
              });
            }
          }
        } catch (error) {
          console.warn(`Failed to create hull for group ${groupName}:`, error);
        }
      }
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
