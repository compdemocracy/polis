/*
 * PolisVoteGraphic: the small graphic that sits beside one comment and shows
 * how each opinion group voted on it, as pure functions. Groups in; the exact
 * rectangles (and, for the poured form, the paths) to paint out; then a
 * function that paints them on a canvas context.
 *
 *   var G = PolisVoteGraphic;
 *   var groups = G.groupsFromMath(math, tid);       // or built by the caller
 *   var L = G.layout(groups, { x: 0, y: 0, width: 34, height: 14 }, { form: "rows" });
 *   G.draw(ctx, L);                                 // ctx already scaled by devicePixelRatio
 *   G.caption(L);                                   // the words for beneath it
 *
 * Two forms from the same input into the same box, so a page can toggle:
 *
 *   "rows"    (the default) one row per group, A at the top. From the left:
 *             agree, disagree, pass, as shares of those who voted; then those
 *             who did not vote, a light tint with dots, at the right end. The
 *             did-not-vote part takes its share of the group times
 *             `didNotVoteMax` (a quarter by default), so every row stays a
 *             nearly full bar and the four rows read as one whole form; with
 *             `didNotVoteMax: 1` the row's full length is every member (the
 *             first drawing). The exact numbers are in `readout`.
 *   "poured"  one column per group, A at the left. The upper bar is every
 *             member (the votes from the left, the rest dotted); the votes
 *             pour down from the voted part of the upper bar and widen, in an
 *             S bend, to fill the lower bar, where agree, disagree and pass
 *             are shares of those who voted across its whole width.
 *
 * Every rectangle is in CSS px on whole numbers, so at a device pixel ratio of
 * 1 or 2 each edge lands on a device pixel; segments of one bar share their
 * edges exactly (each starts where the last ends); nothing is stroked; there is
 * no outline, frame or padding around the bars. The paths of the poured form
 * start and end on the bars' whole-pixel edges and are painted one over the
 * other (all the votes, then agree and disagree, then agree), so no seam can
 * open between two of them.
 *
 * Counts are named counts (agree, disagree, pass), never signed vote values.
 */
(function (root) {
  "use strict";

  // The default colours, one set for each ground the map page has (white, and
  // #111214 dark): a dark agree and a light, strong red disagree, far apart in
  // lightness so the cut between them shows at a few pixels; a mid grey pass;
  // a light tint with dots for those who did not vote, darker than the ground
  // so every row keeps its full length. Any of them is overridden with the
  // `colors` setting ({ agree, disagree, pass, tint, dots, letter }).
  var SCHEMES = {
    light: {
      agree: "#004d40",
      disagree: "#eb5b3f",
      pass: "#8e949c",
      tint: "#e6e9ed",
      dots: "#8f96a0",
      letter: "#2b3038"
    },
    dark: {
      agree: "#4fd1a5",
      disagree: "#f0502d",
      pass: "#7d838c",
      tint: "#24272c",
      dots: "#6b717a",
      letter: "#d6d9de"
    }
  };

  // The colours of the first drawing: the report's vote bars (client-report,
  // globals.js: agree, disagree, pass) with a lighter tint and dots. Kept so a
  // page can still draw it: { colors: FIRST_SCHEMES.light, didNotVoteMax: 1 }.
  var FIRST_SCHEMES = {
    light: {
      agree: "rgb(46, 204, 113)",
      disagree: "rgb(231, 76, 60)",
      pass: "rgb(230, 230, 230)",
      tint: "rgb(246, 247, 248)",
      dots: "rgb(170, 175, 182)",
      letter: "#2b3038"
    },
    dark: {
      agree: "rgb(46, 204, 113)",
      disagree: "rgb(231, 76, 60)",
      pass: "rgb(230, 230, 230)",
      tint: "rgb(30, 32, 36)",
      dots: "rgb(120, 125, 134)",
      letter: "#d6d9de"
    }
  };

  // The face the package already draws its labels in.
  var DEFAULT_FACE = "Roboto, sans-serif";

  var DEFAULTS = {
    form: "rows",            // "rows" | "poured"
    scheme: "light",         // "light" | "dark"
    gap: 1,                  // px between two groups' rows or columns
    rowMax: 4,               // the tallest a row may be, px (the experiment's largest lane)
    few: 5,                  // a group with fewer agrees plus disagrees than this is drawn faint
    fewAlpha: 0.45,          // how faint
    dotPitch: 2,             // a dot every this many px in the remainder (did not vote, or did not see)
    sawPitch: 4,             // a dot every this many px where members saw it and did not vote, when that is known
    pouredHeights: [8, 12, 10], // upper bar, liquid, lower bar, in proportion (the experiment's inline heights)
    mouthMin: 2,             // the voted part of the upper bar is never narrower than this, px, when anyone voted
    letters: false,          // draw the group letters (rows form only, and only when a row is 6 px or taller)
    face: DEFAULT_FACE,
    didNotVoteMax: 0.25,     // rows: the did-not-vote part's length is its share of the group times this; 1 = every member to scale
    colors: null             // { agree, disagree, pass, tint, dots, letter }: any of them over the scheme's
  };

  function merge(settings) {
    var s = {};
    for (var k in DEFAULTS) s[k] = DEFAULTS[k];
    if (settings) for (var j in settings) if (settings[j] !== undefined) s[j] = settings[j];
    if (s.form !== "rows" && s.form !== "poured") throw new Error("form must be \"rows\" or \"poured\": " + s.form);
    if (!SCHEMES[s.scheme]) throw new Error("scheme must be \"light\" or \"dark\": " + s.scheme);
    var m = Number(s.didNotVoteMax);
    if (!(m > 0 && m <= 1)) throw new Error("didNotVoteMax must be above 0 and at most 1: " + s.didNotVoteMax);
    s.didNotVoteMax = m;
    if (s.colors !== null && typeof s.colors !== "object") throw new Error("colors must be an object of colours");
    return s;
  }

  function num(v) {
    var n = Number(v);
    return isFinite(n) && n > 0 ? Math.floor(n) : 0;
  }

  // One group's counts, cleaned: named counts only.
  function counts(g) {
    var a = num(g.agree), d = num(g.disagree), p = num(g.pass), dnv = num(g.didNotVote);
    var known = g.didNotSee !== undefined && g.didNotSee !== null && isFinite(Number(g.didNotSee));
    var dns = known ? Math.min(num(g.didNotSee), dnv) : null;
    return { label: String(g.label == null ? "" : g.label), agree: a, disagree: d, pass: p,
      voted: a + d + p, didNotVote: dnv, didNotSee: dns, members: a + d + p + dnv };
  }

  /*
   * Split `width` whole px among `values` in proportion, every edge a whole
   * number and the parts summing to `width` exactly. A value above zero gets at
   * least `min` px (1 unless given) when there is room for every such value to
   * have it (`min` may be one number for all, or one per value); then the parts stay as near their exact share as whole pixels
   * allow (largest remainder; ties go to the earlier value).
   */
  function apportion(values, width, min) {
    var total = 0, i, n = values.length, out = [];
    for (i = 0; i < n; i++) total += values[i];
    if (total <= 0 || width <= 0) { for (i = 0; i < n; i++) out.push(0); return out; }
    var ideal = values.map(function (v) { return v / total * width; });
    var nonzero = values.filter(function (v) { return v > 0; }).length;
    var mins = values.map(function () { return 0; });
    var want = values.map(function (v, k) { return v > 0 ? (Array.isArray(min) ? min[k] : (min || 1)) : 0; });
    var need = want.reduce(function (x, y) { return x + y; }, 0);
    for (i = 0; i < n; i++) if (values[i] > 0) mins[i] = need <= width ? want[i] : (nonzero <= width ? 1 : 0);
    var sum = 0;
    for (i = 0; i < n; i++) { out.push(Math.max(mins[i], Math.floor(ideal[i]))); sum += out[i]; }
    var order;
    while (sum < width) {          // give a pixel to the part furthest under its share
      order = null;
      for (i = 0; i < n; i++) if (values[i] > 0 && (order === null || ideal[i] - out[i] > ideal[order] - out[order])) order = i;
      out[order]++; sum++;
    }
    while (sum > width) {          // take one from the part furthest over its share that can spare it
      order = null;
      for (i = 0; i < n; i++) if (out[i] > mins[i] && (order === null || out[i] - ideal[i] > out[order] - ideal[order])) order = i;
      out[order]--; sum--;
    }
    return out;
  }

  // The segments of one bar of `width` px at (x, y, h): the votes from the left
  // (agree, disagree, pass), then what is not a vote. With `whole` true the
  // votes fill the bar (the poured form's lower bar).
  function barSegments(c, x, y, width, h, s, whole) {
    var segs = [];
    var votedW, restW;
    if (whole) { votedW = c.voted > 0 ? width : 0; restW = width - votedW; }
    else if (c.members === 0 || c.voted === 0) { votedW = 0; restW = width; }
    else if (s.form === "rows" && s.didNotVoteMax < 1 && c.didNotVote > 0 && width >= 2) {
      // the did-not-vote part, its share of the group times didNotVoteMax, at least a pixel
      restW = Math.min(width - 1, Math.max(1, Math.round(width * s.didNotVoteMax * c.didNotVote / c.members)));
      votedW = width - restW;
    }
    else {
      var split = apportion([c.voted, c.didNotVote], width, [s.form === "poured" ? s.mouthMin : 1, 1]);
      votedW = split[0]; restW = split[1];
    }
    var parts = apportion([c.agree, c.disagree, c.pass], votedW, 1);
    var kinds = ["agree", "disagree", "pass"], cx = x, i;
    for (i = 0; i < 3; i++) {
      if (parts[i] > 0) segs.push({ kind: kinds[i], x: cx, y: y, w: parts[i], h: h });
      cx += parts[i];
    }
    if (restW > 0) {
      if (c.didNotSee === null || c.didNotVote === 0) segs.push({ kind: "didNotVote", x: cx, y: y, w: restW, h: h });
      else {
        var r = apportion([c.didNotVote - c.didNotSee, c.didNotSee], restW, 1);
        if (r[0] > 0) segs.push({ kind: "sawDidNotVote", x: cx, y: y, w: r[0], h: h });
        if (r[1] > 0) segs.push({ kind: "didNotSee", x: cx + r[0], y: y, w: r[1], h: h });
      }
    }
    return { segments: segs, votedWidth: votedW };
  }

  // The dots of a remainder segment: 1 px squares on a grid fixed to the box,
  // so neighbouring rows' dots line up.
  function dotsOf(seg, box, pitch) {
    var out = [];
    for (var y = seg.y; y < seg.y + seg.h; y++) {
      if ((y - seg.y) % pitch !== 0) continue;
      for (var x = seg.x; x < seg.x + seg.w; x++) if ((x - box.x) % pitch === 0) out.push({ x: x, y: y, w: 1, h: 1 });
    }
    return out;
  }

  function snapBox(box) {
    var x0 = Math.ceil(box.x || 0), y0 = Math.ceil(box.y || 0);
    var x1 = Math.floor((box.x || 0) + box.width), y1 = Math.floor((box.y || 0) + box.height);
    return { x: x0, y: y0, width: Math.max(0, x1 - x0), height: Math.max(0, y1 - y0) };
  }

  function empty(box, s, cs, why) {
    return { form: s.form, scheme: s.scheme, box: box, rects: [], paths: [], texts: [], groups: cs, empty: true, why: why };
  }

  function palette(s) {
    var col = {}, base = SCHEMES[s.scheme], k;
    for (k in base) col[k] = base[k];
    if (s.colors) for (k in base) if (s.colors[k]) col[k] = String(s.colors[k]);
    return col;
  }

  function finish(L, s) {
    var col = palette(s);
    var rects = [];
    L.bars.forEach(function (bar) {
      bar.segments.forEach(function (seg) {
        var rem = seg.kind === "didNotVote" || seg.kind === "didNotSee" || seg.kind === "sawDidNotVote";
        var alpha = !rem && bar.few ? s.fewAlpha : 1;
        rects.push({ kind: seg.kind, x: seg.x, y: seg.y, w: seg.w, h: seg.h, fill: rem ? col.tint : col[seg.kind], alpha: alpha, group: bar.group });
        if (rem) {
          var pitch = seg.kind === "sawDidNotVote" ? s.sawPitch : s.dotPitch;
          dotsOf(seg, L.box, pitch).forEach(function (d) {
            rects.push({ kind: "dot", x: d.x, y: d.y, w: 1, h: 1, fill: col.dots, alpha: 1, group: bar.group });
          });
        }
      });
    });
    L.paths.forEach(function (p) { p.fill = col[p.kind]; p.alpha = L.bars[p.bar].few ? s.fewAlpha : 1; });
    L.rects = rects;
    return L;
  }

  function layoutRows(cs, box, s) {
    var n = cs.length, g = s.gap;
    var rowH = Math.min(s.rowMax, Math.floor((box.height - (n - 1) * g) / n));
    if (rowH < 1) return empty(box, s, cs, "the box is too short for " + n + " rows");
    var letters = s.letters && rowH >= 6;
    var gutter = letters ? Math.ceil(rowH * 0.8) + 2 : 0;
    var barX = box.x + gutter, barW = box.width - gutter;
    if (barW < 4) return empty(box, s, cs, "the box is too narrow");
    var used = n * rowH + (n - 1) * g;
    var top = box.y + Math.floor((box.height - used) / 2);
    var L = { form: "rows", scheme: s.scheme, box: box, bars: [], paths: [], texts: [], groups: cs, empty: false,
      row: { height: rowH, gap: g, top: top, x: barX, width: barW } };
    cs.forEach(function (c, i) {
      var y = top + i * (rowH + g);
      var b = barSegments(c, barX, y, barW, rowH, s, false);
      L.bars.push({ group: i, part: "row", x: barX, y: y, w: barW, h: rowH, segments: b.segments, few: c.agree + c.disagree < s.few });
      if (letters) L.texts.push({ text: c.label, x: box.x, y: y + rowH, font: "500 " + rowH + "px " + s.face, fill: palette(s).letter });
    });
    return finish(L, s);
  }

  // The liquid's width between the bars, as the S bend of the experiment:
  // leaves the upper bar straight down and lands on the lower bar straight down.
  function bend(t) { return 3 * t * t - 2 * t * t * t; }

  function layoutPoured(cs, box, s) {
    var n = cs.length, g = s.gap;
    var colW = Math.floor((box.width - (n - 1) * g) / n);
    if (colW < 3) return empty(box, s, cs, "the box is too narrow for " + n + " columns");
    if (box.height < 3) return empty(box, s, cs, "the box is too short");
    var p = s.pouredHeights, sum = p[0] + p[1] + p[2];
    var hU = Math.max(1, Math.round(box.height * p[0] / sum));
    var hS = Math.max(1, Math.round(box.height * p[2] / sum));
    var hL = box.height - hU - hS;
    if (hL < 1) return empty(box, s, cs, "the box is too short");
    var used = n * colW + (n - 1) * g;
    var left = box.x + Math.floor((box.width - used) / 2);
    var y0 = box.y, yL = y0 + hU, yS = yL + hL;
    var L = { form: "poured", scheme: s.scheme, box: box, bars: [], paths: [], texts: [], groups: cs, empty: false,
      column: { width: colW, gap: g, left: left, upper: hU, liquid: hL, lower: hS } };
    cs.forEach(function (c, i) {
      var x = left + i * (colW + g);
      var few = c.agree + c.disagree < s.few;
      var up = barSegments(c, x, y0, colW, hU, s, false);
      L.bars.push({ group: i, part: "upper", x: x, y: y0, w: colW, h: hU, segments: up.segments, few: few });
      if (c.voted === 0) {
        // nobody voted: the whole column is what is not a vote
        var restL = barSegments(c, x, yL, colW, hL + hS, s, false);
        L.bars.push({ group: i, part: "lower", x: x, y: yL, w: colW, h: hL + hS, segments: restL.segments, few: few });
        return;
      }
      var lo = barSegments(c, x, yS, colW, hS, s, true);
      L.bars.push({ group: i, part: "lower", x: x, y: yS, w: colW, h: hS, segments: lo.segments, few: few });
      // The right edge of each band of votes, at the upper bar's foot and on
      // the lower bar's top, read from the two bars' own segments.
      var edge = function (segs, k) {
        var e = x;
        segs.forEach(function (sg) { if (["agree", "disagree", "pass"].indexOf(sg.kind) >= 0 && ["agree", "disagree", "pass"].indexOf(sg.kind) <= k) e = sg.x + sg.w; });
        return e;
      };
      var kinds = ["pass", "disagree", "agree"];      // painted in this order, each over the last
      [2, 1, 0].forEach(function (k, j) {
        var counted = [c.agree, c.agree + c.disagree, c.voted][k];
        if (counted === 0) return;
        var a = edge(up.segments, k), b = edge(lo.segments, k);
        var pts = [[x, yL]], steps = Math.max(2, hL * 2);
        for (var q = 0; q <= steps; q++) {
          var t = q / steps;
          pts.push([a + (b - a) * bend(t), yL + hL * t]);
        }
        pts.push([x, yS]);
        L.paths.push({ kind: kinds[j], bar: L.bars.length - 1, points: pts });
      });
    });
    return finish(L, s);
  }

  /*
   * layout(groups, box, settings): what to paint, in CSS px.
   *   groups: [{ label, agree, disagree, pass, didNotVote, didNotSee? }, ...] in
   *           order (A first); counts are named counts, never signed values;
   *           didNotSee, when known, is how many of those who did not vote never
   *           saw the comment.
   *   box:    { x, y, width, height } in CSS px; snapped inward to whole px.
   * Returns { form, scheme, box, rects, paths, texts, bars, groups, empty }.
   * rects: { kind, x, y, w, h, fill, alpha } (kind agree, disagree, pass,
   * didNotVote, didNotSee, sawDidNotVote, or dot); paths (poured only):
   * { kind, fill, alpha, points: [[x, y], ...] }, closed, filled; texts: the
   * group letters when asked for. A box too small gives empty: true and nothing
   * to paint.
   */
  function layout(groups, box, settings) {
    var s = merge(settings);
    var cs = (groups || []).map(counts);
    var b = snapBox(box || { x: 0, y: 0, width: 0, height: 0 });
    if (!cs.length) return empty(b, s, cs, "no groups");
    if (!b.width || !b.height) return empty(b, s, cs, "the box is empty");
    return s.form === "poured" ? layoutPoured(cs, b, s) : layoutRows(cs, b, s);
  }

  // draw(ctx, layoutResult): paints a layout on a 2D canvas context whose
  // transform the caller has set (scaled by devicePixelRatio). Fills only:
  // no stroke, no clearing, nothing outside the layout's box.
  function draw(ctx, L) {
    if (!L || L.empty) return;
    ctx.save();
    var paint = function (item) {
      ctx.globalAlpha = item.alpha == null ? 1 : item.alpha;
      ctx.fillStyle = item.fill;
    };
    L.rects.forEach(function (r) { if (r.kind !== "dot") { paint(r); ctx.fillRect(r.x, r.y, r.w, r.h); } });
    L.rects.forEach(function (r) { if (r.kind === "dot") { paint(r); ctx.fillRect(r.x, r.y, r.w, r.h); } });
    L.paths.forEach(function (p) {
      paint(p);
      ctx.beginPath();
      ctx.moveTo(p.points[0][0], p.points[0][1]);
      for (var i = 1; i < p.points.length; i++) ctx.lineTo(p.points[i][0], p.points[i][1]);
      ctx.closePath();
      ctx.fill();
    });
    L.texts.forEach(function (t) {
      ctx.globalAlpha = 1;
      ctx.fillStyle = t.fill;
      ctx.font = t.font;
      ctx.textBaseline = "alphabetic";
      ctx.fillText(t.text, t.x, t.y);
    });
    ctx.restore();
  }

  // caption(layoutResult or settings): the words for beneath the graphic, so
  // every page says the same thing.
  function caption(L) {
    var seen = !!(L && L.groups && L.groups.some(function (c) { return c.didNotSee !== null; }));
    var form = L && L.form === "poured" ? "poured" : "rows";
    var who = form === "poured" ? "Each column is a group, A at the left." : "Each row is a group, A at the top.";
    var dots = seen ? "Dotted: did not see it; sparse dots: saw it, did not vote." : "Dotted: did not vote.";
    return who + " Agree, disagree, pass: of those who voted. " + dots;
  }

  /*
   * groupsFromMath(math, tid): the groups for one comment from the math
   * result (GET /api/v3/math/pca2): group-votes[gid].votes[tid] holds A
   * (agrees), D (disagrees) and S (votes of any kind, passes included), and
   * group-votes[gid]["n-members"] the group's size. Pass is S - A - D; did not
   * vote is n-members - S. The groups are lettered A, B, C... in order of id.
   */
  function groupsFromMath(math, tid) {
    var gv = (math && math["group-votes"]) || {};
    var ids = Object.keys(gv).sort(function (x, y) { return Number(x) - Number(y); });
    return ids.map(function (id, i) {
      var g = gv[id], v = (g.votes && g.votes[tid]) || { A: 0, D: 0, S: 0 };
      var members = num(g["n-members"]);
      var seenVotes = num(v.S);
      return { label: String.fromCharCode(65 + i), agree: num(v.A), disagree: num(v.D),
        pass: Math.max(0, seenVotes - num(v.A) - num(v.D)), didNotVote: Math.max(0, members - seenVotes) };
    });
  }

  /*
   * readout(groups or layoutResult): the numbers behind the graphic, for a page
   * to show on hover or click, in plain words. Returns { groups, lines, text }:
   * groups [{ label, agree, disagree, pass, didNotVote, didNotSee, voted,
   * members, text }] in order; lines, each group's text; text, the lines
   * joined by newlines. For example "Group A: 118 agreed, 9 disagreed, 52
   * passed, 64 did not vote (179 of 243 voted)."
   */
  function readout(x) {
    var cs = Array.isArray(x) ? x.map(counts) : ((x && x.groups) || []).map(counts);
    var out = cs.map(function (c) {
      var t = "Group " + c.label + ": " + c.agree + " agreed, " + c.disagree + " disagreed, " + c.pass + " passed, " +
        c.didNotVote + " did not vote (" + c.voted + " of " + c.members + " voted)";
      if (c.didNotSee !== null) t += "; of those who did not vote, " + c.didNotSee + " did not see it";
      return { label: c.label, agree: c.agree, disagree: c.disagree, pass: c.pass, didNotVote: c.didNotVote,
        didNotSee: c.didNotSee, voted: c.voted, members: c.members, text: t + "." };
    });
    var lines = out.map(function (r) { return r.text; });
    return { groups: out, lines: lines, text: lines.join("\n") };
  }

  /*
   * hit(layoutResult, x, y): the index of the group whose row (or column) is
   * under the point (x, y), in the layout's CSS px, or -1 outside the box. The
   * gap between two rows belongs to the row above it, so every point in the
   * box names a group.
   */
  function hit(L, x, y) {
    if (!L || L.empty || !L.groups.length) return -1;
    var b = L.box;
    if (x < b.x || y < b.y || x >= b.x + b.width || y >= b.y + b.height) return -1;
    var n = L.groups.length, i;
    if (L.form === "poured") i = Math.floor((x - L.column.left) / (L.column.width + L.column.gap));
    else i = Math.floor((y - L.row.top) / (L.row.height + L.row.gap));
    return Math.max(0, Math.min(n - 1, i));
  }

  var PolisVoteGraphic = { DEFAULTS: DEFAULTS, SCHEMES: SCHEMES, FIRST_SCHEMES: FIRST_SCHEMES, DEFAULT_FACE: DEFAULT_FACE,
    layout: layout, draw: draw, caption: caption, readout: readout, hit: hit, groupsFromMath: groupsFromMath, apportion: apportion };

  root.PolisVoteGraphic = PolisVoteGraphic;
  if (typeof module !== "undefined" && module.exports) module.exports = PolisVoteGraphic;
})(typeof globalThis !== "undefined" ? globalThis : this);
