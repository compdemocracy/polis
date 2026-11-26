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
 *   - reveals any other comment in view on hover or keyboard focus: a card
 *     with its text, its four-row graphic and the counts in words
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
    font: 12,               // a standout's text, px
    words: 60,              // words of a standout's text at most
    wrap: 34,               // characters per line
    maxLines: 4,            // lines at most, the last cut with "…"
    slot: { w: 34, h: 15, gap: 6 },     // the reserved box: the four rows at 34 by 15 (3 px rows)
    rule: 3,                // px: the coloured rule at a standout's left
    card: { width: 280, rowsW: 84, rowsH: 19, pouredW: 168, pouredH: 84 },
    hitRadius: 6,           // px: the least distance at which a dot answers the pointer
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
  function drawingSettings(ranking, options, withSlot) {
    var o = merge(options);
    return { zoom: {
      comments: { only: ranking.map(function (r) { return r.id; }), font: o.font, words: o.words, wordsPerDoubling: 0,
        wrap: o.wrap, wrapPerDoubling: 0, maxLines: o.maxLines, align: "left" },
      slot: withSlot ? { w: o.slot.w, h: o.slot.h, gap: o.slot.gap } : null,
      budget: { comments: o.budget }
    } };
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
    this.labels = []; this.on = false; this.moving = false;
    this.hovered = null; this.selected = null; this.focusIndex = -1;

    var doc = document, el = this.el;
    var ov = this.overlay = doc.createElement("canvas");
    ov.style.cssText = "position:absolute;left:0;top:0;pointer-events:none;z-index:1";
    el.appendChild(ov);
    var card = this.card = doc.createElement("div");
    card.style.cssText = "position:absolute;left:0;top:0;display:none;pointer-events:none;z-index:2;box-sizing:border-box;" +
      "background:#ffffff;color:#2b3038;border:1px solid #d5d9df;border-radius:4px;box-shadow:0 2px 8px rgba(16,24,40,0.14);" +
      "padding:8px 10px;font:13px/1.35 " + (map.theme && map.theme.font ? map.theme.font.family : "sans-serif") + ";width:" + o.card.width + "px";
    el.appendChild(card);
    if (!el.hasAttribute("tabindex")) el.setAttribute("tabindex", "0");

    // the page's own dense settings (options.drawing), with the standouts' labels over them
    var given = options && options.drawing && typeof options.drawing === "object" ? options.drawing : {};
    var ds = drawingSettings(this.ranking, o, !!this.math);
    map.setDrawing(Object.assign({}, given, { zoom: Object.assign({}, given.zoom || {}, ds.zoom) }));

    var down = null;
    this._h = {
      comments: function (e) { self.labels = e.detail.comments || []; self.on = !!e.detail.on; self.moving = false; self._paint(); },
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
    if (lay) { this.labels = lay.comments || []; this.on = !!(lay.commentLevel && lay.commentLevel.on); this._paint(); }
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

  // The comments in view (with an id), left to right: [{ i, x, y }].
  P._dotsInView = function () {
    var lv = this._view(), out = [];
    if (!lv || !this.on) return out;
    var ids = this.doc.points.id;
    for (var i = 0; i < ids.length; i++) {
      if (ids[i] == null) continue;
      var s = this._screen(i, lv.view);
      if (s.x >= 0 && s.y >= 0 && s.x <= lv.W && s.y <= lv.H) out.push({ i: i, x: s.x, y: s.y });
    }
    return out.sort(function (a, b) { return a.x - b.x || a.y - b.y; });
  };

  // The point under (px, py): a standout's label first, then the nearest dot
  // within hitRadius; null when nothing is, or when the view is not close
  // enough for comments (the map's own tooltip answers there).
  P._hit = function (px, py) {
    if (!this.on || this.moving) return null;
    for (var j = 0; j < this.labels.length; j++) {
      var b = this.labels[j].box;
      if (px >= b[0] && px <= b[2] && py >= b[1] && py <= b[3]) return this.labels[j].point;
    }
    var dots = this._dotsInView(), best = null, bd = this.options.hitRadius;
    dots.forEach(function (d) { var dd = Math.hypot(d.x - px, d.y - py); if (dd <= bd) { bd = dd; best = d.i; } });
    return best;
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
    if (i === this.selected) return;
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
    var o = this.options, doc = document, card = this.card, id = this.doc.points.id[i];
    var text = this.doc.points.text && this.doc.points.text[i];
    var groups = this._groups(id), r = this.rank[String(id)];
    card.textContent = "";
    var add = function (tag, css, t) { var n = doc.createElement(tag); if (css) n.style.cssText = css; if (t != null) n.textContent = t; card.appendChild(n); return n; };
    if (r) {
      var k = add("div", "font-size:11px;color:#59606b;margin-bottom:4px");
      var sw = doc.createElement("span");
      sw.style.cssText = "display:inline-block;width:8px;height:8px;margin-right:5px;vertical-align:0;background:" + o.colors[r.kind];
      k.appendChild(sw);
      k.appendChild(doc.createTextNode(r.kind === "consensus" ? "Stands out for group-informed consensus" : "Stands out for division"));
    }
    if (typeof text === "string" && text.trim()) add("div", "margin-bottom:6px", text);
    var tn = this._topicName(i);
    if (tn) add("div", "font-size:11px;color:#59606b;margin-bottom:6px", "In " + tn);
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
      words.style.cssText = "font-size:11px;line-height:1.35;color:#2b3038";
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
    var self = this;
    this.labels.forEach(function (lab) {
      var r = self.rank[String(lab.id)];
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
  PolisTopicMapDeepZoom.numbersFor = numbersFor;
  PolisTopicMapDeepZoom.hasCounts = hasCounts;

  root.PolisTopicMapDeepZoom = PolisTopicMapDeepZoom;
  if (typeof module !== "undefined" && module.exports) module.exports = PolisTopicMapDeepZoom;
})(typeof window !== "undefined" ? window : globalThis);
