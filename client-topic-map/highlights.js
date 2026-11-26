/*
 * PolisTopicMapHighlights: which comments to bring forward over the map, as
 * pure functions. A map document (polis-topic-map/1) and per-comment numbers
 * that Polis already computes in; the most consensus and the most divisive
 * comments of the whole map, and of each topic of one level, out, with the
 * per-topic summary the report's topic statistics page draws as box plots,
 * sorted. No measure is new: each is one the math engine or the report client
 * already computes, named where it is defined.
 *
 *   var numbers = PolisTopicMapHighlights.numbersFrom(math, comments);
 *   var h = PolisTopicMapHighlights.highlights(doc, numbers, { level: 0 });
 *   // h.consensus, h.divisive: the map's top standout comments, most first
 *   // h.topics: one entry per topic of the level, highest median consensus
 *   //   first, with its standouts and whether it is a special topic
 *
 * The numbers (all keyed by comment id, the document's point id):
 *   consensus  group-informed consensus as the report shows it: the mean over
 *              the opinion groups of (agrees + 1) / (agrees + disagrees + 2)
 *              (client-report/src/util/normalizeConsensus.js). 1 when every
 *              group agrees, 0 when every group disagrees.
 *   divisive   the comment's extremity in the PCA: the length of its
 *              projection on the two components (the math result's
 *              pca["comment-extremity"]; delphi/polismath/pca_kmeans_rep/pca.py,
 *              compute_comment_extremity). The report's "How divisive was the
 *              conversation?" chart puts comments on this axis.
 *   votes      agree + disagree + pass, as the comments route counts them.
 * Any other number per comment can be passed as either measure.
 *
 * A comment is eligible for a measure when its point has an id (held-back
 * points have none and are never selected), the measure has a finite value
 * for it, and it has at least minVotes votes (the topic statistics page's
 * floor of 5: comments with fewer votes sit at the smoothing's default).
 * Ties are broken by more votes first, then by the smaller id, so the same
 * inputs always give the same order.
 *
 * Standouts. A comment is brought forward for a measure only when it stands
 * out on the whole map: when it is in the top share of the eligible comments
 * for that measure (by default the top tenth: standout 0.9). The line is the
 * value of the k-th comment in order, k = ceil(count * (1 - standout)), and
 * every eligible comment at or above it is a standout (so ties at the line
 * are all in). The map's top n and each topic's picks are drawn from the
 * standouts only: a topic with no standout comment has no pick, and nothing
 * is ever forced. standout 0 makes every eligible comment a standout.
 *
 * Special topics. Over the topics of the level that have eligible comments,
 * a topic is special for consensus when the median group-informed consensus
 * of its comments is in the top share of the topics' medians (topicStandout,
 * the same k-th rule as above, by default the top 15%) AND the spread of its
 * middle half (q3 - q1) is at or under the spreadQuantile quantile of the
 * topics' spreads (by default 0.25: the narrowest quarter). It is special for
 * division when the median divisiveness of its comments is in the top share
 * of the topics' medians of that measure (topicDivisive, by default the top
 * tenth).
 */
(function (root) {
  "use strict";

  var DEFAULTS = {
    n: 5,          // comments of the whole map, per measure
    perTopic: 1,   // comments of each topic, per measure
    minVotes: 5,   // the topic statistics page's floor
    level: 0,      // the finest level
    standout: 0.9,        // a comment stands out when in the top tenth of the map
    topicStandout: 0.85,  // consensus: a topic's median in the top 15% of topics' medians
    spreadQuantile: 0.25, // and its spread (q3 - q1) in the narrowest quarter of topics'
    topicDivisive: 0.9    // division: a topic's median in the top tenth of topics' medians
  };

  /* ------------------------------------------------- numbers Polis computes */

  // Group-informed consensus as the report client computes it from the math
  // result's group-votes (normalizeConsensus.js, normalizeGroupConsensus and
  // enrichMathWithNormalizedConsensus): every comment any group voted on, the
  // mean over the groups that voted on it of (A + 1) / (A + D + 2).
  function normalizedConsensus(groupVotes) {
    var out = {};
    if (!groupVotes) return out;
    var sums = {}, counts = {};
    Object.keys(groupVotes).forEach(function (gid) {
      var votes = (groupVotes[gid] && groupVotes[gid].votes) || {};
      Object.keys(votes).forEach(function (tid) {
        var v = votes[tid];
        if (!v) return;
        var a = v.A || 0, d = v.D || 0;
        sums[tid] = (sums[tid] || 0) + (a + 1) / (a + d + 2);
        counts[tid] = (counts[tid] || 0) + 1;
      });
    });
    Object.keys(sums).forEach(function (tid) { out[tid] = sums[tid] / counts[tid]; });
    return out;
  }

  // pca["comment-extremity"] is in the order of the math result's tids.
  function extremityByTid(math) {
    var out = {};
    var e = math && math.pca && math.pca["comment-extremity"], tids = math && math.tids;
    if (!e || !tids) return out;
    for (var i = 0; i < e.length && i < tids.length; i++) out[tids[i]] = e[i];
    return out;
  }

  function votesByTid(comments) {
    var out = {};
    (comments || []).forEach(function (c) {
      out[c.tid] = (c.agree_count || 0) + (c.disagree_count || 0) + (c.pass_count || 0);
    });
    return out;
  }

  // The three default numbers from the math result (pca2) and the comment list.
  function numbersFrom(math, comments) {
    return {
      consensus: normalizedConsensus(math && math["group-votes"]),
      divisive: extremityByTid(math),
      votes: votesByTid(comments)
    };
  }

  /* --------------------------------------------------------------- selection */

  function resolve(options) {
    var o = Object.assign({}, DEFAULTS, options || {});
    ["n", "perTopic", "minVotes"].forEach(function (k) {
      if (typeof o[k] !== "number" || !(o[k] >= 0)) throw new Error("highlights: " + k + " must be a number of 0 or more");
    });
    ["standout", "topicStandout", "topicDivisive"].forEach(function (k) {
      if (typeof o[k] !== "number" || !(o[k] >= 0 && o[k] < 1)) throw new Error("highlights: " + k + " must be a number from 0 up to, not including, 1");
    });
    if (typeof o.spreadQuantile !== "number" || !(o.spreadQuantile >= 0 && o.spreadQuantile <= 1)) {
      throw new Error("highlights: spreadQuantile must be a number from 0 to 1");
    }
    return o;
  }

  function compareIds(a, b) {
    if (typeof a === "number" && typeof b === "number") return a - b;
    var sa = String(a), sb = String(b);
    return sa < sb ? -1 : sa > sb ? 1 : 0;
  }

  // Most first; ties: more votes, then the smaller id.
  function byValue(a, b) {
    return (b.value - a.value) || (b.votes - a.votes) || compareIds(a.id, b.id);
  }

  // Every eligible point for one measure, as { index, id, x, y, value, votes }.
  function eligible(doc, measure, votes, minVotes) {
    var P = doc.points, out = [];
    measure = measure || {}; votes = votes || {};
    for (var i = 0; i < P.id.length; i++) {
      var id = P.id[i];
      if (id === null || id === undefined) continue;
      var value = measure[id], n = votes[id];
      if (typeof value !== "number" || !isFinite(value)) continue;
      if (typeof n !== "number" || !(n >= minVotes)) continue;
      out.push({ index: i, id: id, x: P.x[i], y: P.y[i], value: value, votes: n });
    }
    return out;
  }

  function top(list, n) {
    return list.slice().sort(byValue).slice(0, n);
  }

  // How many of count items make the top share above quantile q (0 <= q < 1):
  // ceil(count * (1 - q)), at least 1 when there is anything at all. The small
  // epsilon keeps 3948 * (1 - 0.9) = 394.8 from becoming 395.0000001.
  function topCount(count, q) {
    if (!count) return 0;
    return Math.max(1, Math.min(count, Math.ceil(count * (1 - q) - 1e-9)));
  }

  // The line for the top share of a list of numbers: the value of the k-th
  // highest. null for an empty list.
  function standoutLine(values, q) {
    var s = values.filter(function (v) { return typeof v === "number" && isFinite(v); })
      .sort(function (a, b) { return b - a; });
    var k = topCount(s.length, q);
    return k ? s[k - 1] : null;
  }

  // The standouts of a list of eligible entries: every entry at or above the
  // line, most first. { line, list }.
  function standouts(list, q) {
    var line = standoutLine(list.map(function (e) { return e.value; }), q);
    var out = line === null ? [] : list.filter(function (e) { return e.value >= line; });
    return { line: line, list: out.sort(byValue) };
  }

  // The column of points.topic for a level, by the document's levels list.
  function levelColumn(doc, level) {
    var levels = doc.levels || [];
    for (var k = 0; k < levels.length; k++) if (levels[k].level === level) return k;
    throw new Error("highlights: the document has no level " + level);
  }

  /* ----------------------------------------------------------------- summary */

  // A quantile of values sorted ascending, by the linear interpolation of
  // plotly.js's box trace (its default quartile method), which draws the
  // topic statistics page's box plots: position p * n - 0.5, clamped.
  function quantile(sorted, p) {
    var n = sorted.length;
    if (!n) return null;
    var r = p * n - 0.5;
    if (r <= 0) return sorted[0];
    if (r >= n - 1) return sorted[n - 1];
    var lo = Math.floor(r), frac = r - lo;
    return sorted[lo] + frac * (sorted[lo + 1] - sorted[lo]);
  }

  function summarize(values) {
    var s = values.slice().sort(function (a, b) { return a - b; });
    if (!s.length) return null;
    return {
      count: s.length, min: s[0], q1: quantile(s, 0.25), median: quantile(s, 0.5),
      q3: quantile(s, 0.75), max: s[s.length - 1]
    };
  }

  // Highest median first; then the higher upper quartile; then more comments;
  // then the topic's order in the document. Topics with no eligible comment last.
  function byMedian(a, b) {
    var sa = a.summary, sb = b.summary;
    if (!sa || !sb) return (sa ? -1 : sb ? 1 : 0) || (a.order - b.order);
    return (sb.median - sa.median) || (sb.q3 - sa.q3) || (sb.count - sa.count) || (a.order - b.order);
  }

  /* -------------------------------------------------------------- highlights */

  function highlights(doc, numbers, options) {
    var o = resolve(options);
    numbers = numbers || {};
    var col = levelColumn(doc, o.level);
    var topicOf = doc.points.topic[col];
    var C = eligible(doc, numbers.consensus, numbers.votes, o.minVotes);
    var V = eligible(doc, numbers.divisive, numbers.votes, o.minVotes);
    var SC = standouts(C, o.standout), SV = standouts(V, o.standout);

    var topics = [], slot = {};
    doc.topics.forEach(function (t, i) {
      if (t.level !== o.level) return;
      slot[i] = topics.length;
      topics.push({ id: t.id, name: t.name, level: t.level, index: i, order: topics.length,
        points: 0, c: [], v: [], sc: [], sv: [] });
    });
    for (var i = 0; i < topicOf.length; i++) {
      if (doc.points.id[i] === null || doc.points.id[i] === undefined) continue;
      if (slot[topicOf[i]] !== undefined) topics[slot[topicOf[i]]].points++;
    }
    var put = function (list, key) {
      list.forEach(function (e) {
        var s = slot[topicOf[e.index]];
        if (s === undefined) return;
        e = Object.assign({ topic: topics[s].id }, e);
        topics[s][key].push(e);
      });
    };
    put(C, "c"); put(V, "v");
    put(SC.list, "sc"); put(SV.list, "sv");

    var out = topics.map(function (t) {
      return {
        id: t.id, name: t.name, level: t.level, order: t.order, points: t.points,
        summary: summarize(t.c.map(function (e) { return e.value; })),
        divisiveSummary: summarize(t.v.map(function (e) { return e.value; })),
        consensus: top(t.sc, o.perTopic), divisive: top(t.sv, o.perTopic),
        standouts: { consensus: top(t.sc, t.sc.length), divisive: top(t.sv, t.sv.length) },
        special: { consensus: false, divisive: false }
      };
    }).sort(byMedian);

    // Special topics, over the topics that have a summary.
    var withC = out.filter(function (t) { return t.summary; });
    var withV = out.filter(function (t) { return t.divisiveSummary; });
    var medianLine = standoutLine(withC.map(function (t) { return t.summary.median; }), o.topicStandout);
    var spreads = withC.map(function (t) { return t.summary.q3 - t.summary.q1; }).sort(function (a, b) { return a - b; });
    var spreadLine = quantile(spreads, o.spreadQuantile);
    var divLine = standoutLine(withV.map(function (t) { return t.divisiveSummary.median; }), o.topicDivisive);
    withC.forEach(function (t) {
      t.special.consensus = t.summary.median >= medianLine && (t.summary.q3 - t.summary.q1) <= spreadLine;
    });
    withV.forEach(function (t) { t.special.divisive = t.divisiveSummary.median >= divLine; });

    var withTopic = function (e) {
      var s = slot[topicOf[e.index]];
      return Object.assign({ topic: s === undefined ? null : topics[s].id }, e);
    };
    return {
      settings: { n: o.n, perTopic: o.perTopic, minVotes: o.minVotes, level: o.level,
        standout: o.standout, topicStandout: o.topicStandout, spreadQuantile: o.spreadQuantile,
        topicDivisive: o.topicDivisive },
      eligible: { consensus: C.length, divisive: V.length },
      standout: {
        consensus: { line: SC.line, count: SC.list.length },
        divisive: { line: SV.line, count: SV.list.length }
      },
      special: {
        consensus: { medianLine: medianLine, spreadLine: spreadLine,
          count: out.filter(function (t) { return t.special.consensus; }).length },
        divisive: { medianLine: divLine, count: out.filter(function (t) { return t.special.divisive; }).length }
      },
      consensus: top(SC.list, o.n).map(withTopic),
      divisive: top(SV.list, o.n).map(withTopic),
      topics: out
    };
  }

  var PolisTopicMapHighlights = {
    DEFAULTS: DEFAULTS, normalizedConsensus: normalizedConsensus, extremityByTid: extremityByTid,
    votesByTid: votesByTid, numbersFrom: numbersFrom, eligible: eligible, top: top,
    topCount: topCount, standoutLine: standoutLine, standouts: standouts,
    quantile: quantile, summarize: summarize, highlights: highlights
  };

  root.PolisTopicMapHighlights = PolisTopicMapHighlights;
  if (typeof module !== "undefined" && module.exports) module.exports = PolisTopicMapHighlights;
})(typeof globalThis !== "undefined" ? globalThis : this);
