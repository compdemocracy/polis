/*
 * PolisTopicMapDense: the rules of the dense drawing of the topic map, as pure
 * functions. A document and a settings object in; hues, sizes, wrapped and
 * placed names, density grids and outline segments out. Nothing here touches
 * a page or a canvas: text is measured by a function the caller passes, so the
 * same rules run in a browser (measuring with a canvas) and in Node tests
 * (measuring with recorded widths).
 *
 *   var model = PolisTopicMapDense.prepare(doc, PolisTopicMapDense.PRESET_DENSE);
 *   var frame = PolisTopicMapDense.layout(model, { width: 1408, height: 803, measure: measure });
 *   var shapes = PolisTopicMapDense.zoneShapes(model, frame);
 *   // measure(text, { weight, size, family, letterSpacing, font }) returns the width in px
 *
 * The rules are those of the dense map as it was drawn and approved: one
 * renderer told everything by a settings object. Its arithmetic is kept here
 * in the order it was written, so that the same document and the same widths
 * give the same values to the last bit; do not reorder it.
 *
 * Geometry is linear, with y flipped: screen x = x * s + tx, screen y =
 * -y * s + ty. The first view fits the extent of every point.
 */
(function (root) {
  "use strict";

  /* ---------------------------------------------------------------- settings */

  // The face the package already draws its labels in (the neutral theme's
  // font.family). Both families of the dense drawing default to it; the
  // package has no monospace face, so the mono treatment (the zone names)
  // falls back to the same face. Either can be swapped by a setting.
  var DEFAULT_FACE = "Roboto, sans-serif";

  // The renderer's defaults, as written. A settings object replaces any of
  // these keys whole (a shallow merge), as the renderer did.
  var DEFAULTS = {
    scheme: "light",
    layers: [3, 2, 1, 0],
    size: "layer+count",            // "layer+count" | "count" | "layer"
    sizes: { 3: [22, 34], 2: [13, 19], 1: [10, 14], 0: [8, 11] },
    countRange: [8, 30],            // for size "count"
    minFont: 7,
    caps: {},                       // {layer: letter spacing in em}: capitals with that spacing
    wrap: { 3: 13, 2: 13, 1: 13, 0: 12 },
    colour: "zone",                 // "zone" | "zoneNearest" | "angle" | "mono"
    zoneLayer: 3,
    zones: "halo",                  // "halo" | "outline" | "tint" | "none"
    subOutline: null,               // the layer whose topics get a dashed outline too
    dots: "grey",                   // "grey" | "tint" | "colour"
    dotRadius: 1.5,
    dynamic: false,
    maxShift: 1.6,                  // how far a name may move, in multiples of max(font, topic radius on screen)
    leader: false,
    comments: false,
    commentFont: 8,
    pad: 0.03,
    fadeCoarse: false,
    nameSwitch: false,
    fontSans: DEFAULT_FACE,         // the family of names not in monoLayers (CSS font-family list)
    fontMono: DEFAULT_FACE          // the family of names in monoLayers
  };

  // The dense map as approved: three labelled layers (zones, districts and
  // the finest topics), the zones tinted and outlined, the districts dashed,
  // the zone names in mono capitals. Layers are named by role; on a document
  // of four levels the roles are levels 3, 2 and 0.
  var PRESET_DENSE = {
    scheme: "light",
    layers: ["zone", "district", "finest"],
    size: "layer+count",
    sizes: { zone: [17, 25], district: [12, 16], finest: [8, 10.5] },
    minFont: 7,
    caps: { zone: 0.04, district: 0.03 },
    monoLayers: ["zone"],
    wrap: { zone: 15, district: 14, finest: 12 },
    colour: "zoneNearest",
    zoneLayer: "zone",
    zones: "tint",
    subOutline: "district",
    dots: "grey",
    // Names follow the room the map has for them. With fewer names than the
    // map has room for (more than `area` px² of map per name drawn), every
    // name grows by sqrt(area per name / area), at most `grow` times; a grown
    // name is at most `maxPx`, and at most `spread` times its topic's spread
    // on screen at the fit (its zone's extent), never under its size at rest.
    // A map with as many names as Bowling Green's has no room: nothing grows.
    room: { area: 40000, grow: 1.4, maxPx: 36, spread: 0.6 }
  };

  // Zoom and the comments it shows, with values chosen on a conversation of
  // 125 comments: the limits of the zoom as multiples of the fitted scale;
  // how long the view
  // must rest before names are placed again (as after a resize); the least
  // radius, in px, a dot answers the pointer at; and when the points in view
  // are few enough (maxPoints) and far enough apart (the median distance from
  // each to its nearest neighbour, in px, at least minSpacing), each point
  // with text is labelled with its first words: font px, words at the fit,
  // and words and wrap (in characters) added per doubling of the zoom. slot,
  // when set to { w, h, gap }, reserves a box that size beside each comment
  // label, gap px to the right of its text; nothing is drawn in it.
  //
  // Zoomed in (any view closer than the fit), the names follow steps: the
  // zoom, as a multiple of the fit, at which each next finer layer becomes
  // the focus. With layers from coarse to fine, below steps[0] every layer is
  // placed as at rest; from steps[i] the (i+1)-th layer is the focus; from
  // the step after the finest layer, the comments are (when the document has
  // text and the points in view pass maxPoints and minSpacing; otherwise the
  // finest layer stays the focus). A layer past the preset's steps doubles
  // the last. Zoomed in, a name is never shrunk to fit (it is placed at its
  // size or not at all), so no name gets smaller than it was at rest; the
  // focus layer and the layers above it are drawn at least focusSize (by
  // count in the layer, as the at-rest sizes) and never under floor px. The
  // coarser layers step back to waypoints: the topics that hold the most
  // points in view, nearest layer first, at most budget.waypoints, drawn
  // first at waypointAlpha, and held inside the view at its edge when their
  // anchor has left it, so the reader always has a name for where they are.
  // The focus layer names at most budget[role] topics, those with the most
  // points in view; comment labels at most budget.comments. steps: false
  // places names and comments as the first zoom did (every layer, comments
  // whenever the points in view allow, no budget).
  var PRESET_ZOOM = {
    min: 0.8,
    max: 40,
    settleMs: 120,
    hitRadiusMin: 3,
    comments: { maxPoints: 150, minSpacing: 24, font: 10, words: 5, wordsPerDoubling: 2.5, wrap: 22, wrapPerDoubling: 6,
      only: null, maxLines: null },
    slot: null,
    steps: [1.5, 3, 6],
    floor: 11,
    focusSize: [13, 17],
    waypointAlpha: 0.62,
    budget: { district: 5, finest: 6, comments: 5, waypoints: 2 },
    // The comments at the surface: with a list of comments to bring forward
    // (comments.only, the standouts) and room on the map, they are written
    // out at the whole-map view and at every step, not only the deepest.
    // Room: the map has at least minAreaPerPoint px² per point in view (a
    // map of thousands has not, and writes none); then one comment per
    // areaPerComment px² of the map not taken by names, at most max. Each
    // is placed beside its dot, not over it: in the white space within
    // reach px of the dot, covering no other dot, name or comment, tied to
    // its dot by a leader (label.leader). A map with that room is small:
    // its steps collapse to one, straight to its comments, and its zoom
    // ends at sqrt(points / minInView), at least x2 (zoomLimit), where on
    // average fewer than minInView points would be left in view.
    surface: { minAreaPerPoint: 6000, areaPerComment: 120000, max: 10, reach: 180, gap: 8, minInView: 8 },
    // when names are placed again, a name kept slides to its new place and a
    // name that comes or goes fades, over this many ms (0: at once)
    fadeMs: 240
  };

  // The zoom settings: given keys over PRESET_ZOOM, and given comment and
  // budget keys over its own. comments: false turns comment labels off.
  function resolveZoom(given) {
    given = given && typeof given === "object" ? given : {};
    var out = Object.assign({}, PRESET_ZOOM, given);
    out.comments = given.comments === false ? null : Object.assign({}, PRESET_ZOOM.comments, given.comments || {});
    out.slot = given.slot ? { w: Number(given.slot.w) || 0, h: Number(given.slot.h) || 0, gap: given.slot.gap == null ? 4 : Number(given.slot.gap) } : null;
    out.steps = given.steps === false ? null : (Array.isArray(given.steps) && given.steps.length ? given.steps.map(Number) : PRESET_ZOOM.steps.slice());
    out.budget = Object.assign({}, PRESET_ZOOM.budget, given.budget || {});
    out.surface = given.surface === false ? null : Object.assign({}, PRESET_ZOOM.surface, given.surface || {});
    out.focusSize = (given.focusSize || PRESET_ZOOM.focusSize).slice();
    return out;
  }

  // Where a view stands in the steps (PRESET_ZOOM): null at the fit, zoomed
  // out, or with steps off; else the zoom, the stage (0 below the first
  // step, i past steps[i - 1]), the layers from coarse to fine, and how many
  // points in view each topic holds at its own layer (by topic index).
  function zoomStage(model, view, fit, W, H) {
    var cfg = model.settings, Z = cfg.zoom;
    if (!Z || !Z.steps || !Z.steps.length) return null;
    var by = view.s / fit.s;
    if (!(by > 1 + 1e-9)) return null;
    var coarse = cfg.layers.slice().sort(function (a, b) { return b - a; }), k = coarse.length;
    var step = function (i) { var n = Z.steps.length; return i < n ? Z.steps[i] : Z.steps[n - 1] * Math.pow(2, i - n + 1); };
    var stage = 0;
    // a small map (room for its comments at the whole-map view) has one step, to its comments
    if (isSmall(model, W, H)) stage = by >= Z.steps[0] ? k : 0;
    else for (var i = 0; i < k; i++) if (by >= step(i)) stage = i + 1;
    var X = model.points.x, Y = model.points.y, P = model.points.topic, inView = new Float64Array(model.topics.length);
    for (i = 0; i < model.points.n; i++) {
      var x = X[i] * view.s + view.tx, y = -Y[i] * view.s + view.ty;
      if (x < 0 || y < 0 || x > W || y > H) continue;
      for (var c = 0; c < k; c++) { var row = P[coarse[c]]; var v = row ? row[i] : -1; if (v >= 0) inView[v]++; }
    }
    return { zoom: by, stage: stage, k: k, coarse: coarse, inView: inView };
  }

  // The surface settings when they apply: steps on, a list of comments to
  // bring forward (comments.only) and at least one of them with text.
  function surfaceOn(model) {
    var Z = model.settings.zoom;
    return Z && Z.surface && Z.steps && Z.comments && Array.isArray(Z.comments.only) && model.commentOrder.length ? Z.surface : null;
  }
  // Whether the whole map has room for comments at its surface (W by H px).
  function isSmall(model, W, H) {
    var s = surfaceOn(model);
    return !!s && W * H / Math.max(1, model.points.n) >= s.minAreaPerPoint;
  }
  // The deepest zoom offered, as a multiple of the fit: the preset's max;
  // on a small map, where on average minInView points are left in view
  // (at least one double-click, x2): a step further would show nothing new.
  function zoomLimit(model, width, height) {
    var Z = model.settings.zoom, size = canvasSize(width, height);
    if (!Z) return PRESET_ZOOM.max;
    if (!isSmall(model, size.W, size.H)) return Z.max;
    return Math.min(Z.max, Math.max(2, Math.sqrt(model.points.n / Z.surface.minInView)));
  }
  // How many comments the surface writes out in this view: none unless the
  // view has minAreaPerPoint px² per point in it; else one per
  // areaPerComment px² not taken by the names placed, at most max.
  function surfaceBudget(model, view, W, H, placed, s) {
    var X = model.points.x, Y = model.points.y, n = 0;
    for (var i = 0; i < model.points.n; i++) {
      var x = X[i] * view.s + view.tx, y = -Y[i] * view.s + view.ty;
      if (x >= 0 && y >= 0 && x <= W && y <= H) n++;
    }
    if (!n || W * H / n < s.minAreaPerPoint) return { n: 0, inView: n };
    var free = W * H;
    placed.forEach(function (p) { free -= (p.box[2] - p.box[0]) * (p.box[3] - p.box[1]); });
    return { n: Math.max(0, Math.min(s.max, Math.floor(free / s.areaPerComment))), inView: n };
  }

  // The names to place zoomed in, in order: { ti, pin, alpha, font, role }.
  function zoomedNames(model, zl, focusLevel, wayLayers, W, H, fontOf) {
    var cfg = model.settings, Z = cfg.zoom, T = model.topics, inView = zl.inView;
    var roles = rolesOf(cfg.layers), budgetOf = {};
    Object.keys(Z.budget).forEach(function (r) { if (r in roles) budgetOf[roles[r]] = Z.budget[r]; });
    var countMax = {};
    T.forEach(function (t) { countMax[t.level] = Math.max(countMax[t.level] || 1, t.count); });
    var sized = function (ti) {
      var base = fontOf ? fontOf(ti) : model.baseFont[ti]; if (base == null) base = 0;
      if (zl.stage === 0) return base;
      var fs = Z.focusSize, g = Math.sqrt(T[ti].count / countMax[T[ti].level]);
      return Math.max(base, Z.floor, fs[0] + (fs[1] - fs[0]) * g);
    };
    var byCount = function (L) {
      var out = [];
      model.order.forEach(function (ti) { if (T[ti].level === L && inView[ti] > 0) out.push(ti); });
      return out.sort(function (a, b) { return inView[b] - inView[a]; });
    };
    var seq = [], taken = {};
    // waypoints: nearest layer first, then round again, up to the budget
    var lists = wayLayers.map(byCount), nWay = zl.stage === 0 ? 1 : Z.budget.waypoints;
    for (var round = 0; seq.length < nWay && lists.some(function (l) { return l.length > round; }); round++) {
      for (var j = 0; j < lists.length && seq.length < nWay; j++) {
        var ti = lists[j][round];
        if (ti == null) continue;
        taken[ti] = true;
        seq.push({ ti: ti, pin: true, alpha: zl.stage === 0 ? 1 : Z.waypointAlpha, font: sized(ti), role: "waypoint" });
      }
    }
    if (zl.stage === 0) {
      model.order.forEach(function (t) { if (!taken[t]) seq.push({ ti: t, font: sized(t), role: "overview" }); });
    } else if (focusLevel != null) {
      var n = budgetOf[focusLevel] == null ? 6 : budgetOf[focusLevel];
      // the finer topics of where you are (the nearest waypoint) come first
      var home = seq.length ? seq[0].ti : -1, homeL = home >= 0 ? T[home].level : null;
      var mine = function (t) { return home >= 0 && model.ancestorAt(t, homeL) === home ? 0 : 1; };
      var cand = byCount(focusLevel).map(function (t, i) { return [mine(t), i, t]; });
      cand.sort(function (a, b) { return a[0] - b[0] || a[1] - b[1]; });
      cand.map(function (c) { return c[2]; }).forEach(function (t) { if (!taken[t]) seq.push({ ti: t, font: sized(t), role: "focus", budget: n }); });
    }
    return seq;
  }

  // The roles a layer can be named by, read from the levels a document has:
  // the zone is the coarsest level, the district the one below it, the finest
  // level 0. For documents of fewer than three levels the roles fall on the
  // same level; which reading those documents should get is not settled.
  function rolesOf(levels) {
    var top = Math.max.apply(null, levels), low = Math.min.apply(null, levels);
    return { zone: top, district: Math.max(low, top - 1), finest: low };
  }
  function levelOf(v, roles) {
    if (v == null || typeof v === "number") return v;
    if (/^\d+$/.test(String(v))) return Number(v);
    if (!(v in roles)) throw new Error("unknown layer role " + JSON.stringify(v));
    return roles[v];
  }
  function resolveSettings(settings, levels) {
    var cfg = Object.assign({}, DEFAULTS, settings || {});
    var roles = rolesOf(levels);
    var list = function (a) {
      var out = [];
      (a || []).forEach(function (v) { var L = levelOf(v, roles); if (out.indexOf(L) < 0) out.push(L); });
      return out;
    };
    // When roles fall on one level (a document of one level is all zone,
    // district and finest at once), the zone's value keeps its level: the
    // coarsest topics a map has are named as zones, as guideposts.
    var byLayer = function (o) {
      var out = {}, zoneSet = {};
      Object.keys(o || {}).forEach(function (k) {
        var L = levelOf(k, roles);
        if (zoneSet[L] && k !== "zone") return;
        out[L] = o[k];
        if (k === "zone") zoneSet[L] = true;
      });
      return out;
    };
    cfg.layers = list(cfg.layers);
    if (cfg.monoLayers) cfg.monoLayers = list(cfg.monoLayers);
    cfg.sizes = byLayer(cfg.sizes);
    cfg.caps = byLayer(cfg.caps);
    cfg.wrap = byLayer(cfg.wrap);
    cfg.zoneLayer = levelOf(cfg.zoneLayer, roles);
    cfg.subOutline = levelOf(cfg.subOutline, roles);
    return cfg;
  }

  /* ------------------------------------------------------------------- names */

  // The naming stage stores a name as "<level>_<cluster>: name"; the prefix
  // is removed before the name is measured.
  function stripNamePrefix(name) {
    return String(name == null ? "" : name).replace(/^\d+_\d+:\s*/, "");
  }

  // Greedy wrap by character count, spaces included: a word starts a new line
  // when the line, a space and the word would be longer than n.
  function wrapText(s, n) {
    var words = s.split(/\s+/); var out = []; var line = "";
    for (var i = 0; i < words.length; i++) {
      var w = words[i];
      if (line && (line + " " + w).length > n) { out.push(line); line = w; } else line = line ? line + " " + w : w;
    }
    if (line) out.push(line);
    return out;
  }

  function weightFor(f) { return Math.round(Math.max(300, Math.min(760, 300 + (f - 7) * 17))); }

  /* ----------------------------------------------------------------- colours */

  // The OKLCH hues whose pale tint reads warm off-white on a light ground,
  // and the cool neutral drawn for them zoomed in (palette zoneTintZoomed).
  var WARM_TINT = [15, 130];
  var NEUTRAL_TINT = "oklch(0.80 0.02 250)";

  // The grey ground: whenever comments and their votes are drawn on the map,
  // the topics step back to grey so that the votes are the only colour. Each
  // of the topics' colours keeps its hue number but loses its chroma and
  // moves to the lightness here (OKLCH L, chroma 0: neutral greys); the
  // written-out comments' ink moves to near-black. A name's grey is lighter
  // the larger it is (name at 14 px and under, nameLarge at 28 px and over),
  // so that a large name stays a guidepost and does not pull the eye from the
  // comments.
  var GREY_GROUND = {
    light: { tint: 0.9, outline: 0.76, district: 0.82, name: 0.64, nameLarge: 0.76, dot: 0.78, commentInk: "#1f2329" },
    dark: { tint: 0.34, outline: 0.5, district: 0.44, name: 0.7, nameLarge: 0.56, dot: 0.52, commentInk: "#e6e8eb" }
  };

  function round4(v) { return Math.round(v * 10000) / 10000; }

  // An oklch() colour moved by share g (0 to 1) toward the neutral grey of
  // lightness L: its chroma falls to 0 and its lightness goes to L. Any other
  // colour (the greys written in hex) is returned as it is.
  function towardGrey(colour, g, L) {
    if (!(g > 0) || typeof colour !== "string") return colour;
    var m = /^oklch\(\s*([\d.]+)\s+([\d.]+)\s+(-?[\d.]+)\s*\)$/.exec(colour);
    if (!m) return colour;
    var u = Math.min(1, g), l = +m[1];
    return "oklch(" + round4(l + (L - l) * u) + " " + round4(+m[2] * (1 - u)) + " " + m[3] + ")";
  }

  function mixHex(a, b, u) {
    var pa = [1, 3, 5].map(function (k) { return parseInt(a.slice(k, k + 2), 16); });
    var pb = [1, 3, 5].map(function (k) { return parseInt(b.slice(k, k + 2), 16); });
    return "#" + pa.map(function (v, k) { var c = Math.round(v + (pb[k] - v) * u); return (c < 16 ? "0" : "") + c.toString(16); }).join("");
  }

  // The palette; with grey (0 to 1) above 0, the palette of the grey ground
  // at that share: every topic colour toward its grey (towardGrey), the
  // comments' ink toward near-black; the ground, the halo and the greys
  // unchanged. With no grey it is the palette exactly as before.
  function palette(scheme, grey) {
    var base = paletteColour(scheme);
    if (!(grey > 0)) return base;
    var g = Math.min(1, grey), G = GREY_GROUND[scheme === "dark" ? "dark" : "light"], p = Object.assign({}, base);
    p.greyShare = g;
    p.labelInk = function (h) { return towardGrey(base.labelInk(h), g, G.name); };
    p.nameInk = function (ink, size) {
      var u = size > 14 ? Math.min(1, (size - 14) / 14) : 0;
      return towardGrey(ink, g, G.name + (G.nameLarge - G.name) * u);
    };
    p.dotInk = function (h) { return towardGrey(base.dotInk(h), g, G.dot); };
    p.zoneTint = function (h) { return towardGrey(base.zoneTint(h), g, G.tint); };
    p.zoneTintZoomed = function (h) { return towardGrey(base.zoneTintZoomed(h), g, G.tint); };
    p.zoneOutline = function (h) { return towardGrey(base.zoneOutline(h), g, G.outline); };
    p.districtStroke = function (h) { return towardGrey(base.districtStroke(h), g, G.district); };
    p.commentInk = mixHex(base.commentInk, G.commentInk, g);
    return p;
  }

  function paletteColour(scheme) {
    var dark = scheme === "dark";
    var INK = dark ? "#d6d9de" : "#2b3038";
    var GREY = dark ? "#5a5e66" : "#b4b9c1";
    return {
      nameInk: function (ink) { return ink; },
      ground: dark ? "#111214" : "#ffffff",
      ink: INK,
      grey: GREY,
      labelInk: function (h) { return h == null ? INK : (dark ? "oklch(0.84 0.11 " + h + ")" : "oklch(0.40 0.14 " + h + ")"); },
      dotInk: function (h) { return h == null ? GREY : (dark ? "oklch(0.62 0.12 " + h + ")" : "oklch(0.70 0.13 " + h + ")"); },
      dotAlpha: function (col) { return col === GREY ? (dark ? 0.9 : 0.85) : 0.8; },
      // The zone tint is resolved to sRGB by whoever draws it (the renderer
      // filled a 1 by 1 canvas with this colour and read the pixel back).
      zoneTint: function (h) { return dark ? "oklch(0.55 0.11 " + h + ")" : "oklch(0.80 0.10 " + h + ")"; },
      // Zoomed in, a zone's tint can fill the view. A pale tint of a hue from
      // red-orange to yellow-green over white reads as cream, ivory or
      // beige, so on the light ground those zones are tinted a cool neutral
      // instead (their outline and names keep the hue); every other hue, and
      // the dark ground, keep the tint.
      zoneTintZoomed: function (h) {
        if (dark || h == null) return dark ? "oklch(0.55 0.11 " + (h == null ? 220 : h) + ")" : "oklch(0.80 0.10 220)";
        var hh = ((h % 360) + 360) % 360;
        return hh >= WARM_TINT[0] && hh <= WARM_TINT[1] ? NEUTRAL_TINT : "oklch(0.80 0.10 " + h + ")";
      },
      zoneOutline: function (h) { return dark ? "oklch(0.70 0.12 " + h + ")" : "oklch(0.55 0.13 " + h + ")"; },
      zoneOutlineWidth: 1.4,
      districtStroke: function (h) { return h == null ? GREY : (dark ? "oklch(0.6 0.08 " + h + ")" : "oklch(0.62 0.09 " + h + ")"); },
      districtWidth: 0.8,
      districtDash: [2, 2],
      halo: dark ? "rgba(17,18,20,0.85)" : "rgba(255,255,255,0.85)",
      commentInk: dark ? "#aeb3ba" : "#4a505a",
      commentAlpha: 0.92,
      haloWidth: function (f) { return Math.max(2, f * 0.22); }
    };
  }

  /* ------------------------------------------------------------------ spread */

  // The spread of a topic: the 75th-percentile distance of its points from
  // its anchor, in data units, rounded to 3 decimals.
  function topicSpread(doc) {
    var X = doc.points.x, Y = doc.points.y, levels = doc.points.topic;
    return doc.topics.map(function (t, gi) {
      var lv = levels[t.level] || [];
      var d = [];
      for (var i = 0; i < lv.length; i++) if (lv[i] === gi) d.push(Math.hypot(X[i] - t.x, Y[i] - t.y));
      if (!d.length) return 0;
      d.sort(function (a, b) { return a - b; });
      var distance = d[Math.floor(0.75 * (d.length - 1))];
      var rounded = distance.toFixed(3);
      // The data builder rounds half ties to even; toFixed rounds them up.
      // A binary float can be an exact half-thousandth only when it is an
      // odd multiple of 1/16 (the factor 125 in 2000 must cancel). Check
      // that exact power-of-two scaling, not distance * 1000, which can
      // itself round a neighbouring value onto a tie.
      if (distance * 16 % 2 === 1 && Number(rounded.slice(-1)) % 2 === 1) {
        rounded = rounded.slice(0, -1) + (Number(rounded.slice(-1)) - 1);
      }
      return Number(rounded);
    });
  }

  /* -------------------------------------------- everything that has no size */

  // prepare(doc, settings, { spread }) : what does not depend on the size of
  // the map: the settings by layer number, the centre and extent of the
  // points, every topic's zone and hue, the base size of every name and the
  // order names are placed in. spread, if given, maps topic id to spread.
  function prepare(doc, settings, opts) {
    opts = opts || {};
    var cfg = resolveSettings(settings, doc.levels.map(function (l) { return l.level; }));
    var P = doc.points, X = P.x, Y = P.y, N = X.length;
    var computed = opts.spread ? null : topicSpread(doc);
    var T = doc.topics.map(function (t, i) {
      return { id: t.id, level: t.level, parent: t.parent, count: t.count, x: t.x, y: t.y,
        r: opts.spread ? opts.spread[t.id] : computed[i], name: stripNamePrefix(t.name) };
    });
    var byId = {};
    T.forEach(function (t, i) { byId[t.id] = i; });

    var cx = 0, cy = 0;
    for (var i = 0; i < N; i++) { cx += X[i]; cy += Y[i]; }
    cx /= N; cy /= N;
    var minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    for (i = 0; i < N; i++) {
      minX = Math.min(minX, X[i]); maxX = Math.max(maxX, X[i]);
      minY = Math.min(minY, Y[i]); maxY = Math.max(maxY, Y[i]);
    }

    var ancestorAt = function (ti, L) {
      var t = T[ti];
      while (t && t.level < L && t.parent) t = T[byId[t.parent]];
      return t && t.level === L ? byId[t.id] : -1;
    };
    var angleOf = function (x, y) { return (Math.atan2(y - cy, x - cx) * 180 / Math.PI + 360) % 360; };
    var zoneIdx = T.map(function (t, i) { return t.level === cfg.zoneLayer ? i : -1; }).filter(function (i) { return i >= 0; });
    var zoneOrder = zoneIdx.slice().sort(function (a, b) { return angleOf(T[a].x, T[a].y) - angleOf(T[b].x, T[b].y); });
    var zoneHue = {};
    zoneOrder.forEach(function (zi, k) { zoneHue[zi] = (25 + k * 360 / zoneOrder.length) % 360; });
    var zoneBy = [];
    var zoneOf = T.map(function (t, i) {
      var z = ancestorAt(i, cfg.zoneLayer);
      zoneBy[i] = z >= 0 ? "ancestor" : null;
      if (z >= 0 || cfg.colour !== "zoneNearest" || t.level > cfg.zoneLayer) return z;
      var best = -1, bd = Infinity;
      for (var j = 0; j < zoneIdx.length; j++) {
        var zi = zoneIdx[j]; var d = Math.hypot(T[zi].x - t.x, T[zi].y - t.y);
        if (d < bd) { bd = d; best = zi; }
      }
      if (best >= 0) zoneBy[i] = "nearest";
      return best;
    });
    var hueOf = T.map(function (t, i) {
      if (cfg.colour === "angle") return (angleOf(t.x, t.y) + 25) % 360;
      if (cfg.colour === "mono") return null;
      var z = zoneOf[i];
      if (z < 0) return null;
      if (z === i) return zoneHue[z];
      // a child keeps its zone's hue, turned a little by where it sits inside the zone
      var da = ((angleOf(t.x, t.y) - angleOf(T[z].x, T[z].y) + 540) % 360) - 180;
      return (zoneHue[z] + da * 0.12 + 360) % 360;
    });

    // per point: the finest topic it belongs to, and its zone (for tinted dots)
    var pointTopic = new Int32Array(N).fill(-1);
    var pointZone = new Int32Array(N).fill(-1);
    for (i = 0; i < N; i++) {
      for (var L = 0; L < P.topic.length; L++) { var v = P.topic[L][i]; if (v >= 0) { pointTopic[i] = v; break; } }
      var zl = P.topic[cfg.zoneLayer]; pointZone[i] = zl ? zl[i] : -1;
    }

    var countMaxByLayer = {}, countMax = 1;
    T.forEach(function (t) {
      countMaxByLayer[t.level] = Math.max(countMaxByLayer[t.level] || 1, t.count); countMax = Math.max(countMax, t.count);
    });
    var baseFont = T.map(function (t) {
      if (cfg.size === "count") { var f = Math.sqrt(t.count / countMax); return cfg.countRange[0] + (cfg.countRange[1] - cfg.countRange[0]) * f; }
      var r = cfg.sizes[t.level];
      if (!r) return null;
      if (cfg.size === "layer") return r[1];
      var g = Math.sqrt(t.count / countMaxByLayer[t.level]);
      return r[0] + (r[1] - r[0]) * g;
    });

    // priority: coarse layers first, then by count (a stable sort keeps
    // topic order among equals)
    var order = [];
    for (i = 0; i < T.length; i++) if (cfg.layers.indexOf(T[i].level) >= 0) order.push(i);
    var pri = function (ti) { return cfg.size === "count" ? T[ti].count : (T[ti].level * 1e5 + T[ti].count); };
    order.sort(function (a, b) { return pri(b) - pri(a); });

    // the points a comment label may be given to, in the order they are
    // placed: those with an id and some text, the most voted first when the
    // document gives a number of votes for every point, else in its order
    var commentOrder = [];
    var text = Array.isArray(P.text) ? P.text : [], ids = Array.isArray(P.id) ? P.id : [];
    for (i = 0; i < N; i++) if (ids[i] != null && typeof text[i] === "string" && text[i].trim()) commentOrder.push(i);
    var votes = Array.isArray(P.votes) && P.votes.length === N && P.votes.every(function (v) { return typeof v === "number" && isFinite(v); }) ? P.votes : null;
    if (votes) commentOrder.sort(function (a, b) { return votes[b] - votes[a] || a - b; });
    // zoom.comments.only: a list of point ids, first placed first; only those
    // points are given a label (an empty list gives none)
    var onlyIds = cfg.zoom && cfg.zoom.comments && Array.isArray(cfg.zoom.comments.only) ? cfg.zoom.comments.only : null;
    // zoom.comments.kinds (beside only): each listed comment's kind, so the
    // surface can balance its budget between the kinds
    var commentKind = {};
    if (onlyIds) {
      var withText = {}, byId = {};
      commentOrder.forEach(function (pi) { withText[pi] = true; });
      for (i = 0; i < N; i++) if (ids[i] != null && !(String(ids[i]) in byId)) byId[String(ids[i])] = i;
      var seen = {}, kinds = Array.isArray(cfg.zoom.comments.kinds) ? cfg.zoom.comments.kinds : null;
      commentOrder = [];
      onlyIds.forEach(function (id, k) {
        var pi = byId[String(id)];
        if (pi !== undefined && withText[pi] && !seen[pi]) {
          seen[pi] = true; commentOrder.push(pi);
          if (kinds && kinds[k] != null) commentKind[pi] = String(kinds[k]);
        }
      });
    }

    var districtIdx = cfg.subOutline == null ? [] :
      T.reduce(function (a, t, i) { if (t.level === cfg.subOutline) a.push(i); return a; }, []);

    return {
      settings: cfg, topics: T, points: { x: X, y: Y, topic: P.topic, n: N, id: ids, text: text, votes: votes },
      commentOrder: commentOrder, commentKind: commentKind,
      centre: { cx: cx, cy: cy }, extent: { minX: minX, maxX: maxX, minY: minY, maxY: maxY },
      zoneIdx: zoneIdx, zoneOrder: zoneOrder, zoneHue: zoneHue, zoneOf: zoneOf, zoneBy: zoneBy, hueOf: hueOf,
      districtIdx: districtIdx, pointTopic: pointTopic, pointZone: pointZone,
      baseFont: baseFont, order: order, ancestorAt: ancestorAt, angleOf: angleOf
    };
  }

  /* ------------------------------------------------------------ size and fit */

  function canvasSize(width, height) {
    return { W: Math.max(200, Math.floor(width)), H: Math.max(200, Math.floor(height)) };
  }
  function fitView(extent, W, H, pad) {
    // A run may contain just one position, or several identical positions.
    // Keep the ordinary fit arithmetic unchanged; centre the degenerate
    // case at a finite scale instead of sending Infinity/NaN to the canvas.
    if (!Number.isFinite(extent.minX) || !Number.isFinite(extent.maxX) ||
        !Number.isFinite(extent.minY) || !Number.isFinite(extent.maxY)) {
      return { s: 1, tx: W / 2, ty: H / 2 };
    }
    if (extent.minX === extent.maxX && extent.minY === extent.maxY) {
      return { s: 1, tx: W / 2 - extent.minX, ty: H / 2 + extent.minY };
    }
    var p = pad * Math.min(W, H);
    var s = Math.min((W - 2 * p) / (extent.maxX - extent.minX), (H - 2 * p) / (extent.maxY - extent.minY));
    return { s: s, tx: W / 2 - s * (extent.minX + extent.maxX) / 2, ty: H / 2 + s * (extent.minY + extent.maxY) / 2 };
  }

  // How far, in px, the zones' shapes (each zone's points' density, blurred,
  // above its threshold) reach past the extent of the points at a fit of W
  // by H whose pad leaves room for any reach. A zone of lone points reaches
  // about two and a half blur widths past them.
  function zoneReach(model, W, H, margin) {
    var cfg = model.settings, ex = model.extent, m = Math.min(W, H);
    var sc = gridScale({ W: W, H: H, view: { s: 1 }, fit: { s: 1 } });
    var trial = fitView(ex, W, H, cfg.pad + (3 * sc.sigma + 2 * sc.cell + margin) / m);
    var frame = { W: W, H: H, view: trial, fit: trial };
    var px0 = ex.minX * trial.s + trial.tx, px1 = ex.maxX * trial.s + trial.tx;
    var py0 = -ex.maxY * trial.s + trial.ty, py1 = -ex.minY * trial.s + trial.ty;
    var topic = model.points.topic, zl = cfg.zoneLayer, reach = 0;
    model.zoneIdx.forEach(function (zi) {
      var G = densityGrid(model, frame, function (i) { return topic[zl][i] === zi; }, sc.cell, sc.sigma);
      if (G.mx <= 0) return;
      var thr = G.mx * 0.05, c = G.cell;
      for (var gy = 0; gy < G.gh; gy++) for (var gx = 0; gx < G.gw; gx++) {
        if (!(G.g[gy * G.gw + gx] > thr)) continue;
        reach = Math.max(reach, px0 - gx * c, (gx + 1) * c - px1, py0 - gy * c, (gy + 1) * c - py1);
      }
    });
    return reach;
  }

  // The first view of the dense drawing at W by H: fitView, with the pad
  // widened on a map with room (at least zoom.surface.minAreaPerPoint px² of
  // frame per point, 6000 by default: a small conversation, whose zones are
  // lone points with wide shapes) so that every zone's shape lies inside the
  // frame with `fitMargin` px to spare (8 by default). A crowded map keeps
  // the pad as it is. Worked out once per size.
  var fitCache = typeof WeakMap === "function" ? new WeakMap() : null;
  function fitFor(model, W, H) {
    var cfg = model.settings, base = cfg.pad, ex = model.extent;
    var key = W + "x" + H, memo = fitCache && fitCache.get(model);
    if (memo && memo[key]) return Object.assign({}, memo[key]);
    var fit = fitView(ex, W, H, base);
    var degenerate = !Number.isFinite(ex.minX) || !Number.isFinite(ex.maxX) || !Number.isFinite(ex.minY) || !Number.isFinite(ex.maxY) ||
      (ex.minX === ex.maxX && ex.minY === ex.maxY);
    var Z = cfg.zoom, perPoint = Z && Z.surface && Z.surface.minAreaPerPoint ? Z.surface.minAreaPerPoint : 6000;
    var roomy = W * H / Math.max(1, model.points.n) >= perPoint;
    if (roomy && !degenerate && cfg.zones !== "none" && model.zoneIdx && model.zoneIdx.length) {
      var m = Math.min(W, H), margin = cfg.fitMargin != null ? cfg.fitMargin : 8;
      var reach = zoneReach(model, W, H, margin);
      if (reach + margin > base * m) fit = fitView(ex, W, H, (reach + margin) / m);
    }
    if (fitCache) { if (!memo) fitCache.set(model, memo = {}); memo[key] = Object.assign({}, fit); }
    return fit;
  }

  /* --------------------------------------------------------------- placement */

  // layout(model, { width, height, measure, view, prev }) : the names placed
  // at one size of the map. Greedy, in priority order: the name's box (its
  // text and 1.5 px) is tried at the anchor, then on rings of 16 directions
  // out to its reach; if no position is free the size is multiplied by 0.88
  // and every step is tried again; below the minimum size the name is
  // dropped. With prev (the frame of the placement before), each label is
  // tried first where prev put it on the map: the same view and prev give the
  // same placement, and placing a view again with its own placement as prev
  // returns that placement.
  function layout(model, opts) {
    var cfg = model.settings, T = model.topics, pal = palette(cfg.scheme);
    var size = canvasSize(opts.width, opts.height), W = size.W, H = size.H;
    var fit = fitFor(model, W, H);
    var view = opts.view ? Object.assign({}, opts.view) : Object.assign({}, fit);
    var measure = opts.measure;
    var famOf = function (L) { return (cfg.monoLayers || []).indexOf(L) >= 0 ? cfg.fontMono : cfg.fontSans; };
    var sx = function (x) { return x * view.s + view.tx; };
    var sy = function (y) { return -y * view.s + view.ty; };

    var placed = [], dropped = []; var grid = new Map(); var CELL = 48;
    var key = function (x, y) { return x + "," + y; };
    var hits = function (b) {
      for (var gx = Math.floor(b[0] / CELL); gx <= Math.floor(b[2] / CELL); gx++)
        for (var gy = Math.floor(b[1] / CELL); gy <= Math.floor(b[3] / CELL); gy++) {
          var arr = grid.get(key(gx, gy)); if (!arr) continue;
          for (var q = 0; q < arr.length; q++) { var o = arr[q]; if (b[0] < o[2] && b[2] > o[0] && b[1] < o[3] && b[3] > o[1]) return true; }
        }
      return false;
    };
    var add = function (b) {
      for (var gx = Math.floor(b[0] / CELL); gx <= Math.floor(b[2] / CELL); gx++)
        for (var gy = Math.floor(b[1] / CELL); gy <= Math.floor(b[3] / CELL); gy++) {
          var k = key(gx, gy); if (!grid.has(k)) grid.set(k, []); grid.get(k).push(b);
        }
    };
    var stats = { byLayer: {}, dropped: {}, shrunk: 0, shift: [], skippedOffMap: 0 };
    // zoomed in, the stage decides what is named (zoomStage, zoomedNames)
    var Z = cfg.zoom, zl = zoomStage(model, view, fit, W, H);
    var commentLevel = { on: false, inView: 0, spacing: null }, commentsOn = false, focusLevel = null, wayLayers = [];
    if (zl) {
      if (Z.comments && zl.stage === zl.k && model.commentOrder.length) {
        commentLevel = commentsInView(model, view, W, H, Z.comments);
        commentsOn = commentLevel.on;
      }
      if (zl.stage === 0) wayLayers = [zl.coarse[0]];
      else {
        var fi = commentsOn ? zl.k : Math.min(zl.stage, zl.k - 1);
        focusLevel = fi < zl.k ? zl.coarse[fi] : null;
        wayLayers = zl.coarse.slice(0, fi).reverse();
      }
      stats.stage = zl.stage; stats.focus = commentsOn ? "comments" : focusLevel;
    }
    // names follow the room (cfg.room): the same growth at every zoom, so a
    // name keeps its size in px; with no room every name is its size at rest
    var room = cfg.room, grow = 1;
    if (room && model.order.length) {
      var perName = W * H / model.order.length;
      if (perName > room.area) grow = Math.min(room.grow, Math.sqrt(perName / room.area));
    }
    var fontOf = function (ti) {
      var b = model.baseFont[ti];
      if (b == null || grow === 1) return b;
      var byExtent = isFinite(T[ti].r) ? room.spread * T[ti].r * fit.s : Infinity;
      return Math.max(b, Math.min(b * grow, room.maxPx, byExtent));
    };
    var seq = zl ? zoomedNames(model, zl, focusLevel, wayLayers, W, H, fontOf) : model.order.map(function (ti) { return { ti: ti }; });
    stats.grow = grow;
    // The previous placement (opts.prev, a frame this function returned): a
    // name or comment label it placed is tried first where it was on the map,
    // then at its previous offset from its anchor, and only then on the
    // rings; and the others try first to keep out of the places it held.
    var prev = opts.prev && opts.prev.view ? opts.prev : null, prevAt = {}, reserved = [];
    if (prev) {
      var pv = prev.view, same = pv.s === view.s && pv.tx === view.tx && pv.ty === view.ty;
      var toNow = function (x, y) { return same ? [x, y] : [(x - pv.tx) / pv.s * view.s + view.tx, -((pv.ty - y) / pv.s) * view.s + view.ty]; };
      var remember = function (k, p, f) {
        var cx = (p.box[0] + p.box[2]) / 2, cy = (p.box[1] + p.box[3]) / 2, at = toNow(cx, cy);
        var hw = (p.box[2] - p.box[0]) / 2, hh = (p.box[3] - p.box[1]) / 2;
        prevAt[k] = { x: at[0], y: at[1], dx: cx - p.x0, dy: cy - p.y0, f: f };
        reserved.push({ k: k, b: [at[0] - hw, at[1] - hh, at[0] + hw, at[1] + hh] });
      };
      prev.placed.forEach(function (p) { remember("t" + p.ti, p, p.f); });
      (prev.comments || []).forEach(function (p) { remember("c" + p.point, p, p.f); });
    }
    var hitsReserved = function (b, k) {
      for (var q = 0; q < reserved.length; q++) {
        var o = reserved[q].b;
        if (reserved[q].k !== k && b[0] < o[2] && b[2] > o[0] && b[1] < o[3] && b[3] > o[1]) return true;
      }
      return false;
    };
    var release = function (k) { reserved = reserved.filter(function (r) { return r.k !== k; }); };
    // the offsets a label tries: where it was, its previous offset, then the
    // rings; and, with a previous placement, a first pass keeping out of the
    // places other labels held
    var candidates = function (k, f, ax, ay, reach, rings) {
      var pa = prevAt[k], out = [];
      if (pa && Math.abs(pa.f - f) < 0.01) {
        var ex = pa.x - ax, ey = pa.y - ay;
        if (Math.hypot(ex, ey) <= reach + 1e-9) out.push([ex, ey, true]);
        if (Math.hypot(pa.dx, pa.dy) <= reach + 1e-9) out.push([pa.dx, pa.dy, true]);
      }
      return out.concat(rings);
    };
    var passes = prev ? [true, false] : [false];
    var focusPlaced = 0;
    for (var c = 0; c < seq.length; c++) {
      var e = seq[c], ti = e.ti;
      if (e.role === "focus" && focusPlaced >= e.budget) break;
      var t = T[ti], L = t.level, text = t.name, alpha = e.alpha == null ? 1 : e.alpha;
      var x0 = sx(t.x), y0 = sy(t.y), rScreen = t.r * view.s;
      if (!e.pin && (x0 < -50 || y0 < -50 || x0 > W + 50 || y0 > H + 50)) {
        stats.skippedOffMap++;
        dropped.push({ ti: ti, reason: "anchor more than 50 px outside the map", x0: x0, y0: y0, ink: pal.labelInk(model.hueOf[ti]) });
        continue;
      }
      var font = e.font != null ? e.font : fontOf(ti);
      if (cfg.dynamic && cfg.fadeCoarse && L > 0) {
        var fill = rScreen / (0.42 * Math.min(W, H)); alpha = Math.max(0, Math.min(1, 1.5 - fill));
        if (alpha < 0.12) continue;
      }
      var caps = cfg.caps[L] || 0; if (caps) text = text.toUpperCase();
      var hue = model.hueOf[ti], wrapN = cfg.wrap[L] || 13;
      // zoomed in a name is placed at its size or not at all
      var minF = zl ? font : cfg.minFont;
      var done = false, f = font, tried = [];
      while (!done && f >= minF - 0.01) {
        var weight = weightFor(f); tried.push({ f: f, weight: weight });
        var fam = famOf(L), spacing = caps ? (caps * f).toFixed(2) + "px" : "0px";
        var fontSpec = { weight: weight, size: f, family: fam, letterSpacing: spacing, font: weight + " " + f + "px " + fam };
        var lines = wrapText(text, wrapN); var lh = f * (caps ? 1.08 : 1.12);
        var w = 0, lw = [];
        for (var li = 0; li < lines.length; li++) { var mw = measure(lines[li], fontSpec); lw.push(mw); w = Math.max(w, mw); }
        var h = lines.length * lh; var m = 1.5;
        // a waypoint whose anchor has left the view is held at its edge
        var held = false;
        if (e.pin) {
          var hx = Math.max(w / 2 + m + 4, Math.min(W - w / 2 - m - 4, x0)), hy = Math.max(h / 2 + m + 4, Math.min(H - h / 2 - m - 4, y0));
          held = hx !== x0 || hy !== y0; x0 = hx; y0 = hy;
        }
        var reach = cfg.maxShift * Math.max(f, Math.min(rScreen, 4 * f));
        var step = Math.max(2, f * 0.4);
        var tries = [[0, 0]];
        for (var rr = step; rr <= reach; rr += step) for (var a = 0; a < 16; a++) { var th = a * Math.PI / 8; tries.push([rr * Math.cos(th), rr * Math.sin(th) * 0.75]); }
        var nk = "t" + ti, positions = tries.length;
        if (prev) tries = candidates(nk, f, x0, y0, reach, tries);
        for (var pass = 0; pass < passes.length && !done; pass++)
        for (var j = 0; j < tries.length; j++) {
          var dx = tries[j][0], dy = tries[j][1];
          var cxl = x0 + dx, cyl = y0 + dy;
          var b = [cxl - w / 2 - m, cyl - h / 2 - m, cxl + w / 2 + m, cyl + h / 2 + m];
          if (b[0] < 2 || b[1] < 2 || b[2] > W - 2 || b[3] > H - 2) continue;
          if (hits(b)) continue;
          if (passes[pass] && !tries[j][2] && hitsReserved(b, nk)) continue;
          if (prev) release(nk);
          var blocking = alpha >= 0.5; if (blocking) add(b);
          placed.push({ ti: ti, L: L, lines: lines, f: f, baseFont: font, weight: weight, fam: fam, caps: caps,
            letterSpacing: spacing, lh: lh, lineWidths: lw, w: w, h: h, x: cxl, y: cyl, x0: x0, y0: y0, dx: dx, dy: dy,
            box: b, rScreen: rScreen, reach: reach, step: step, positions: positions, hue: hue,
            ink: pal.labelInk(hue), alpha: alpha, haloWidth: pal.haloWidth(f),
            shrunk: f < font - 0.01, shrinkSteps: tried.length - 1 });
          if (zl) { placed[placed.length - 1].role = e.role; placed[placed.length - 1].held = held; }
          if (e.role === "focus") focusPlaced++;
          done = true;
          stats.byLayer[L] = (stats.byLayer[L] || 0) + 1; stats.shift.push(Math.hypot(dx, dy) / f); if (f < font - 0.01) stats.shrunk++;
          break;
        }
        if (!done) f *= 0.88;
      }
      if (!done) {
        stats.dropped[L] = (stats.dropped[L] || 0) + 1;
        dropped.push({ ti: ti, reason: "no free position at any size down to minFont", baseFont: font, tried: tried,
          x0: x0, y0: y0, rScreen: rScreen, ink: pal.labelInk(hue) });
      }
    }
    // then, when the settings have zoom and the view is close enough, the
    // comments, by the same rule, after every name
    // (zoomed in with steps, only at the comments' stage and within budget)
    var comments = [], cap = zl ? Z.budget.comments : Infinity;
    // the surface (zoom.surface): standouts written out wherever the view has room
    var surf = surfaceOn(model), sb = surf ? surfaceBudget(model, view, W, H, placed, surf) : { n: 0 };
    if (Z && Z.comments && (zl || !Z.steps || sb.n > 0)) {
      if (!zl && !Z.steps) commentLevel = commentsInView(model, view, W, H, Z.comments);
      var deepOn = zl ? commentsOn : commentLevel.on;
      if (sb.n > 0) {
        cap = Math.max(sb.n, deepOn ? Z.budget.comments : 0);
        if (!deepOn) commentLevel = { on: true, inView: sb.inView, spacing: null };
        commentLevel.surface = true; commentLevel.budget = cap;
      }
      // the deepest step (not only the surface): where a page may write leads
      if (deepOn) commentLevel.deep = true;
      if (deepOn || sb.n > 0) {
        var C = Z.comments, lg = Math.log2(Math.max(1, view.s / fit.s)), slot = Z.slot;
        var nWords = Math.round(C.words + C.wordsPerDoubling * lg), cWrap = C.wrap + C.wrapPerDoubling * lg;
        var cf = C.font, cw = weightFor(cf), cfam = cfg.fontSans;
        var cSpec = { weight: cw, size: cf, family: cfam, letterSpacing: "0px", font: cw + " " + cf + "px " + cfam };
        var clh = cf * 1.12, cm = 1.5, creach = cfg.maxShift * cf, cstep = Math.max(2, cf * 0.4);
        var ctries = [[0, 0]];
        for (var cr = cstep; cr <= creach; cr += cstep) for (var ca = 0; ca < 16; ca++) { var cth = ca * Math.PI / 8; ctries.push([cr * Math.cos(cth), cr * Math.sin(cth) * 0.75]); }
        var PX = model.points;
        // at the surface a label sits beside its dot, in the white space: the
        // dots in view (screen px), which no label may cover
        var dotsNow = [];
        if (sb.n > 0) for (var di = 0; di < PX.n; di++) {
          var dxs = sx(PX.x[di]), dys = sy(PX.y[di]);
          if (dxs >= -4 && dys >= -4 && dxs <= W + 4 && dys <= H + 4) dotsNow.push([dxs, dys]);
        }
        var coversDot = function (b) {
          for (var q = 0; q < dotsNow.length; q++) { var d = dotsNow[q]; if (d[0] > b[0] - 3 && d[0] < b[2] + 3 && d[1] > b[1] - 3 && d[1] < b[3] + 3) return true; }
          return false;
        };
        // the offsets of a box's centre from its dot: the box's nearest edge gap px
        // and further from the dot, sideways first (a line of text reads beside a dot)
        var dirs = [];
        for (var da = 0; da < 16; da++) dirs.push(da * Math.PI / 8);
        dirs.sort(function (p, q) { return Math.abs(Math.sin(p)) - Math.abs(Math.sin(q)) || p - q; });
        var besideTries = function (bw, bh) {
          var out = [];
          for (var r = surf.gap; r <= surf.reach; r += 6) dirs.forEach(function (th) {
            var ux = Math.cos(th), uy = Math.sin(th);
            var t = Math.min(Math.abs(ux) > 1e-9 ? (bw / 2 + cm) / Math.abs(ux) : Infinity, Math.abs(uy) > 1e-9 ? (bh / 2 + cm) / Math.abs(uy) : Infinity);
            out.push([ux * (t + r), uy * (t + r)]);
          });
          return out;
        };
        // a leader from the dot to the label's nearest edge, kept off every name and label
        var leaderOf = function (x, y, b) { return [x, y, Math.max(b[0], Math.min(b[2], x)), Math.max(b[1], Math.min(b[3], y))]; };
        var leaderBoxes = function (l) {
          var len = Math.hypot(l[2] - l[0], l[3] - l[1]), out = [];
          for (var u = 5; u < len - 2; u += 5) { var lx = l[0] + (l[2] - l[0]) * u / len, ly = l[1] + (l[3] - l[1]) * u / len; out.push([lx - 1.5, ly - 1.5, lx + 1.5, ly + 1.5]); }
          return out;
        };
        // with kinds, the surface first gives each kind half the budget, then fills
        var kindOf = model.commentKind || {}, hasKinds = sb.n > 0 && Object.keys(kindOf).length > 0;
        var perKind = {}, done = {}, halves = hasKinds ? [Math.ceil(cap / 2), Infinity] : [Infinity];
        for (var hv = 0; hv < halves.length; hv++)
        for (var ci = 0; ci < model.commentOrder.length && comments.length < cap; ci++) {
          var pi = model.commentOrder[ci], px0 = sx(PX.x[pi]), py0 = sy(PX.y[pi]);
          if (done[pi]) continue;
          if (px0 < 0 || py0 < 0 || px0 > W || py0 > H) continue;
          var kd = kindOf[pi] || "";
          if (hasKinds && (perKind[kd] || 0) >= halves[hv]) continue;
          var words = PX.text[pi].trim().split(/\s+/), nw = Math.min(words.length, nWords);
          var ctext = words.slice(0, nw).join(" ") + (nw < words.length ? "…" : "");
          var clines = wrapText(ctext, cWrap), clw = [], cwid = 0, ccut = nw < words.length;
          if (C.maxLines > 0 && clines.length > C.maxLines) {
            clines = clines.slice(0, C.maxLines);
            clines[clines.length - 1] = clines[clines.length - 1].replace(/[\s…]*$/, "") + "…";
            ctext = clines.join(" "); ccut = true;
          }
          for (var cl = 0; cl < clines.length; cl++) { var cmw = measure(clines[cl], cSpec); clw.push(cmw); cwid = Math.max(cwid, cmw); }
          var ch = clines.length * clh;
          var bw = slot ? cwid + slot.gap + slot.w : cwid, bh = slot ? Math.max(ch, slot.h) : ch;
          var ck = "c" + pi, base = sb.n > 0 ? besideTries(bw, bh) : ctries;
          var cTries = prev ? candidates(ck, cf, px0, py0, sb.n > 0 ? Infinity : creach, base) : base, cDone = false;
          for (var cpass = 0; cpass < passes.length && !cDone; cpass++)
          for (var cj = 0; cj < cTries.length; cj++) {
            var bx = px0 + cTries[cj][0], by = py0 + cTries[cj][1];
            var cb = [bx - bw / 2 - cm, by - bh / 2 - cm, bx + bw / 2 + cm, by + bh / 2 + cm];
            if (cb[0] < 2 || cb[1] < 2 || cb[2] > W - 2 || cb[3] > H - 2) continue;
            if (hits(cb)) continue;
            if (passes[cpass] && !cTries[cj][2] && hitsReserved(cb, ck)) continue;
            var leader = null, lboxes = [];
            if (sb.n > 0) {
              if (coversDot(cb)) continue;
              leader = leaderOf(px0, py0, cb); lboxes = leaderBoxes(leader);
              if (Math.hypot(leader[2] - px0, leader[3] - py0) > surf.reach + surf.gap) continue;
              if (lboxes.some(hits)) continue;
            }
            if (prev) release(ck);
            cDone = true;
            add(cb); lboxes.forEach(add);
            var tx = bx - bw / 2 + cwid / 2;
            comments.push({ point: pi, id: PX.id[pi], text: ctext, cut: ccut, lines: clines, f: cf, weight: cw, fam: cfam,
              letterSpacing: "0px", lh: clh, lineWidths: clw, w: cwid, h: ch, x: tx, y: by, x0: px0, y0: py0, box: cb,
              ink: pal.commentInk, alpha: pal.commentAlpha, haloWidth: pal.haloWidth(cf), align: C.align === "left" ? "left" : "center",
              slot: slot ? { x: tx + cwid / 2 + slot.gap, y: by - slot.h / 2, w: slot.w, h: slot.h } : null, leader: leader });
            break;
          }
          if (cDone) { done[pi] = true; perKind[kd] = (perKind[kd] || 0) + 1; }
        }
      }
    }
    stats.comments = comments.length;
    var sh = stats.shift.slice().sort(function (p, q) { return p - q; });
    stats.shiftMedian = sh.length ? sh[Math.floor(sh.length / 2)] : 0;
    stats.shiftP90 = sh.length ? sh[Math.floor(sh.length * 0.9)] : 0;
    return { W: W, H: H, fit: fit, view: view, settings: cfg, placed: placed, dropped: dropped, stats: stats,
      comments: comments, commentLevel: commentLevel, zoneCount: model.zoneIdx.length, layerTotals: layerTotals(model) };
  }

  // Whether the points in this view are few enough and far enough apart for
  // comment labels: how many are in view, and the median distance in px from
  // each to its nearest neighbour in view (null when it is not worked out).
  function commentsInView(model, view, W, H, C) {
    var X = model.points.x, Y = model.points.y, xs = [], ys = [];
    for (var i = 0; i < model.points.n; i++) {
      var x = X[i] * view.s + view.tx, y = -Y[i] * view.s + view.ty;
      if (x >= 0 && y >= 0 && x <= W && y <= H) { xs.push(x); ys.push(y); }
    }
    var n = xs.length;
    if (!n || n > C.maxPoints) return { on: false, inView: n, spacing: null };
    if (n === 1) return { on: true, inView: 1, spacing: null };
    var nn = [];
    for (i = 0; i < n; i++) {
      var best = Infinity;
      for (var j = 0; j < n; j++) if (j !== i) best = Math.min(best, Math.hypot(xs[i] - xs[j], ys[i] - ys[j]));
      nn.push(best);
    }
    nn.sort(function (a, b) { return a - b; });
    var spacing = nn[n >> 1];
    return { on: spacing >= C.minSpacing, inView: n, spacing: spacing };
  }

  function layerTotals(model) {
    var out = {};
    model.topics.forEach(function (t) { out[t.level] = (out[t.level] || 0) + 1; });
    return out;
  }

  // The order names are drawn in: faint first, then coarse before fine, so
  // finer names sit on top. A name's first line is centred at y - h/2 + lh/2.
  function drawOrder(placed) {
    return placed.slice().sort(function (a, b) { return (a.alpha - b.alpha) || (b.L - a.L); });
  }

  // The line under the map, without its timing sentence.
  function caption(frame) {
    var cfg = frame.settings, st = frame.stats;
    var lv = cfg.layers.map(function (L) {
      var name = L === cfg.zoneLayer ? "layer " + L + " (" + frame.zoneCount + " zones)" : "layer " + L;
      return name + ": " + (st.byLayer[L] || 0) + " of " + (frame.layerTotals[L] || 0);
    }).join("; ");
    var placedN = Object.keys(st.byLayer).reduce(function (a, k) { return a + st.byLayer[k]; }, 0);
    var zoom = frame.view.s / frame.fit.s;
    return "Drawn now at " + frame.W + " by " + frame.H + " px" + (cfg.dynamic ? ", zoom ×" + zoom.toFixed(1) : "") + ": " +
      placedN + " topic names (" + lv + "). Shrunk to fit: " + st.shrunk + ". Moved off their centroid: median " +
      st.shiftMedian.toFixed(1) + ", 90th percentile " + st.shiftP90.toFixed(1) + " font heights.";
  }

  function dotRadius(model, frame) {
    return model.settings.dotRadius * Math.min(2.2, Math.max(1, Math.sqrt(frame.view.s / frame.fit.s) * 0.9));
  }

  /* ------------------------------------------- density grids and outlines */

  // The grid's cell in px and the blur's sigma in px at this view.
  function gridScale(frame) {
    var W = frame.W, H = frame.H, zoom = frame.view.s / frame.fit.s;
    return {
      cell: Math.max(3, Math.round(Math.min(W, H) / 260 * Math.min(4, Math.sqrt(zoom)))),
      sigma: 0.022 * Math.min(W, H) * zoom
    };
  }
  function blurRadius(sigmaPx, cell) { return Math.max(1, Math.round(sigmaPx / cell)); }
  function gridSize(frame, cell) { return { gw: Math.ceil(frame.W / cell) + 2, gh: Math.ceil(frame.H / cell) + 2 }; }

  function binInto(model, frame, filter, cell, gw, gh, g) {
    var v = frame.view, X = model.points.x, Y = model.points.y;
    for (var i = 0; i < model.points.n; i++) {
      if (!filter(i)) continue;
      var gx = Math.floor((X[i] * v.s + v.tx) / cell), gy = Math.floor((-Y[i] * v.s + v.ty) / cell);
      if (gx < 0 || gy < 0 || gx >= gw || gy >= gh) continue;
      g(gy * gw + gx);
    }
  }
  // The points counted into each cell before blurring, by cell index.
  function binnedCounts(model, frame, filter, cell) {
    var s = gridSize(frame, cell), out = {};
    binInto(model, frame, filter, cell, s.gw, s.gh, function (k) { out[k] = (out[k] || 0) + 1; });
    return out;
  }
  // The points that pass filter, counted on a grid of cell px and blurred by
  // three passes of a separable box blur (a near-Gaussian of sigma px).
  function densityGrid(model, frame, filter, cell, sigmaPx) {
    var s = gridSize(frame, cell), gw = s.gw, gh = s.gh;
    var g = new Float32Array(gw * gh);
    binInto(model, frame, filter, cell, gw, gh, function (k) { g[k] += 1; });
    var rad = blurRadius(sigmaPx, cell);
    var tmp = new Float32Array(gw * gh);
    var x, y, acc, add, sub;
    for (var pass = 0; pass < 3; pass++) {
      for (y = 0; y < gh; y++) { acc = 0; for (x = -rad; x < gw + rad; x++) {
        add = x + rad < gw ? g[y * gw + x + rad] : 0; sub = x - rad - 1 >= 0 ? g[y * gw + x - rad - 1] : 0;
        acc += add - sub; if (x >= 0 && x < gw) tmp[y * gw + x] = acc / (2 * rad + 1); } }
      for (x = 0; x < gw; x++) { acc = 0; for (y = -rad; y < gh + rad; y++) {
        add = y + rad < gh ? tmp[(y + rad) * gw + x] : 0; sub = y - rad - 1 >= 0 ? tmp[(y - rad - 1) * gw + x] : 0;
        acc += add - sub; if (y >= 0 && y < gh) g[y * gw + x] = acc / (2 * rad + 1); } }
    }
    var mx = 0; for (var k = 0; k < g.length; k++) mx = Math.max(mx, g[k]);
    return { g: g, gw: gw, gh: gh, cell: cell, mx: mx };
  }

  // Marching squares at thr, as separate segments [x1, y1, x2, y2] in px.
  var EDGES = { 1: ["l", "t"], 2: ["t", "r"], 3: ["l", "r"], 4: ["r", "b"], 5: ["l", "t", "r", "b"], 6: ["t", "b"], 7: ["l", "b"],
    8: ["b", "l"], 9: ["t", "b"], 10: ["t", "r", "b", "l"], 11: ["r", "b"], 12: ["r", "l"], 13: ["t", "r"], 14: ["l", "t"] };
  function contourSegs(G, thr) {
    var g = G.g, gw = G.gw, gh = G.gh, cell = G.cell; var segs = [];
    var v = function (x, y) { return g[y * gw + x]; };
    var lerp = function (a, b) { return (thr - a) / (b - a); };
    for (var y = 0; y < gh - 1; y++) for (var x = 0; x < gw - 1; x++) {
      var a = v(x, y), b = v(x + 1, y), c = v(x + 1, y + 1), d = v(x, y + 1);
      var k = (a > thr) | ((b > thr) << 1) | ((c > thr) << 2) | ((d > thr) << 3);
      if (k === 0 || k === 15) continue;
      var P = { t: [x + lerp(a, b), y], r: [x + 1, y + lerp(b, c)], b: [x + lerp(d, c), y + 1], l: [x, y + lerp(a, d)] };
      var E = EDGES[k];
      for (var e = 0; e < E.length; e += 2) segs.push([P[E[e]][0] * cell, P[E[e]][1] * cell, P[E[e + 1]][0] * cell, P[E[e + 1]][1] * cell]);
    }
    return segs;
  }

  // The alpha (0 to 255) of every cell of a zone's tint image: a step of
  // alpha for each fraction of the peak the cell exceeds.
  function zoneAlpha(G, zones, scheme) {
    var dark = scheme === "dark";
    var steps = [0.05, 0.16, 0.38];
    var st = zones === "tint" ? [steps[0]] : steps;
    var al = zones === "tint" ? [dark ? 0.16 : 0.2] : (dark ? [0.10, 0.10, 0.12] : [0.13, 0.12, 0.14]);
    var out = new Uint8ClampedArray(G.g.length);
    for (var k = 0; k < G.g.length; k++) {
      var v = G.g[k] / G.mx; var a = 0;
      for (var s = 0; s < st.length; s++) if (v > st[s]) a += al[s];
      out[k] = Math.round(a * 255);
    }
    return out;
  }

  // Every zone and district shape at this view, in the order they are drawn
  // (zones in topic order, each tint then outline; then the districts). A
  // zone or district whose grid is empty is left out. A zone's points are the
  // points the zone level assigns to it, not those reached through parents.
  function zoneShapes(model, frame) {
    var cfg = model.settings, pal = palette(cfg.scheme), T = model.topics, topic = model.points.topic;
    var sc = gridScale(frame);
    var zoomedIn = !!cfg.zoom && frame.view.s / frame.fit.s > 1 + 1e-9;
    var tintOf = zoomedIn ? pal.zoneTintZoomed : pal.zoneTint;
    var zones = [], districts = [];
    if (!(cfg.zones === "none" && cfg.subOutline == null)) {
      var list = cfg.zones === "none" ? [] : model.zoneIdx;
      list.forEach(function (zi) {
        var h = model.hueOf[zi] == null ? 220 : model.hueOf[zi];
        var G = densityGrid(model, frame, function (i) { return topic[cfg.zoneLayer][i] === zi; }, sc.cell, sc.sigma);
        if (G.mx <= 0) return;
        var thr = G.mx * 0.05;
        var hasFill = cfg.zones === "halo" || cfg.zones === "tint";
        var hasLine = cfg.zones === "outline" || cfg.zones === "tint";
        zones.push({ ti: zi, id: T[zi].id, hue: h, grid: G, threshold: thr,
          tint: hasFill ? tintOf(h) : null, alpha: hasFill ? zoneAlpha(G, cfg.zones, cfg.scheme) : null,
          outline: hasLine ? pal.zoneOutline(h) : null, outlineWidth: pal.zoneOutlineWidth,
          segs: hasLine ? contourSegs(G, thr) : [] });
      });
      model.districtIdx.forEach(function (ti) {
        var G = densityGrid(model, frame, function (i) { return topic[cfg.subOutline][i] === ti; }, sc.cell, sc.sigma * 0.7);
        if (G.mx <= 0) return;
        var thr = G.mx * 0.12;
        districts.push({ ti: ti, id: T[ti].id, hue: model.hueOf[ti], grid: G, threshold: thr,
          stroke: pal.districtStroke(model.hueOf[ti]), width: pal.districtWidth, dash: pal.districtDash.slice(),
          segs: contourSegs(G, thr) });
      });
    }
    return { cell: sc.cell, sigma: sc.sigma, zones: zones, districts: districts };
  }

  // The shapes of the map, worked out once from the data: every zone and
  // district at the fit for this size, which is the picture at rest. Any
  // other view draws these same shapes scaled and moved (shapeTransform), so
  // a border never changes shape with the zoom.
  function fixedShapes(model, width, height) {
    var size = canvasSize(width, height), fit = fitFor(model, size.W, size.H);
    return zoneShapes(model, { W: size.W, H: size.H, view: fit, fit: fit });
  }

  // How the shapes at the fit land in a view: screen = k * fit px + (ox, oy).
  function shapeTransform(fit, view) {
    var k = view.s / fit.s;
    return { k: k, ox: view.tx - fit.tx * k, oy: view.ty - fit.ty * k };
  }

  // How far a zone's tint has turned from its tint at rest to its tint
  // zoomed in (palette().zoneTintZoomed), 0 to 1: 0 at the fit and zoomed
  // out, 1 from the first step, eased between, so the tint never changes at
  // one zoom.
  function zoomedTintShare(model, zoom) {
    var Z = model.settings.zoom, first = Z && Z.steps && Z.steps.length ? Z.steps[0] : 1.5;
    if (!Z || !(zoom > 1)) return 0;
    var u = Math.max(0, Math.min(1, (zoom - 1) / Math.max(1e-6, first - 1)));
    return u * u * (3 - 2 * u);
  }

  var PolisTopicMapDense = {
    fixedShapes: fixedShapes, shapeTransform: shapeTransform, zoomedTintShare: zoomedTintShare,
    DEFAULTS: DEFAULTS, PRESET_DENSE: PRESET_DENSE, PRESET_ZOOM: PRESET_ZOOM, DEFAULT_FACE: DEFAULT_FACE,
    resolveZoom: resolveZoom, commentsInView: commentsInView, zoomStage: zoomStage, WARM_TINT: WARM_TINT, NEUTRAL_TINT: NEUTRAL_TINT,
    rolesOf: rolesOf, resolveSettings: resolveSettings, stripNamePrefix: stripNamePrefix, wrapText: wrapText,
    weightFor: weightFor, palette: palette, GREY_GROUND: GREY_GROUND, towardGrey: towardGrey, topicSpread: topicSpread, prepare: prepare, canvasSize: canvasSize,
    fitView: fitView, fitFor: fitFor, zoneReach: zoneReach, layout: layout, drawOrder: drawOrder, caption: caption, dotRadius: dotRadius,
    gridScale: gridScale, blurRadius: blurRadius, binnedCounts: binnedCounts, densityGrid: densityGrid,
    contourSegs: contourSegs, zoneAlpha: zoneAlpha, zoneShapes: zoneShapes,
    surfaceBudget: surfaceBudget, isSmall: isSmall, zoomLimit: zoomLimit
  };

  root.PolisTopicMapDense = PolisTopicMapDense;
  if (typeof module !== "undefined" && module.exports) module.exports = PolisTopicMapDense;
})(typeof globalThis !== "undefined" ? globalThis : this);
