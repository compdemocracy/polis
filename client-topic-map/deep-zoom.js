/*
 * PolisTopicMapDeepZoom: the deepest zoom of the dense drawing, where a few
 * comments are read. Over a PolisTopicMap drawn with drawing: "dense", it
 *
 *   - picks, of the comments that stand out on the whole map by the
 *     highlights rules (PolisTopicMapHighlights: the top tenth for
 *     group-informed consensus, the top tenth for division, a floor of
 *     votes), those the map may label, strongest first, and hands them to the
 *     map as its comment labels (zoom.comments.only), with their text wrapped
 *     to a few lines and a reserved box beside each (zoom.slot); the map
 *     places at most `budget` of them, those in view, never over each other
 *     or over the names. A view with no standout shows none;
 *   - draws, after each placement, the four-row group vote graphic
 *     (PolisVoteGraphic, rows) in each label's reserved box, and a short rule
 *     at the label's left in the report's colour for consensus or division;
 *   - at the deepest step, writes every other comment in view as a lead: its
 *     first few words on one line beside its dot, smaller and quieter than
 *     the standouts, never over another lead, a standout, a graphic, a name
 *     or another dot; a lead with no room is left out, fewest votes first;
 *   - reveals the comment nearest the pointer (within `reach` px; a Voronoi
 *     partition of the comments in view, read from a grid built once per
 *     settled view) or under keyboard focus: its dot is ringed and a card
 *     shows its text, its four-row graphic and the counts in words
 *     (PolisVoteGraphic.readout); moving away hides it;
 *   - selects a comment (or a standout) on click: the card stays, with the
 *     poured form at a size where its dots read, and the counts beside it;
 *     a click elsewhere or Escape clears. One comment is selected at a time.
 *
 * Where the document has no text, no label is placed (the card then names
 * the comment's topic only); where there are no per-group counts, no
 * comment stands out and no graphic is drawn. Nothing is made up.
 *
 *   var deep = new PolisTopicMapDeepZoom(map, { math: pca2, comments: list });
 *   element.addEventListener("commentselect", function (e) { e.detail.id; });
 *   deep.reveal(id); deep.select(id); deep.clear(); deep.destroy();
 *
 * It works as a classic script (window.PolisTopicMapDeepZoom; load
 * highlights.js and vote-graphic.js first) and as a CommonJS module.
 */
(function (root) {
  "use strict";

  var H = root.PolisTopicMapHighlights, G = root.PolisVoteGraphic;
  if (typeof module !== "undefined" && module.exports && typeof require === "function") {
    H = H || require("./highlights.js");
    G = G || require("./vote-graphic.js");
  }

  var DEFAULTS = {
    budget: 5,              // standouts readable at once (the map's zoom.budget.comments)
    standout: 0.9,          // the highlights rule: the top tenth of the map, per measure
    minVotes: 5,            // and its floor of votes
    font: 14,               // a standout's text, px
    words: 60,              // words of a standout's text at most
    wrap: 30,               // characters per line (about the width 34 gave at 12 px)
    maxLines: 4,            // lines at most, the last cut with "…"
    slot: { w: 34, h: 15, gap: 6 },     // the reserved box: the four rows at 34 by 15 (3 px rows)
    rule: 3,                // px: the coloured rule at a standout's left
    leader: "#9ba1aa",      // the line from a dot to its comment written out beside it (a grey that recedes)
    // the card: its comment text (font) and its smaller lines (small), px
    card: { width: 300, font: 14, small: 12, rowsW: 84, rowsH: 19, pouredW: 168, pouredH: 84 },
    // px: the pointer picks the comment nearest it within this distance (the
    // comments' Voronoi cells, cut at reach); further from every comment,
    // nothing is picked and a click clears the selection
    reach: 40,
    // the deepest step's leads: at most `words` words and `chars` characters
    // on one line (cut with "…"), `font` px at `weight`, `gap` px from the dot
    lead: { words: 5, chars: 30, font: 12, weight: 400, gap: 6, ink: "#6f7682", halo: "rgba(255, 255, 255, 0.9)" },
    scheme: "light",
    // The report's own colours for agree and disagree (client-report
    // src/components/globals.js, brandColors), as the highlights page uses them.
    colors: { consensus: "rgb(46, 204, 113)", division: "rgb(231, 76, 60)" }
  };

  function merge(o) {
    o = o || {};
    var out = Object.assign({}, DEFAULTS, o);
    out.slot = Object.assign({}, DEFAULTS.slot, o.slot || {});
    out.card = Object.assign({}, DEFAULTS.card, o.card || {});
    out.colors = Object.assign({}, DEFAULTS.colors, o.colors || {});
    out.lead = o.lead === false ? false : Object.assign({}, DEFAULTS.lead, o.lead || {});
    return out;
  }

  /* ------------------------------------------------------- pure functions */

  // Whether the math result carries per-group counts for this comment id.
  function hasCounts(math, id) {
    var gv = math && math["group-votes"];
    if (!gv) return false;
    return Object.keys(gv).some(function (g) { return gv[g] && gv[g].votes && gv[g].votes[id]; });
  }

  // The numbers the highlights rules take, from the math result and the
  // comment list, or from the document's points.votes when there is no list.
  function numbersFor(doc, math, comments) {
    var n = H.numbersFrom(math, comments);
    if (!comments && doc && doc.points && Array.isArray(doc.points.votes)) {
      n.votes = {};
      doc.points.id.forEach(function (id, i) { if (id != null) n.votes[id] = doc.points.votes[i]; });
    }
    return n;
  }

  // The standouts of the whole map, strongest first: [{ id, index, kind,
  // strength }]. kind is "consensus" or "division"; strength is 1 minus the
  // comment's rank among the eligible comments for that measure over their
  // count (1 for the first). A comment standing out for both keeps the
  // stronger. Ties: the smaller id first.
  function standoutRanking(doc, numbers, options) {
    var o = merge(options);
    numbers = numbers || {};
    var best = {};
    [["consensus", numbers.consensus], ["division", numbers.divisive]].forEach(function (m) {
      var el = H.eligible(doc, m[1], numbers.votes, o.minVotes);
      if (!el.length) return;
      var sorted = H.top(el, el.length), line = H.standoutLine(el.map(function (e) { return e.value; }), o.standout);
      sorted.forEach(function (e, r) {
        if (!(e.value >= line)) return;
        var s = 1 - r / sorted.length, k = String(e.id);
        if (!best[k] || s > best[k].strength) best[k] = { id: e.id, index: e.index, kind: m[0], strength: s };
      });
    });
    return Object.keys(best).map(function (k) { return best[k]; }).sort(function (a, b) {
      return b.strength - a.strength || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
    });
  }

  // The dense drawing's settings that make the map label the standouts:
  // merged by the map over PRESET_DENSE and PRESET_ZOOM.
  // The standouts in the order they are written out: the two kinds taken
  // in turn, each strongest first, starting with the stronger kind's first,
  // so a short budget is shared between group-informed consensus and division.
  function balancedOrder(ranking) {
    var by = { consensus: [], division: [] };
    ranking.forEach(function (r) { (by[r.kind] || (by[r.kind] = [])).push(r); });
    var first = ranking.length && ranking[0].kind === "division" ? "division" : "consensus";
    var a = by[first], b = by[first === "division" ? "consensus" : "division"], out = [];
    for (var i = 0; i < Math.max(a.length, b.length); i++) { if (a[i]) out.push(a[i]); if (b[i]) out.push(b[i]); }
    return out;
  }

  function drawingSettings(ranking, options, withSlot) {
    var o = merge(options), order = balancedOrder(ranking);
    return { zoom: {
      comments: { only: order.map(function (r) { return r.id; }), kinds: order.map(function (r) { return r.kind; }), font: o.font, words: o.words, wordsPerDoubling: 0,
        wrap: o.wrap, wrapPerDoubling: 0, maxLines: o.maxLines, align: "left" },
      slot: withSlot ? { w: o.slot.w, h: o.slot.h, gap: o.slot.gap } : null,
      budget: { comments: o.budget }
    } };
  }

  // The comments a pointer can pick ([{ i, x, y }] in screen px), on a grid
  // of `cell` px: built once per settled view, so a pointer move reads only
  // the cells around it, never every comment.
  function pointIndex(dots, cell) {
    cell = Math.max(1, cell || 1);
    var cells = new Map();
    dots.forEach(function (d) {
      var k = Math.floor(d.x / cell) + "," + Math.floor(d.y / cell), a = cells.get(k);
      if (!a) cells.set(k, a = []);
      a.push(d);
    });
    return { cell: cell, cells: cells, dots: dots };
  }

  // The point index of the comment nearest (px, py) within reach px, or
  // null: each comment's Voronoi cell, cut at reach. At equal distance the
  // smaller point index wins, so a tie always picks the same comment.
  function nearestPoint(index, px, py, reach) {
    if (!index || !(reach > 0)) return null;
    var c = index.cell, r = Math.ceil(reach / c), gx = Math.floor(px / c), gy = Math.floor(py / c);
    var best = null, bd = reach * reach;
    for (var x = gx - r; x <= gx + r; x++) for (var y = gy - r; y <= gy + r; y++) {
      var a = index.cells.get(x + "," + y);
      if (!a) continue;
      for (var k = 0; k < a.length; k++) {
        var d = a[k], dd = (d.x - px) * (d.x - px) + (d.y - py) * (d.y - py);
        if (best === null ? dd <= bd : (dd < bd || (dd === bd && d.i < best.i))) { bd = dd; best = d; }
      }
    }
    return best ? best.i : null;
  }

  // A comment's lead: its first words on one line, at most `words` words and
  // `chars` characters, cut with "…" when anything is left out.
  function leadText(text, words, chars) {
    var w = String(text == null ? "" : text).trim().split(/\s+/).filter(Boolean);
    if (!w.length) return "";
    var out = "", n = 0;
    for (; n < w.length && n < words; n++) {
      var next = out ? out + " " + w[n] : w[n];
      if (next.length > chars && out) break;
      out = next;
    }
    var cut = n < w.length;
    if (out.length > chars) { out = out.slice(0, Math.max(1, chars - 1)); cut = true; }
    return cut ? out.replace(/[\s,.;:!?\u2013\u2014-]+$/, "") + "\u2026" : out;
  }

  function overlaps(a, b) { return a[0] < b[2] && a[2] > b[0] && a[1] < b[3] && a[3] > b[1]; }

  // The leads at the deepest step. cands: the comments in view that are not
  // written out, [{ i, x, y, text, votes }] (screen px); o: { W, H, measure,
  // lead, taken, dots }, where taken are the boxes [x0, y0, x1, y1] no lead
  // may overlap (the names, the written-out comments with their graphics and
  // rules, their leaders) and dots the comments in view ({ i, x, y }), whose
  // dots no lead may cover but its own. Most votes first, then the smaller
  // point index, so where there is no room the fewest votes are left out.
  // Each lead tries the right of its dot, then the left, then a line above
  // or below on either side; with no free place it is left out.
  // Returns [{ point, text, x, y, w, h, box }]: x, y the text's top left.
  function placeLeads(cands, o) {
    var L = o.lead, out = [];
    if (!L || !cands.length) return out;
    var boxes = (o.taken || []).slice(), dots = o.dots || [], W = o.W, H = o.H;
    var h = Math.round(L.font * 1.25), g = L.gap, m = 1, dr = 2.5;
    var free = function (b, self) {
      if (b[0] < 2 || b[1] < 2 || b[2] > W - 2 || b[3] > H - 2) return false;
      for (var k = 0; k < boxes.length; k++) if (overlaps(b, boxes[k])) return false;
      for (var q = 0; q < dots.length; q++) {
        var d = dots[q];
        if (d.i !== self && d.x > b[0] - dr && d.x < b[2] + dr && d.y > b[1] - dr && d.y < b[3] + dr) return false;
      }
      return true;
    };
    cands.slice().sort(function (a, b) { return (b.votes || 0) - (a.votes || 0) || a.i - b.i; }).forEach(function (c) {
      var t = leadText(c.text, L.words, L.chars);
      if (!t) return;
      var w = Math.ceil(o.measure(t, L)), hg = g * 0.5;
      var tries = [[c.x + g, c.y - h / 2], [c.x - g - w, c.y - h / 2],
        [c.x + hg, c.y - hg - h], [c.x + hg, c.y + hg], [c.x - hg - w, c.y - hg - h], [c.x - hg - w, c.y + hg]];
      for (var j = 0; j < tries.length; j++) {
        var x = tries[j][0], y = tries[j][1], b = [x - m, y - m, x + w + m, y + h + m];
        if (!free(b, c.i)) continue;
        boxes.push(b);
        out.push({ point: c.i, text: t, x: x, y: y, w: w, h: h, box: b });
        return;
      }
    });
    return out;
  }

  /* ---------------------------------------------------------- the overlay */

  function PolisTopicMapDeepZoom(map, options) {
    if (!map || !map.canvas) throw new Error("PolisTopicMapDeepZoom: a PolisTopicMap is needed");
    var o = this.options = merge(options);
    this.map = map;
    this.el = map.canvas.parentNode;
    this.doc = o.data || map.data;
    this.math = o.math || null;
    this.numbers = o.numbers || numbersFor(this.doc, this.math, o.comments || null);
    this.ranking = standoutRanking(this.doc, this.numbers, o);
    this.rank = {};
    var self = this;
    this.ranking.forEach(function (r) { self.rank[String(r.id)] = r; });
    this.labels = []; this.leads = []; this.on = false; this.deep = false; this.moving = false; this._ix = null;
    this.hovered = null; this.selected = null; this.focusIndex = -1;

    var doc = document, el = this.el;
    var ov = this.overlay = doc.createElement("canvas");
    ov.style.cssText = "position:absolute;left:0;top:0;pointer-events:none;z-index:1";
    el.appendChild(ov);
    var card = this.card = doc.createElement("div");
    card.style.cssText = "position:absolute;left:0;top:0;display:none;pointer-events:none;z-index:2;box-sizing:border-box;" +
      "background:#ffffff;color:#2b3038;border:1px solid #d5d9df;border-radius:4px;box-shadow:0 2px 8px rgba(16,24,40,0.14);" +
      "padding:8px 10px;font:" + o.card.font + "px/1.35 " + (map.theme && map.theme.font ? map.theme.font.family : "sans-serif") + ";width:" + o.card.width + "px";
    el.appendChild(card);
    if (!el.hasAttribute("tabindex")) el.setAttribute("tabindex", "0");

    // the page's own dense settings (options.drawing), with the standouts' labels over them
    var given = options && options.drawing && typeof options.drawing === "object" ? options.drawing : {};
    var ds = drawingSettings(this.ranking, o, !!this.math);
    map.setDrawing(Object.assign({}, given, { zoom: Object.assign({}, given.zoom || {}, ds.zoom) }));

    var down = null;
    this._h = {
      comments: function (e) {
        self.labels = e.detail.comments || []; self.on = !!e.detail.on; self.deep = !!(e.detail.on && e.detail.deep);
        self.moving = false; self._ix = null; self._placeLeads(); self._paint();
        // a card comes back only while its comment is still in view
        var back = self.selected !== null ? self.selected : self.hovered;
        if (self.on && back !== null && self._inView(back)) self._showCard(back, self.selected !== null);
        else self._hideCard();
        // the rows and rules fade in with the comment labels they stand beside
        var st = self.overlay.style, fade = map.drawing && map.drawing.zoom ? map.drawing.zoom.fadeMs : 0;
        if (st && fade > 0 && root.requestAnimationFrame && !(root.matchMedia && root.matchMedia("(prefers-reduced-motion: reduce)").matches)) {
          st.transition = "none"; st.opacity = "0";
          root.requestAnimationFrame(function () { st.transition = "opacity " + fade + "ms"; st.opacity = "1"; });
        } else if (st) { st.transition = "none"; st.opacity = "1"; }
      },
      down: function (e) { down = { x: e.clientX, y: e.clientY }; self.moving = true; self._clearOverlay(); self._hideCard(); },
      up: function () { self.moving = false; },
      wheel: function () { self.moving = true; self._clearOverlay(); self._hideCard(); },
      move: function (e) {
        if (e.buttons) return;
        var p = self._local(e), hit = self._hit(p.x, p.y);
        self._setHover(hit);
      },
      leave: function () { self._setHover(null); },
      click: function (e) {
        var p = self._local(e);
        if (down && Math.hypot(e.clientX - down.x, e.clientY - down.y) > 4) return;
        var hit = self._hit(p.x, p.y);
        if (hit !== null) self.select(self.doc.points.id[hit]); else self.clear();
      },
      key: function (e) {
        if (e.key === "Escape") { self.clear(); self._setHover(null); return; }
        var dots = self._dotsInView();
        if (!dots.length) return;
        if (e.key === "ArrowRight" || e.key === "ArrowDown") { self.focusIndex = (self.focusIndex + 1) % dots.length; }
        else if (e.key === "ArrowLeft" || e.key === "ArrowUp") { self.focusIndex = (self.focusIndex - 1 + dots.length) % dots.length; }
        else if ((e.key === "Enter" || e.key === " ") && self.hovered !== null) { e.preventDefault(); self.select(self.doc.points.id[self.hovered]); return; }
        else return;
        e.preventDefault();
        self._setHover(dots[self.focusIndex].i);
      },
      blur: function () { self.focusIndex = -1; if (self.selected === null) self._setHover(null); }
    };
    el.addEventListener("densecomments", this._h.comments);
    el.addEventListener("pointerdown", this._h.down);
    el.addEventListener("pointerup", this._h.up);
    el.addEventListener("wheel", this._h.wheel, { passive: true });
    el.addEventListener("pointermove", this._h.move);
    el.addEventListener("pointerleave", this._h.leave);
    el.addEventListener("click", this._h.click);
    el.addEventListener("keydown", this._h.key);
    el.addEventListener("blur", this._h.blur);
    var lay = map.denseLayout && map.denseLayout();
    if (lay) {
      var cl = lay.commentLevel || {};
      this.labels = lay.comments || []; this.on = !!cl.on; this.deep = !!(cl.on && cl.deep);
      this._placeLeads(); this._paint();
    }
  }

  var P = PolisTopicMapDeepZoom.prototype;

  P._local = function (e) {
    var r = this.map.canvas.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  };

  P._view = function () {
    var lay = this.map.denseLayout && this.map.denseLayout();
    return lay ? { view: lay.view, W: lay.width, H: lay.height } : null;
  };

  P._screen = function (i, v) {
    var X = this.doc.points.x, Y = this.doc.points.y;
    return { x: X[i] * v.s + v.tx, y: -Y[i] * v.s + v.ty };
  };

  // Whether point i is on screen in the settled view.
  P._inView = function (i) {
    var lv = this._view();
    if (!lv) return false;
    var s = this._screen(i, lv.view);
    return s.x >= 0 && s.y >= 0 && s.x <= lv.W && s.y <= lv.H;
  };

  // The comments in view (with an id) and their grid, for the settled view:
  // built once per view (one pass over the points), not per pointer move.
  P._index = function () {
    var lv = this._view();
    if (!lv || !this.on) return null;
    var v = lv.view, key = [v.s, v.tx, v.ty, lv.W, lv.H].join(",");
    if (this._ix && this._ix.key === key) return this._ix.index;
    var ids = this.doc.points.id, out = [];
    for (var i = 0; i < ids.length; i++) {
      if (ids[i] == null) continue;
      var s = this._screen(i, v);
      if (s.x >= 0 && s.y >= 0 && s.x <= lv.W && s.y <= lv.H) out.push({ i: i, x: s.x, y: s.y });
    }
    out.sort(function (a, b) { return a.x - b.x || a.y - b.y; });
    var index = pointIndex(out, this.options.reach);
    this._ix = { key: key, index: index };
    return index;
  };

  // The comments in view (with an id), left to right: [{ i, x, y }].
  P._dotsInView = function () {
    var ix = this._index();
    return ix ? ix.dots : [];
  };

  // The point the pointer picks at (px, py): a written-out comment's text or
  // graphic first, then a lead's words, then the comment nearest within
  // reach; null when none is, or when the view is not close enough for
  // comments (the map's own tooltip answers there).
  P._hit = function (px, py) {
    if (!this.on || this.moving) return null;
    var inBox = function (b) { return px >= b[0] && px <= b[2] && py >= b[1] && py <= b[3]; };
    for (var j = 0; j < this.labels.length; j++) if (inBox(this.labels[j].box)) return this.labels[j].point;
    for (var k = 0; k < this.leads.length; k++) if (inBox(this.leads[k].box)) return this.leads[k].point;
    return nearestPoint(this._index(), px, py, this.options.reach);
  };

  // The leads for the settled view: only at the deepest step.
  P._placeLeads = function () {
    this.leads = [];
    var o = this.options, L = o.lead, lv = this._view(), P0 = this.doc.points;
    if (!L || !this.deep || !lv || !P0.text) return;
    var self = this, written = {}, taken = [];
    this.labels.forEach(function (l) {
      written[l.point] = true;
      taken.push([l.box[0] - o.rule - 4, l.box[1], l.box[2], l.box[3]]);
      if (l.leader) {
        var q = l.leader, len = Math.hypot(q[2] - q[0], q[3] - q[1]);
        for (var u = 0; u <= len; u += 4) { var x = q[0] + (q[2] - q[0]) * u / (len || 1), y = q[1] + (q[3] - q[1]) * u / (len || 1); taken.push([x - 1.5, y - 1.5, x + 1.5, y + 1.5]); }
      }
    });
    var lay = this.map.denseLayout && this.map.denseLayout();
    ((lay && lay.names) || []).forEach(function (n) { if (n.box) taken.push(n.box.slice()); });
    var dots = this._dotsInView(), votes = this.numbers && this.numbers.votes, cands = [];
    dots.forEach(function (d) {
      if (written[d.i]) return;
      var t = P0.text[d.i];
      if (typeof t !== "string" || !t.trim()) return;
      var id = P0.id[d.i], nv = Array.isArray(P0.votes) ? P0.votes[d.i] : votes ? votes[id] : 0;
      cands.push({ i: d.i, x: d.x, y: d.y, text: t, votes: Number(nv) || 0 });
    });
    var ctx = this.overlay.getContext && this.overlay.getContext("2d"), fam = this._family();
    var measure = function (t, f) {
      if (ctx && ctx.measureText) { ctx.font = f.weight + " " + f.font + "px " + fam; return ctx.measureText(t).width; }
      return t.length * f.font * 0.55;
    };
    this.leads = placeLeads(cands, { W: lv.W, H: lv.H, measure: measure, lead: L, taken: taken, dots: dots });
  };

  P._family = function () {
    var t = this.map.theme;
    return t && t.font && t.font.family ? t.font.family : "sans-serif";
  };

  P._groups = function (id) {
    return this.math && hasCounts(this.math, id) ? G.groupsFromMath(this.math, id) : null;
  };

  P._topicName = function (i) {
    var col = this.doc.points.topic[0], t = col ? col[i] : -1, T = this.doc.topics[t];
    if (!T) return null;
    return String(T.name || "").replace(/^\s*\d+_\d+\s*:\s*/, "");
  };

  P._setHover = function (i) {
    if (i === undefined) i = null;
    if (this.map.tooltip) this.map.tooltip.style.visibility = this.on ? "hidden" : "";
    if (i === this.hovered) return;
    this.hovered = i;
    if (this.selected === null) { if (i === null) this._hideCard(); else this._showCard(i, false); }
    this._paint();
  };

  P.reveal = function (id) {
    var i = this._indexOf(id);
    this._setHover(i);
  };

  P.select = function (id) {
    var i = id == null ? null : this._indexOf(id);
    var prev = this.selected === null ? null : this.doc.points.id[this.selected];
    if (i === this.selected) { if (i !== null) this._showCard(i, true); return; }
    this.selected = i;
    if (i === null) { if (this.hovered !== null) this._showCard(this.hovered, false); else this._hideCard(); }
    else this._showCard(i, true);
    this._paint();
    this.el.dispatchEvent(new CustomEvent("commentselect", { bubbles: true, detail: { id: i === null ? null : this.doc.points.id[i], previous: prev } }));
  };

  P.clear = function () { this.select(null); };

  P._indexOf = function (id) {
    var ids = this.doc.points.id;
    for (var i = 0; i < ids.length; i++) if (ids[i] != null && String(ids[i]) === String(id)) return i;
    return null;
  };

  P._hideCard = function () { this.card.style.display = "none"; };

  P._showCard = function (i, selected) {
    // Programmatic selection obeys the same stage and view as pointer input.
    if (!this.on || !this._inView(i)) { this._hideCard(); return; }
    var o = this.options, doc = document, card = this.card, id = this.doc.points.id[i];
    var text = this.doc.points.text && this.doc.points.text[i];
    var groups = this._groups(id), r = this.rank[String(id)];
    card.textContent = "";
    var add = function (tag, css, t) { var n = doc.createElement(tag); if (css) n.style.cssText = css; if (t != null) n.textContent = t; card.appendChild(n); return n; };
    if (r) {
      var k = add("div", "font-size:" + o.card.small + "px;color:#59606b;margin-bottom:4px");
      var sw = doc.createElement("span");
      sw.style.cssText = "display:inline-block;width:8px;height:8px;margin-right:5px;vertical-align:0;background:" + o.colors[r.kind];
      k.appendChild(sw);
      k.appendChild(doc.createTextNode(r.kind === "consensus" ? "Stands out for group-informed consensus" : "Stands out for division"));
    }
    if (typeof text === "string" && text.trim()) add("div", "margin-bottom:6px", text);
    var tn = this._topicName(i);
    if (tn) add("div", "font-size:" + o.card.small + "px;color:#59606b;margin-bottom:6px", "In " + tn);
    if (groups) {
      var w = selected ? o.card.pouredW : o.card.rowsW, h = selected ? o.card.pouredH : o.card.rowsH;
      var row = add("div", "display:flex;gap:10px;align-items:flex-start");
      var c = doc.createElement("canvas"), dpr = root.devicePixelRatio || 1;
      c.width = Math.round(w * dpr); c.height = Math.round(h * dpr); c.style.width = w + "px"; c.style.height = h + "px";
      c.style.flex = "none";
      row.appendChild(c);
      var L = G.layout(groups, { x: 0, y: 0, width: w, height: h }, { form: selected ? "poured" : "rows", scheme: o.scheme });
      var ctx = c.getContext("2d");
      if (ctx) { ctx.setTransform(dpr, 0, 0, dpr, 0, 0); G.draw(ctx, L); }
      var words = doc.createElement("div");
      words.style.cssText = "font-size:" + o.card.small + "px;line-height:1.35;color:#2b3038";
      var rd = G.readout(groups);
      rd.lines.forEach(function (line) { var d = doc.createElement("div"); d.textContent = line; words.appendChild(d); });
      // the counts in words under the graphic, at the card's full width
      card.appendChild(words); words.style.marginTop = "6px";
    }
    card.style.display = "block";
    var lv = this._view(); if (!lv) return;
    var s = this._screen(i, lv.view), cw = card.offsetWidth || o.card.width, ch = card.offsetHeight || 120;
    var x = s.x + 14, y = s.y - ch / 2, lab = null;
    this.labels.forEach(function (l) { if (l.point === i) lab = l; });
    // a comment written out: the card goes beside its label, not over it
    if (lab) { x = lab.box[2] + 8; y = lab.box[1]; if (x + cw > lv.W - 4) x = lab.box[0] - 8 - cw - o.rule - 3; }
    else if (x + cw > lv.W - 4) x = s.x - 14 - cw;
    x = Math.max(4, Math.min(x, lv.W - cw - 4)); y = Math.max(4, Math.min(y, lv.H - ch - 4));
    card.style.transform = "translate(" + Math.round(x) + "px," + Math.round(y) + "px)";
  };

  P._clearOverlay = function () {
    var c = this.overlay, ctx = c.getContext && c.getContext("2d");
    if (ctx) { ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.clearRect(0, 0, c.width, c.height); }
  };

  // After each placement: the four rows in each label's box, the rule at its
  // left, and a ring on the hovered or selected dot.
  P._paint = function () {
    var lv = this._view(), c = this.overlay, o = this.options;
    if (!lv) return;
    var dpr = root.devicePixelRatio || 1, W = lv.W, H = lv.H;
    if (c.width !== Math.round(W * dpr) || c.height !== Math.round(H * dpr)) {
      c.width = Math.round(W * dpr); c.height = Math.round(H * dpr); c.style.width = W + "px"; c.style.height = H + "px";
    }
    var ctx = c.getContext && c.getContext("2d");
    if (!ctx) return;
    ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.clearRect(0, 0, c.width, c.height);
    if (this.moving) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    var self = this, L = o.lead;
    // the leads first, quieter than everything drawn over them
    if (this.leads.length && L) {
      ctx.font = L.weight + " " + L.font + "px " + this._family(); ctx.textBaseline = "top"; ctx.lineJoin = "round";
      this.leads.forEach(function (l) {
        ctx.lineWidth = 3; ctx.strokeStyle = L.halo; ctx.strokeText(l.text, l.x, l.y + 1);
        ctx.fillStyle = L.ink; ctx.fillText(l.text, l.x, l.y + 1);
      });
    }
    this.labels.forEach(function (lab) {
      var r = self.rank[String(lab.id)];
      // at the surface a label stands beside its dot: a leader from the dot
      // to the label's edge, and the dot ringed in its kind's colour
      if (lab.leader) {
        var l = lab.leader;
        ctx.beginPath(); ctx.moveTo(l[0], l[1]); ctx.lineTo(l[2], l[3]);
        ctx.lineWidth = 1; ctx.strokeStyle = o.leader; ctx.stroke();
        ctx.beginPath(); ctx.arc(l[0], l[1], 3.5, 0, Math.PI * 2);
        ctx.lineWidth = 1.5; ctx.strokeStyle = r ? o.colors[r.kind] : o.leader; ctx.stroke();
      }
      if (r) {
        ctx.fillStyle = o.colors[r.kind];
        ctx.fillRect(Math.round(lab.x - lab.w / 2) - o.rule - 3, Math.round(lab.y - lab.h / 2), o.rule, Math.round(lab.h));
      }
      var groups = lab.slot && self._groups(lab.id);
      if (groups) {
        var s = lab.slot, L = G.layout(groups, { x: Math.round(s.x), y: Math.round(s.y), width: s.w, height: s.h }, { form: "rows", scheme: o.scheme });
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        G.draw(ctx, L);
      }
    });
    [this.hovered, this.selected].forEach(function (i, k) {
      if (i === null) return;
      var s = self._screen(i, lv.view);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.beginPath(); ctx.arc(s.x, s.y, k ? 7 : 6, 0, Math.PI * 2);
      ctx.lineWidth = k ? 2 : 1.5; ctx.strokeStyle = "#2b3038"; ctx.globalAlpha = k ? 1 : 0.7; ctx.stroke(); ctx.globalAlpha = 1;
    });
  };

  P.destroy = function () {
    var el = this.el, h = this._h;
    el.removeEventListener("densecomments", h.comments);
    el.removeEventListener("pointerdown", h.down);
    el.removeEventListener("pointerup", h.up);
    el.removeEventListener("wheel", h.wheel);
    el.removeEventListener("pointermove", h.move);
    el.removeEventListener("pointerleave", h.leave);
    el.removeEventListener("click", h.click);
    el.removeEventListener("keydown", h.key);
    el.removeEventListener("blur", h.blur);
    if (this.map.tooltip) this.map.tooltip.style.visibility = "";
    this.overlay.remove(); this.card.remove();
  };

  PolisTopicMapDeepZoom.DEFAULTS = DEFAULTS;
  PolisTopicMapDeepZoom.standoutRanking = standoutRanking;
  PolisTopicMapDeepZoom.drawingSettings = drawingSettings;
  PolisTopicMapDeepZoom.balancedOrder = balancedOrder;
  PolisTopicMapDeepZoom.numbersFor = numbersFor;
  PolisTopicMapDeepZoom.hasCounts = hasCounts;
  PolisTopicMapDeepZoom.pointIndex = pointIndex;
  PolisTopicMapDeepZoom.nearestPoint = nearestPoint;
  PolisTopicMapDeepZoom.leadText = leadText;
  PolisTopicMapDeepZoom.placeLeads = placeLeads;

  root.PolisTopicMapDeepZoom = PolisTopicMapDeepZoom;
  if (typeof module !== "undefined" && module.exports) module.exports = PolisTopicMapDeepZoom;
})(typeof window !== "undefined" ? window : globalThis);
