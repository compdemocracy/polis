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
 *   "rows"    (the default) one row per group, A at the top, four rows filled
 *             so they read as one solid block. Each row runs the full width
 *             (inside a 1 px inset under 16 px tall, else 2 px); agree fills
 *             it from the left to the group's share of agree, (agree + 1) /
 *             (agree + disagree + 2), and disagree fills the rest to the right
 *             end. Pass and those who did not vote are not drawn; their counts
 *             are in `readout`. The box height is split into the rows and a
 *             1 px lighter line between each two rows (the row above, half
 *             strength), every edge on a whole pixel: row i runs from
 *             round(i * (h + 1) / n) to round((i + 1) * (h + 1) / n) - 1. A
 *             1 px line marks the middle (half agree), the full height. A group
 *             with fewer than `few` agrees plus disagrees is drawn faint.
 *             With `showNonVoters: true` the rows are the earlier drawing:
 *             agree, disagree, pass, as shares of those who voted; then those
 *             who did not vote, a light tint with dots, at the right end,
 *             taking their share of the group times `didNotVoteMax` (a quarter
 *             by default; `didNotVoteMax: 1` draws every member to scale).
 *   "poured"  one column per group, A at the left. The upper bar is every
 *             member (the votes from the left, the rest dotted); the votes
 *             pour down from the voted part of the upper bar and widen, in an
 *             S bend, to fill the lower bar, where agree, disagree and pass
 *             are shares of those who voted across its whole width. The
 *             did-not-vote dots carry on below the upper bar into the space
 *             the liquid leaves at its upper right, behind the liquid
 *             (`pouredDots`, on by default).
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
  // `colors` setting ({ agree, disagree, pass, tint, dots, letter, middle,
  // hatchTint }). `middle` is the middle line's colour; `hatchTint` the ground
  // under the disagree lines when disagree is drawn hatched.
  var SCHEMES = {
    light: {
      agree: "#004d40",
      disagree: "#eb5b3f",
      pass: "#8e949c",
      tint: "#e6e9ed",
      dots: "#8f96a0",
      letter: "#2b3038",
      middle: "#16191d",
      hatchTint: "#f7d3ca"
    },
    dark: {
      agree: "#4fd1a5",
      disagree: "#f0502d",
      pass: "#7d838c",
      tint: "#24272c",
      dots: "#6b717a",
      letter: "#d6d9de",
      middle: "#e8eaed",
      hatchTint: "#4a2219"
    }
  };

  // The colours of the first drawing: the report's vote bars (client-report,
  // globals.js: agree, disagree, pass) with a lighter tint and dots. Kept so a
  // page can still draw it: { colors: FIRST_SCHEMES.light, didNotVoteMax: 1, showNonVoters: true }.
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
    didNotVoteMax: 0.25,     // rows with showNonVoters: the did-not-vote part's length is its share of the group times this; 1 = every member to scale
    colors: null,            // { agree, disagree, pass, tint, dots, letter, middle, hatchTint }: any of them over the scheme's
    showNonVoters: false,    // rows: true draws pass and those who did not vote (the earlier drawing: gap, rowMax, letters, dots, didNotVoteMax)
    inset: null,             // rows: px left empty at each end of a row; null = 1 when the box is under 16 px tall, else 2
    separator: 1,            // rows: px of lighter line between two rows (whole px; 0 = rows touch)
    separatorAlpha: 0.5,     // rows: the line's strength, the row above it at this alpha (0 = the ground shows)
    middle: true,            // rows: a 1 px line down the middle, where agree is half
    middleAlpha: 0.6,        // its strength
    disagreeFill: "solid",   // rows: "solid", or "hatch" (diagonal 1 px lines of disagree over hatchTint)
    hatchPitch: 3,           // rows: a hatch line every this many px, along the diagonal
    pouredDots: true,        // poured: the did-not-vote dots carry on into the space the liquid leaves at its upper right
    dotSize: null            // the dots' side, whole px (their spacing grows with it); null = 1, or in the poured form 1 px per 28 px of the box's height, at most a ninth of a column
  };

  function merge(settings) {
    var s = {};
    for (var k in DEFAULTS) s[k] = DEFAULTS[k];
    if (settings) for (var j in settings) if (settings[j] !== undefined) s[j] = settings[j];
    if (s.form !== "rows" && s.form !== "poured") throw new Error("form must be \"rows\" or \"poured\": " + s.form);
    if (!SCHEMES[s.scheme]) throw new Error("scheme must be \"light\" or \"dark\": " + s.scheme);
    if (s.disagreeFill !== "solid" && s.disagreeFill !== "hatch") throw new Error("disagreeFill must be \"solid\" or \"hatch\": " + s.disagreeFill);
    var sep = Number(s.separator);
    if (!(sep >= 0 && Math.floor(sep) === sep)) throw new Error("separator must be a whole number of px, 0 or more: " + s.separator);
    s.separator = sep;
    if (s.inset !== null) {
      var ins = Number(s.inset);
      if (!(ins >= 0 && Math.floor(ins) === ins)) throw new Error("inset must be null or a whole number of px, 0 or more: " + s.inset);
      s.inset = ins;
    }
    ["separatorAlpha", "middleAlpha"].forEach(function (key) {
      var a = Number(s[key]);
      if (!(a >= 0 && a <= 1)) throw new Error(key + " must be from 0 to 1: " + s[key]);
      s[key] = a;
    });
    var hp = Number(s.hatchPitch);
    if (!(hp >= 2 && Math.floor(hp) === hp)) throw new Error("hatchPitch must be a whole number, 2 or more: " + s.hatchPitch);
    s.hatchPitch = hp;
    if (s.dotSize !== null) {
      var ds = Number(s.dotSize);
      if (!(ds >= 1 && Math.floor(ds) === ds)) throw new Error("dotSize must be null or a whole number of px, 1 or more: " + s.dotSize);
      s.dotSize = ds;
    }
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

  // The dots of a remainder segment: squares of `size` px (1 unless given) on
  // a grid fixed to the box, so neighbouring rows' dots line up; only whole
  // dots that fit inside the segment.
  function dotsOf(seg, box, pitch, size) {
    var out = [], d = size || 1;
    for (var y = seg.y; y + d <= seg.y + seg.h; y++) {
      if ((y - seg.y) % pitch !== 0) continue;
      for (var x = seg.x; x + d <= seg.x + seg.w; x++) if ((x - box.x) % pitch === 0) out.push({ x: x, y: y, w: d, h: d });
    }
    return out;
  }

  /*
   * dotSizeFor(n, box, settings): the side of a did-not-vote dot, whole px, for
   * n groups in the box. The setting dotSize when given; else 1 in the rows
   * (they are at most a few px tall), and in the poured form 1 px per 28 px of
   * the box's height (the label size, 42 by 28, keeps 1 px dots), never more
   * than a ninth of a column's width, at least 1. The dots' spacing is dotPitch
   * (sawPitch) times this side, so a dot covers the same share of its space at
   * every size. Every layout carries it as `dotSize`.
   */
  function dotSizeFor(n, box, settings) {
    var s = merge(settings);
    var b = snapBox(box || { x: 0, y: 0, width: 0, height: 0 });
    var k = Math.max(1, Math.floor(Number(n) || 1));
    return dotUnit(s, b, Math.floor((b.width - (k - 1) * s.gap) / k));
  }
  function dotUnit(s, box, colW) {
    if (s.dotSize !== null) return s.dotSize;
    if (s.form !== "poured") return 1;
    var byHeight = Math.floor(box.height / 28);
    var byWidth = colW > 0 ? Math.floor(colW / 9) : byHeight;
    return Math.max(1, Math.min(byHeight, byWidth));
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
    var u = L.dotSize || 1;
    L.bars.forEach(function (bar) {
      bar.segments.forEach(function (seg) {
        var rem = seg.kind === "didNotVote" || seg.kind === "didNotSee" || seg.kind === "sawDidNotVote";
        var alpha = !rem && bar.few ? s.fewAlpha : 1;
        rects.push({ kind: seg.kind, x: seg.x, y: seg.y, w: seg.w, h: seg.h, fill: rem ? col.tint : col[seg.kind], alpha: alpha, group: bar.group });
        if (rem) {
          var pitch = seg.kind === "sawDidNotVote" ? s.sawPitch : s.dotPitch;
          dotsOf(seg, L.box, pitch * u, u).forEach(function (d) {
            rects.push({ kind: "dot", x: d.x, y: d.y, w: u, h: u, fill: col.dots, alpha: 1, group: bar.group });
          });
        }
      });
    });
    (L.liquidDots || []).forEach(function (d) {
      rects.push({ kind: "dot", x: d.x, y: d.y, w: u, h: u, fill: col.dots, alpha: 1, group: d.group, beside: "liquid" });
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
    var L = { form: "rows", drawing: "nonVoters", scheme: s.scheme, box: box, bars: [], paths: [], texts: [], groups: cs, empty: false, dotSize: dotUnit(s, box, 0),
      row: { height: rowH, gap: g, top: top, x: barX, width: barW } };
    cs.forEach(function (c, i) {
      var y = top + i * (rowH + g);
      var b = barSegments(c, barX, y, barW, rowH, s, false);
      L.bars.push({ group: i, part: "row", x: barX, y: y, w: barW, h: rowH, segments: b.segments, few: c.agree + c.disagree < s.few });
      if (letters) L.texts.push({ text: c.label, x: box.x, y: y + rowH, font: "500 " + rowH + "px " + s.face, fill: palette(s).letter });
    });
    return finish(L, s);
  }

  /*
   * rowBands(n, height, separator): the whole-pixel tops and heights of n rows
   * filling `height` px with `separator` px between each two. Row i runs from
   * round(i * p) to round((i + 1) * p) - separator, p = (height + separator) / n,
   * so the rows and lines fill the height exactly and each row is within a
   * pixel of its even share.
   */
  function rowBands(n, height, separator) {
    var out = [], p = (height + separator) / n;
    for (var i = 0; i < n; i++) {
      var y0 = Math.round(i * p), y1 = Math.round((i + 1) * p) - separator;
      out.push({ y: y0, h: y1 - y0 });
    }
    return out;
  }

  // The share of agree drawn for a group: agree of those who agreed or
  // disagreed, with one of each added, so a group with no such votes sits at
  // the middle (and is drawn faint).
  function agreeShare(c) { return (c.agree + 1) / (c.agree + c.disagree + 2); }

  // The default rows: four rows filled, the full width, agree then disagree.
  function layoutRowsFilled(cs, box, s) {
    var n = cs.length, sep = s.separator;
    var bands = rowBands(n, box.height, sep);
    if (bands.some(function (b) { return b.h < 1; })) return empty(box, s, cs, "the box is too short for " + n + " rows");
    var inset = s.inset === null ? (box.height < 16 ? 1 : 2) : s.inset;
    var x0 = box.x + inset, W = box.width - 2 * inset;
    if (W < 2) return empty(box, s, cs, "the box is too narrow");
    var col = palette(s);
    var L = { form: "rows", drawing: "filled", scheme: s.scheme, box: box, bars: [], paths: [], texts: [], groups: cs, empty: false,
      row: { height: Math.max.apply(null, bands.map(function (b) { return b.h; })), gap: sep, top: box.y, x: x0, width: W, inset: inset,
        tops: bands.map(function (b) { return box.y + b.y; }), heights: bands.map(function (b) { return b.h; }) } };
    var rects = [];
    cs.forEach(function (c, i) {
      var y = box.y + bands[i].y, h = bands[i].h;
      var share = agreeShare(c);
      var aw = Math.max(0, Math.min(W, Math.round(share * W)));
      var few = c.agree + c.disagree < s.few;
      var alpha = few ? s.fewAlpha : 1;
      var segsI = [];
      if (aw > 0) segsI.push({ kind: "agree", x: x0, y: y, w: aw, h: h });
      if (W - aw > 0) segsI.push({ kind: "disagree", x: x0 + aw, y: y, w: W - aw, h: h });
      L.bars.push({ group: i, part: "row", x: x0, y: y, w: W, h: h, segments: segsI, few: few, share: share });
      segsI.forEach(function (sg) {
        var hatched = sg.kind === "disagree" && s.disagreeFill === "hatch";
        rects.push({ kind: sg.kind, x: sg.x, y: sg.y, w: sg.w, h: sg.h, fill: hatched ? col.hatchTint : col[sg.kind], alpha: alpha, group: i });
        if (hatched) {
          for (var py = sg.y; py < sg.y + sg.h; py++) for (var px = sg.x; px < sg.x + sg.w; px++) {
            if ((px - box.x + py - box.y) % s.hatchPitch === 0) rects.push({ kind: "hatch", x: px, y: py, w: 1, h: 1, fill: col.disagree, alpha: alpha, group: i });
          }
        }
      });
      // the lighter line under this row: the row again, at separatorAlpha
      if (i < n - 1 && sep > 0 && s.separatorAlpha > 0) {
        segsI.forEach(function (sg) {
          rects.push({ kind: "separator", x: sg.x, y: y + h, w: sg.w, h: sep, fill: col[sg.kind], alpha: alpha * s.separatorAlpha, group: i });
        });
      }
    });
    if (s.middle && s.middleAlpha > 0) {
      rects.push({ kind: "middle", x: x0 + Math.floor(W / 2), y: box.y, w: 1, h: box.height, fill: col.middle, alpha: s.middleAlpha, group: -1 });
    }
    L.rects = rects;
    return L;
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
    var u = dotUnit(s, box, colW), pitch = s.dotPitch * u;
    var L = { form: "poured", scheme: s.scheme, box: box, bars: [], paths: [], texts: [], groups: cs, empty: false, liquidDots: [], dotSize: u,
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
      // Those who did not vote, as the upper bar's dots carried on down into
      // the space the liquid leaves at its upper right, on the ground, behind
      // the liquid (the liquid is painted over them).
      if (s.pouredDots && c.didNotVote > 0) {
        var a2 = edge(up.segments, 2), b2 = edge(lo.segments, 2);
        for (var py = yL; py + u <= yS; py++) {
          if ((py - box.y) % pitch !== 0) continue;
          var t2 = (py + u - yL) / hL, right = a2 + (b2 - a2) * bend(Math.min(1, t2));
          for (var px = x; px + u <= x + colW; px++) {
            if ((px - box.x) % pitch === 0 && px >= Math.ceil(right)) L.liquidDots.push({ x: px, y: py, group: i });
          }
        }
      }
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
    if (s.form === "poured") return layoutPoured(cs, b, s);
    return s.showNonVoters ? layoutRows(cs, b, s) : layoutRowsFilled(cs, b, s);
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
    var filled = form === "rows" && !(L && (L.drawing === "nonVoters" || L.showNonVoters === true));
    if (filled) return "Each row is a group, A at the top. Agree from the left, disagree to the right end, of those who agreed or disagreed; the line marks half.";
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
    else if (L.row.tops) { i = 0; while (i + 1 < n && L.row.tops[i + 1] <= y) i++; }
    else i = Math.floor((y - L.row.top) / (L.row.height + L.row.gap));
    return Math.max(0, Math.min(n - 1, i));
  }

  var PolisVoteGraphic = { DEFAULTS: DEFAULTS, SCHEMES: SCHEMES, FIRST_SCHEMES: FIRST_SCHEMES, DEFAULT_FACE: DEFAULT_FACE,
    layout: layout, draw: draw, caption: caption, readout: readout, hit: hit, groupsFromMath: groupsFromMath, apportion: apportion,
    rowBands: rowBands, dotSizeFor: dotSizeFor, agreeShare: function (g) { return agreeShare(counts(g)); } };

  root.PolisVoteGraphic = PolisVoteGraphic;
  if (typeof module !== "undefined" && module.exports) module.exports = PolisVoteGraphic;
})(typeof globalThis !== "undefined" ? globalThis : this);
