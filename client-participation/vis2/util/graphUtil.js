import * as globals from "../components/globals";
import clone from "lodash/clone";
import min from "lodash/min";
import max from "lodash/max";
import keyBy from "lodash/keyBy";
import maxBy from "lodash/maxBy";
import minBy from "lodash/minBy";
import assign from "lodash/assign";
import each from "lodash/each";
import createHull from "hull.js";

import { forceSimulation, forceCollide, forceX, forceY } from 'd3-force';



const position_nw_0 = -99;
const position_nw_1 = -99;

const position_sw_0 = 99;
const position_sw_1 = -99;

const position_ne_0 = -99;
const position_ne_1 = 99;

const position_se_0 = 99;
const position_se_1 = 99;

function getScore(candidate) {
  let score = 0;
  score += Math.abs(candidate.nw.pos && (position_nw_0 - candidate.nw.pos[0]) || 0);
  score += Math.abs(candidate.nw.pos && (position_nw_1 - candidate.nw.pos[1]) || 0);
  score += Math.abs(candidate.sw.pos && (position_sw_0 - candidate.sw.pos[0]) || 0);
  score += Math.abs(candidate.sw.pos && (position_sw_1 - candidate.sw.pos[1]) || 0);
  score += Math.abs(candidate.ne.pos && (position_ne_0 - candidate.ne.pos[0]) || 0);
  score += Math.abs(candidate.ne.pos && (position_ne_1 - candidate.ne.pos[1]) || 0);
  score += Math.abs(candidate.se.pos && (position_se_0 - candidate.se.pos[0]) || 0);
  score += Math.abs(candidate.se.pos && (position_se_1 - candidate.se.pos[1]) || 0);
  return score;
}

function getGroupCornerAssignments(math) {
  let groupCornerAssignments = {
    nw: null,
    sw: null,
    ne: null,
    se: null,
  };

  const clusters = math['group-clusters'];

  let candidate = {
    nw: null,
    sw: null,
    ne: null,
    se: null,
  };

  let bestCandidate = null;
  let bestScore = Infinity;

  for (let i = 0; i < 4; i++) { // nw
    candidate.nw = {
      gid: i,
      pos: clusters[i] && clone(clusters[i].center),
    };
    for (let j = 0; j < 4; j++) { // sw
      if (j === i) { continue; }
      candidate.sw = {
        gid: j,
        pos: clusters[j] && clone(clusters[j].center),
      };

      for (let k = 0; k < 4; k++) { // ne
        if (k === i || k === j) { continue; }
        candidate.ne = {
          gid: k,
          pos: clusters[k] && clone(clusters[k].center),
        };

        for (let m = 0; m < 4; m++) { // se
          if (m === i || m === j || m === k) { continue; }
          candidate.se = {
            gid: m,
            pos: clusters[m] && clone(clusters[m].center),
          };

          let score = getScore(candidate);
          if (score < bestScore) {
            bestCandidate = clone(candidate);
            bestScore = score;
          }
        }
      }
    }
  }
  return bestCandidate;
}

// Mutates x,y props of objects in input arrays
function mixedForce(arrays, strength) {

  let allPoints = [];

  for (let i = 0; i < arrays.length; i++) {
    let a = arrays[i];
    for (let ai = 0; ai < a.length; ai++) {
      a[ai].__kind__ = i;
    }
    Array.prototype.push.apply(allPoints, a);
  }

  const force = forceSimulation(allPoints).stop()
      .force('x', forceX(d => d.x))
      .force('y', forceY(d => d.y))
      .force('collide', forceCollide(function(d) {
        return d.collideRadius || 10;
      }))
      .force("charge", d3.forceManyBody().strength(strength));

  for (let i = 0; i < 110; ++i) {
    force.tick();
  }
}

const doMapCornerPointer = (corner, xx, yy) => {
  if (corner.pos) {
    corner.pos = clone(corner.pos);
    corner.pos[0] = xx(corner.pos[0]);
    corner.pos[1] = yy(corner.pos[1]);
  }
}

const graphUtil = (comments, math, badTids, ptptois) => {
    const allXs = [];
    const allYs = [];

    const commentsByTid = keyBy(comments, "tid");

    // comments
    const commentsPoints = [];
    const compsX = math.pca.comps[0];
    const compsY = math.pca.comps[1];
    for (let i = 0; i < compsX.length; i++) {
      if (commentsByTid[i]) {
        let x = compsX[i];
        let y = compsY[i];
        // if (i === 32) { // TODO_DEMO_HACK use force layout instead
        //   x += 0.02;
        //   y += 0.01;
        // }
        if (!badTids[i]) {
          commentsPoints.push({
            x: x,
            y: y,
            tid: i,
            txt: commentsByTid[i].txt,
          });
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
        bid: bids[i],
        gid: baseClusterIdToGid(bids[i]),
      });
      allXs.push(clusterXs[i]);
      allYs.push(clusterYs[i]);
    }

    // ptptois
    for (let i = 0; i < ptptois.length; i++) {
      let p = ptptois[i];
      allXs.push(p.x);
      allYs.push(p.y);
    }


    // mixedForce([commentsPoints, baseClusters], -0.015);


    let border = 20;
    let minClusterX = min(allXs);
    let maxClusterX = max(allXs);
    let minClusterY = min(allYs);
    let maxClusterY = max(allYs);
    const xx = d3.scaleLinear().domain([minClusterX, maxClusterX]).range([border, globals.side - border]);
    const yy = d3.scaleLinear().domain([minClusterY, maxClusterY]).range([border, globals.svgHeightWithoutPadding - border]);

    const xCenter = xx(0);
    const yCenter = yy(0);

    var greatestAbsPtptX = (maxBy(baseClusters, (pt) => { return Math.abs(pt.x); }) || {x: 1}).x;
    var greatestAbsPtptY = (maxBy(baseClusters, (pt) => { return Math.abs(pt.y); }) || {y: 1}).y;
    var greatestAbsCommentX = (maxBy(commentsPoints, (pt) => { return Math.abs(pt.x); }) || {x: 1}).x;
    var greatestAbsCommentY = (maxBy(commentsPoints, (pt) => { return Math.abs(pt.y); }) || {y: 1}).y;

    var maxCommentX = (maxBy(commentsPoints, (pt) => { return pt.x; }) || {x: 1}).x;
    var minCommentX = (minBy(commentsPoints, (pt) => { return pt.x; }) || {x: 1}).x;
    var maxCommentY = (maxBy(commentsPoints, (pt) => { return pt.y; }) || {y: 1}).y;
    var minCommentY = (minBy(commentsPoints, (pt) => { return pt.y; }) || {y: 1}).y;

    // xGreatestMapped = xCenter + xScale * maxCommentX
    // globals.side - border = xCenter + xScale * maxCommentX
    // globals.side - border - xCenter = xScale * maxCommentX
    var xScaleCandidateForRightSide = (globals.side - border - xCenter) / maxCommentX;
    var yScaleCandidateForBottomSide = (globals.svgHeightWithoutPadding - border - yCenter) / maxCommentY;

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
      return assign({}, p, {
        gid: p.gid,
        bid: p.bid,
        x: xx(p.x),
        y: yy(p.y),
      });
    })


    for (let i = 0; i < commentsPoints.length; i++) {
      commentsPoints[i].x = xCenter + commentsPoints[i].x * commentScaleupFactorX;
      commentsPoints[i].y = yCenter + commentsPoints[i].y * commentScaleupFactorY;
    }

    let groupCentroids = math["group-clusters"].map((group) => {
      return {
        x: xx(group.center[0]),
        y: yy(group.center[1]),
        collideRadius: 40,
      };
    });

    let ptptoisProjected = ptptois.map((p) => {
      let p2 = clone(p);
      p2.x = xx(p.x);
      p2.y = yy(p.y);
      return p2;
    });

    mixedForce([commentsPoints, /*baseClustersScaled,*/ groupCentroids, ptptoisProjected], 2);

    const pointsForHullGeneration = {};

    function addPoint(o) {
      if (pointsForHullGeneration[o.gid]) {
        pointsForHullGeneration[o.gid].push(o);
      } else {
        pointsForHullGeneration[o.gid] = [o];
      }
    }
    baseClustersScaled.forEach(addPoint);

    // ptptoisProjected.forEach(addPoint);

    const hulls = [];

    each(pointsForHullGeneration, (group) => {
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


    let groupCornerAssignments = getGroupCornerAssignments(math);
    doMapCornerPointer(groupCornerAssignments.ne, xx, yy);
    doMapCornerPointer(groupCornerAssignments.nw, xx, yy);
    doMapCornerPointer(groupCornerAssignments.se, xx, yy);
    doMapCornerPointer(groupCornerAssignments.sw, xx, yy);



    return {
      commentsPoints,
      baseClustersScaled,
      hulls,
      groupCentroids,
      groupCornerAssignments,
      ptptoisProjected,
      xCenter,
      yCenter,
    };

}

export default graphUtil;
