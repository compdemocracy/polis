/*
 * PolisTopicMap: the first-party topic map. A component: data and a theme in,
 * events out. No library; it draws on one canvas.
 *
 *   var map = new PolisTopicMap(element, { data: data, theme: theme, level: 0 });
 *   element.addEventListener("topicselect", function (e) { e.detail.topic });
 *   map.select("1_4");  map.setLevel(2);  map.hover(null);
 *
 * Events, dispatched on the element and bubbling, each with a detail object:
 *   topichover   { topic, previous, origin }   topic is a topic id or null
 *   topicselect  { topic, previous, origin }   null means the selection was cleared
 *   levelchange  { level, previous, origin }   a level number, or "all"
 * origin is "map" when a person did it on the map and "api" when the host
 * called a method, so a host that mirrors state both ways can ignore its own echo.
 *
 * The data is the document polis-topic-map writes (schema polis-topic-map/1).
 * What is computed here and not there is everything that depends on the size
 * of the element, the zoom or the theme: the projection to pixels, the size
 * and wrapping of a label, and which labels give way to which.
 *
 * The placement rules are those of datamapplot 0.6.4 as Delphi calls it; each
 * one names its source there.
 */
(function (root) {
  "use strict";

  /* ---------------------------------------------------------------- geometry */

  /* deck.gl draws datamapplot's maps as a web map: x is longitude, y is
     latitude, projected with Web Mercator onto a world 512 units wide at zoom 0
     (datamap.js:73-81 gives it a longitude, a latitude and a zoom). */
  var WORLD = 512;

  function lngToWorld(x) {
    return ((x + 180) / 360) * WORLD;
  }

  function latToWorld(y) {
    var phi = (y * Math.PI) / 180;
    return ((Math.PI + Math.log(Math.tan(Math.PI / 4 + phi / 2))) * WORLD) / (2 * Math.PI);
  }

  /* The same scale as longitude, with no stretch away from the equator. */
  function latToWorldLinear(y) {
    return ((y + 180) / 360) * WORLD;
  }

  /* calculateZoomLevel (datamap.js:39-55): the zoom and centre of the first
     view for bounds [xmin, xmax, ymin, ymax] in an element w by h pixels. */
  function initialView(bounds, w, h) {
    var lngRange = bounds[1] - bounds[0];
    var latRange = bounds[3] - bounds[2];
    var zoomX = Math.log2(360 / (lngRange / (w / 256)));
    var zoomY = Math.log2(180 / (latRange / (h / 256)));
    return {
      zoom: Math.min(zoomX, zoomY) - 0.5,
      lng: (bounds[0] + bounds[1]) / 2,
      lat: (bounds[2] + bounds[3]) / 2
    };
  }

  /* deck.gl's wheel step with datamapplot's speed 0.01 (datamap.js:80): the
     factor one wheel event multiplies the scale by. delta is minus the wheel's
     deltaY, in pixels. */
  function wheelScale(delta, speed) {
    var scale = 2 / (1 + Math.exp(-Math.abs(delta * speed)));
    return delta < 0 && scale !== 0 ? 1 / scale : scale;
  }

  /* The wheel delta as deck.gl's input layer reports it. */
  function wheelDelta(event) {
    var value = event.deltaY;
    if (event.deltaMode === 1) value *= 40;
    if (value !== 0 && value % 4.000244140625 === 0) value = Math.floor(value / 4.000244140625);
    if (event.shiftKey && value) value *= 0.25;
    return -value;
  }

  function clamp(v, lo, hi) {
    return v < lo ? lo : v > hi ? hi : v;
  }

  /* ------------------------------------------------------------------ labels */

  /* Python's textwrap.fill(text, width, break_long_words=False), which is how
     datamapplot wraps a label (create_plots.py:642-644): lines of at most
     `width` characters, broken at spaces and after the hyphen of a hyphenated
     word; a word longer than the width stays whole on its own line. */
  var WS = "[\\t\\n\\x0b\\x0c\\r ]";
  var NWS = "[^\\t\\n\\x0b\\x0c\\r ]";
  var WORD = "[\\p{L}\\p{N}_]";
  var WP = "[\\p{L}\\p{N}_!\"'&.,?]";
  var LT = "[\\p{L}_]";
  var WORDSEP = new RegExp(
    "(" + WS + "+" +
    "|(?<=" + WP + ")-{2,}(?=" + WORD + ")" +
    "|" + NWS + "+?(?:" +
      "-(?:(?<=" + LT + "{2}-)|(?<=" + LT + "-" + WP + "-))(?=" + LT + "-?" + LT + ")" +
      "|(?=" + WS + "|$)" +
      "|(?<=" + WP + ")(?=-{2,}" + WORD + ")" +
    "))", "u");

  function wrapLabel(text, width) {
    var chunks = String(text).replace(/[\t\n\x0b\x0c\r]/g, " ").split(WORDSEP).filter(Boolean);
    var lines = [];
    var i = 0;
    while (i < chunks.length) {
      var line = [];
      var len = 0;
      if (chunks[i].trim() === "" && lines.length) i++;
      while (i < chunks.length && len + chunks[i].length <= width) {
        line.push(chunks[i]);
        len += chunks[i].length;
        i++;
      }
      if (i < chunks.length && chunks[i].length > width && line.length === 0) {
        line.push(chunks[i]);
        i++;
      }
      if (line.length && line[line.length - 1].trim() === "") line.pop();
      if (line.length) lines.push(line.join(""));
    }
    return lines;
  }

  /* The type size of each label of one map: its weight (the fourth root of its
     comment count) spread linearly between the smallest and largest size
     (interactive_rendering.py:1595-1602). */
  function labelSizes(weights, minPx, maxPx) {
    var lo = Infinity, hi = -Infinity, i;
    for (i = 0; i < weights.length; i++) {
      if (weights[i] < lo) lo = weights[i];
      if (weights[i] > hi) hi = weights[i];
    }
    var range = hi - lo;
    return weights.map(function (w) {
      return range > 0 ? (w - lo) * ((maxPx - minPx) / range) + minPx : (maxPx + minPx) / 2;
    });
  }

  /* Which labels are drawn, and how strongly: the rule datamapplot's source
     asks deck.gl's CollisionFilterExtension for (datamap.js:230-238,
     getCollisionPriority: d => d.size), done with rectangles.

     Every label claims a rectangle: its text block drawn `scale` times larger
     (the enlarged type size held between minPx and maxPx) plus the plate's
     padding. Where claims overlap, the heavier label owns the ground; a label
     that is itself hidden still owns its claim. A label is drawn only if the
     ground at its own anchor is its own. deck.gl tests 25 spots around the
     anchor, one pixel apart, and fades the label by the share it owns, raised
     to 2.2; so does this.

     This is not quite what deck.gl 9.4 draws from that request today; see
     _collideAsDrawn for that.

     items: [{ x, y, w, h, size, tier, weight, order }]  x, y the anchor in
     pixels, w and h the text block at its real size. tier puts the selected
     and the hovered topic above every weight. Returns one opacity per item. */
  function resolveCollisions(items, opt) {
    var n = items.length;
    var claims = new Array(n);
    var i, j, s;
    for (i = 0; i < n; i++) {
      var it = items[i];
      var k = clamp(it.size * opt.scale, opt.minPx, opt.maxPx) / it.size;
      claims[i] = { hw: (it.w * k) / 2 + opt.padPx, hh: (it.h * k) / 2 + opt.padPx, x: it.x, y: it.y, i: i };
    }
    var ranked = claims.slice().sort(function (a, b) {
      var A = items[a.i], B = items[b.i];
      return (B.tier - A.tier) || (B.weight - A.weight) || (B.order - A.order);
    });
    var out = new Array(n);
    var step = opt.sampleStepPx == null ? 1 : opt.sampleStepPx;
    for (i = 0; i < n; i++) {
      var own = 0;
      for (s = 0; s < 25; s++) {
        var px = items[i].x + ((s % 5) - 2) * step;
        var py = items[i].y + (Math.floor(s / 5) - 2) * step;
        for (j = 0; j < n; j++) {
          var c = ranked[j];
          if (Math.abs(px - c.x) <= c.hw && Math.abs(py - c.y) <= c.hh) {
            if (c.i === i) own++;
            break;
          }
        }
      }
      out[i] = Math.pow(own / 25, 2.2);
    }
    return out;
  }

  /* --------------------------------------------------------------- component */

  function PolisTopicMap(host, options) {
    options = options || {};
    this.host = host;
    this.theme = options.theme;
    this.projection = options.projection === "linear" ? "linear" : "web-mercator";
    this.collision = options.collision === "by-weight" ? "by-weight" : "as-drawn";
    this.level = options.level == null ? 0 : options.level;
    this.selected = null;
    this.hovered = null;
    this._hoverPoint = -1;
    this._view = null;
    this._anim = null;
    this._frame = 0;
    this._pointers = new Map();
    this._labelHits = [];
    this._measure = null;

    if (getComputedStyle(host).position === "static") host.style.position = "relative";
    this.canvas = document.createElement("canvas");
    this.canvas.style.cssText = "position:absolute;inset:0;width:100%;height:100%;display:block;touch-action:none;cursor:grab";
    this.canvas.setAttribute("role", "img");
    this.tooltip = document.createElement("div");
    this.tooltip.style.cssText = "position:absolute;top:0;left:0;display:none;pointer-events:none;z-index:1;box-sizing:border-box";
    host.appendChild(this.canvas);
    host.appendChild(this.tooltip);
    this.ctx = this.canvas.getContext("2d");

    var self = this;
    this._on = {
      pointerdown: function (e) { self._pointerDown(e); },
      pointermove: function (e) { self._pointerMove(e); },
      pointerup: function (e) { self._pointerUp(e); },
      pointercancel: function (e) { self._pointerUp(e); },
      pointerleave: function () { self._setHoverFromMap(-1, null); },
      wheel: function (e) { self._wheel(e); },
      dblclick: function (e) { self._doubleClick(e); }
    };
    Object.keys(this._on).forEach(function (name) {
      self.canvas.addEventListener(name, self._on[name], name === "wheel" ? { passive: false } : undefined);
    });
    this._resizeObserver = new ResizeObserver(function () { self._resize(); });
    this._resizeObserver.observe(host);
    /* Labels are measured in the theme's typeface, so they are measured again
       whenever a face finishes loading. */
    this._fontsLoaded = function () { self._remeasure = true; self.redraw(); };
    if (document.fonts) {
      document.fonts.addEventListener("loadingdone", this._fontsLoaded);
      document.fonts.load(this.theme.label.weight + " 16px " + this.theme.font.family).then(this._fontsLoaded, function () {});
    }

    if (options.data) this.setData(options.data);
    if (options.selected) this.select(options.selected, "api");
  }

  PolisTopicMap.prototype.setData = function (data) {
    if (!data || data.schema !== "polis-topic-map/1") throw new Error("PolisTopicMap: expected a polis-topic-map/1 document");
    this.data = data;
    var p = data.points;
    var n = p.id.length;
    var toWorldY = this.projection === "linear" ? latToWorldLinear : latToWorld;
    var i, L;
    this._wx = new Float64Array(n);
    this._wy = new Float64Array(n);
    for (i = 0; i < n; i++) {
      this._wx[i] = lngToWorld(p.x[i]);
      this._wy[i] = toWorldY(p.y[i]);
    }
    this._topicById = {};
    this._twx = new Float64Array(data.topics.length);
    this._twy = new Float64Array(data.topics.length);
    for (i = 0; i < data.topics.length; i++) {
      this._topicById[data.topics[i].id] = i;
      this._twx[i] = lngToWorld(data.topics[i].x);
      this._twy[i] = toWorldY(data.topics[i].y);
    }
    /* For each point, its topic at the finest level that puts it in one: the
       colour it takes when every level is drawn together (create_plots.py:667-679). */
    this._finest = new Int32Array(n).fill(-1);
    for (i = 0; i < n; i++) {
      for (L = 0; L < p.topic.length; L++) {
        if (p.topic[L][i] >= 0) { this._finest[i] = p.topic[L][i]; break; }
      }
    }
    /* Draw order: the comments in no topic first, so they lie beneath
       (700_datamapplot_for_layer.py:699-705). */
    this._order = {};
    var rows = p.topic.map(function (row, level) { return { key: String(level), row: row }; });
    rows.push({ key: "all", row: this._finest });
    rows.forEach(function (r) {
      var under = [], over = [];
      for (var q = 0; q < n; q++) (r.row[q] < 0 ? under : over).push(q);
      this._order[r.key] = Int32Array.from(under.concat(over));
    }, this);
    /* Label order: by name, as numpy.unique leaves datamapplot's labels
       (interactive_rendering.py:954-956); with every level, level by level. */
    this._labelSets = {};
    var byName = function (a, b) { return data.topics[a].name < data.topics[b].name ? -1 : data.topics[a].name > data.topics[b].name ? 1 : 0; };
    var all = [];
    for (L = 0; L < data.levels.length; L++) {
      var set = [];
      for (i = 0; i < data.topics.length; i++) if (data.topics[i].level === L) set.push(i);
      set.sort(byName);
      this._labelSets[String(L)] = set;
      all = all.concat(set);
    }
    this._labelSets.all = all;
    if (this.level !== "all" && !(this.level >= 0 && this.level < data.levels.length)) this.level = 0;
    this.selected = null;
    this.hovered = null;
    this._view = null;
    this._measure = null;
    this.canvas.setAttribute("aria-label", "Topic map of " + data.title + ": " + n + " comments in " + data.topics.length + " topics");
    this._resize();
  };

  PolisTopicMap.prototype.setTheme = function (theme) {
    this.theme = theme;
    this._measure = null;
    this.redraw();
  };

  /* "as-drawn": the labels deck.gl 9.4 shows for datamapplot's request today.
     "by-weight": the labels datamapplot's source asks for. */
  PolisTopicMap.prototype.setCollision = function (mode) {
    this.collision = mode === "by-weight" ? "by-weight" : "as-drawn";
    this.redraw();
  };

  PolisTopicMap.prototype.setLevel = function (level, origin) {
    if (level !== "all") level = Number(level);
    if (level === this.level) return;
    if (level !== "all" && !(level >= 0 && level < this.data.levels.length)) throw new Error("PolisTopicMap: no level " + level);
    var previous = this.level;
    this.level = level;
    this._measure = null;
    this.redraw();
    this._emit("levelchange", { level: level, previous: previous, origin: origin || "api" });
  };

  PolisTopicMap.prototype.select = function (id, origin) {
    id = id == null ? null : String(id);
    if (id !== null && !(id in this._topicById)) throw new Error("PolisTopicMap: no topic " + id);
    if (id === this.selected) return;
    var previous = this.selected;
    this.selected = id;
    this.redraw();
    this._emit("topicselect", { topic: id, previous: previous, origin: origin || "api" });
  };

  PolisTopicMap.prototype.hover = function (id, origin) {
    id = id == null ? null : String(id);
    if (id !== null && !(id in this._topicById)) throw new Error("PolisTopicMap: no topic " + id);
    if (id === this.hovered) return;
    var previous = this.hovered;
    this.hovered = id;
    this.redraw();
    this._emit("topichover", { topic: id, previous: previous, origin: origin || "api" });
  };

  PolisTopicMap.prototype.destroy = function () {
    var self = this;
    Object.keys(this._on).forEach(function (name) { self.canvas.removeEventListener(name, self._on[name]); });
    this._resizeObserver.disconnect();
    if (document.fonts) document.fonts.removeEventListener("loadingdone", this._fontsLoaded);
    cancelAnimationFrame(this._frame);
    this._job = null;
    if (this._jobChannel) this._jobChannel.port1.close();
    this.canvas.remove();
    this.tooltip.remove();
  };

  PolisTopicMap.prototype._emit = function (name, detail) {
    this.host.dispatchEvent(new CustomEvent(name, { detail: detail, bubbles: true }));
  };

  /* ------------------------------------------------------------------- view */

  PolisTopicMap.prototype._resize = function () {
    var w = this.host.clientWidth, h = this.host.clientHeight;
    if (!w || !h) return;
    var dpr = root.devicePixelRatio || 1;
    this._w = w;
    this._h = h;
    this._dpr = dpr;
    this.canvas.width = Math.round(w * dpr);
    this.canvas.height = Math.round(h * dpr);
    if (!this._view && this.data) {
      var v = initialView(this.data.bounds, w, h);
      var toWorldY = this.projection === "linear" ? latToWorldLinear : latToWorld;
      this._view = { zoom: v.zoom, cx: lngToWorld(v.lng), cy: toWorldY(v.lat) };
    }
    this._draw();
  };

  PolisTopicMap.prototype.redraw = function () {
    var self = this;
    if (this._frame) return;
    this._frame = requestAnimationFrame(function (now) {
      self._frame = 0;
      self._step(now);
      self._draw();
      if (self._anim) self.redraw();
    });
  };

  PolisTopicMap.prototype._worldAt = function (px, py) {
    var k = Math.pow(2, this._view.zoom);
    return [this._view.cx + (px - this._w / 2) / k, this._view.cy + (this._h / 2 - py) / k];
  };

  /* Sets the zoom while the world point `at` stays under pixel (px, py). */
  PolisTopicMap.prototype._zoomTo = function (zoom, px, py, at) {
    var k = Math.pow(2, zoom);
    this._view.zoom = zoom;
    this._view.cx = at[0] - (px - this._w / 2) / k;
    this._view.cy = at[1] - (this._h / 2 - py) / k;
  };

  PolisTopicMap.prototype._animateZoom = function (zoom, px, py, ms) {
    zoom = clamp(zoom, 0, 20);
    this._anim = { z0: this._view.zoom, z1: zoom, px: px, py: py, at: this._worldAt(px, py), t0: performance.now(), ms: ms };
    this.redraw();
  };

  PolisTopicMap.prototype._step = function (now) {
    var a = this._anim;
    if (!a) return;
    var t = a.ms > 0 ? clamp((now - a.t0) / a.ms, 0, 1) : 1;
    this._zoomTo(a.z0 + (a.z1 - a.z0) * t, a.px, a.py, a.at);
    if (t >= 1) this._anim = null;
  };

  PolisTopicMap.prototype._local = function (e) {
    var r = this.canvas.getBoundingClientRect();
    return [e.clientX - r.left, e.clientY - r.top];
  };

  PolisTopicMap.prototype._wheel = function (e) {
    if (!this._view) return;
    e.preventDefault();
    var p = this._local(e);
    this._step(performance.now());
    var scale = wheelScale(wheelDelta(e), 0.01);
    this._animateZoom(this._view.zoom + Math.log2(scale), p[0], p[1], this.theme.motion.wheelMs);
  };

  PolisTopicMap.prototype._doubleClick = function (e) {
    if (!this._view) return;
    var p = this._local(e);
    this._animateZoom(this._view.zoom + (e.shiftKey ? -1 : 1), p[0], p[1], this.theme.motion.doubleClickMs);
  };

  PolisTopicMap.prototype._pointerDown = function (e) {
    if (!this._view) return;
    this.canvas.setPointerCapture(e.pointerId);
    var p = this._local(e);
    this._pointers.set(e.pointerId, p);
    this._down = { x: p[0], y: p[1], moved: false };
    this._anim = null;
    this.canvas.style.cursor = "grabbing";
    if (this._pointers.size === 2) this._pinch = this._pinchState();
  };

  PolisTopicMap.prototype._pinchState = function () {
    var pts = Array.from(this._pointers.values());
    var mx = (pts[0][0] + pts[1][0]) / 2, my = (pts[0][1] + pts[1][1]) / 2;
    return { d: Math.hypot(pts[0][0] - pts[1][0], pts[0][1] - pts[1][1]) || 1, zoom: this._view.zoom, at: this._worldAt(mx, my) };
  };

  PolisTopicMap.prototype._pointerMove = function (e) {
    if (!this._view) return;
    var p = this._local(e);
    var prev = this._pointers.get(e.pointerId);
    if (!prev) {
      this._pick(p[0], p[1]);
      return;
    }
    this._pointers.set(e.pointerId, p);
    if (this._pointers.size === 2 && this._pinch) {
      var pts = Array.from(this._pointers.values());
      var d = Math.hypot(pts[0][0] - pts[1][0], pts[0][1] - pts[1][1]) || 1;
      this._zoomTo(clamp(this._pinch.zoom + Math.log2(d / this._pinch.d), 0, 20), (pts[0][0] + pts[1][0]) / 2, (pts[0][1] + pts[1][1]) / 2, this._pinch.at);
      this._down.moved = true;
    } else {
      var k = Math.pow(2, this._view.zoom);
      this._view.cx -= (p[0] - prev[0]) / k;
      this._view.cy += (p[1] - prev[1]) / k;
      if (Math.hypot(p[0] - this._down.x, p[1] - this._down.y) > 3) this._down.moved = true;
    }
    this._setHoverFromMap(-1, null, true);
    this.redraw();
  };

  PolisTopicMap.prototype._pointerUp = function (e) {
    if (!this._pointers.has(e.pointerId)) return;
    var p = this._local(e);
    this._pointers.delete(e.pointerId);
    this._pinch = null;
    this.canvas.style.cursor = "grab";
    if (this._pointers.size === 0 && this._down && !this._down.moved && e.type === "pointerup") {
      var hit = this._hit(p[0], p[1]);
      var id = hit.topic;
      this.select(id === this.selected ? null : id, "map");
    }
    if (this._pointers.size === 0) this._pick(p[0], p[1]);
  };

  /* ---------------------------------------------------------------- picking */

  PolisTopicMap.prototype._topicOfPoint = function (i) {
    var t = this.level === "all" ? this._finest[i] : this.data.points.topic[this.level][i];
    return t >= 0 ? this.data.topics[t].id : null;
  };

  /* What is under a pixel: a comment's disc first (the topmost one), then a
     label that is drawn. */
  PolisTopicMap.prototype._hit = function (px, py) {
    var order = this._order[String(this.level)];
    var k = Math.pow(2, this._view.zoom);
    var r = this._radius(k);
    var hw = this._w / 2, hh = this._h / 2, cx = this._view.cx, cy = this._view.cy;
    var sel = this._selection();
    for (var j = order.length - 1; j >= 0; j--) {
      var i = order[j];
      var dx = (this._wx[i] - cx) * k + hw - px;
      var dy = hh - (this._wy[i] - cy) * k - py;
      var rr = !sel ? r : sel.row[i] === sel.index ? clamp(this.data.pointRadius * k, sel.minPx, Math.max(sel.minPx, this.theme.point.radiusMaxPx)) : r * this.theme.point.dimRadius;
      if (dx * dx + dy * dy <= rr * rr) return { point: i, topic: this._topicOfPoint(i) };
    }
    for (j = this._labelHits.length - 1; j >= 0; j--) {
      var b = this._labelHits[j];
      if (Math.abs(px - b.x) <= b.hw && Math.abs(py - b.y) <= b.hh) return { point: -1, topic: b.id };
    }
    return { point: -1, topic: null };
  };

  PolisTopicMap.prototype._pick = function (px, py) {
    var hit = this._hit(px, py);
    this._setHoverFromMap(hit.point, hit.topic);
    this.canvas.style.cursor = hit.point >= 0 || hit.topic ? "pointer" : "grab";
    if (hit.point >= 0) this._showTooltip(hit.point, px, py);
  };

  PolisTopicMap.prototype._setHoverFromMap = function (point, topic, quiet) {
    var changed = point !== this._hoverPoint;
    this._hoverPoint = point;
    if (point < 0) this.tooltip.style.display = "none";
    if (!quiet && topic !== this.hovered) this.hover(topic, "map");
    else if (changed) this.redraw();
  };

  PolisTopicMap.prototype._showTooltip = function (i, px, py) {
    var t = this.theme.tooltip, el = this.tooltip;
    el.textContent = this.data.points.text[i];
    el.style.display = "block";
    el.style.font = t.weight + " " + t.sizePx + "px " + this.theme.font.family;
    el.style.color = t.ink;
    el.style.background = t.ground;
    el.style.padding = t.padPx + "px";
    el.style.borderRadius = t.radiusPx + "px";
    el.style.boxShadow = t.shadow;
    el.style.backdropFilter = "blur(" + t.blurPx + "px)";
    el.style.maxWidth = t.maxWidth;
    var x = Math.min(px, this._w - el.offsetWidth);
    var y = Math.min(py, this._h - el.offsetHeight);
    el.style.transform = "translate(" + Math.max(0, x) + "px," + Math.max(0, y) + "px)";
  };

  /* ---------------------------------------------------------------- drawing */

  PolisTopicMap.prototype._radius = function (k) {
    var p = this.theme.point;
    return clamp(this.data.pointRadius * k, p.radiusMinPx, p.radiusMaxPx);
  };

  /* The selected topic's comments, and the radius they are drawn at:
     datamapplot raises the smallest radius of selected points to
     2 * (min + 1 / (1 + sqrt(selected) / log2(all))) (datamap.js:389-399). */
  PolisTopicMap.prototype._selection = function () {
    if (this.selected === null) return null;
    var index = this._topicById[this.selected];
    var topic = this.data.topics[index];
    var adjust = 1 / (1 + Math.sqrt(topic.count) / Math.log2(this.data.points.id.length));
    return { index: index, row: this.data.points.topic[topic.level], minPx: this.theme.point.selectedMinRadiusScale * (this.theme.point.radiusMinPx + adjust) };
  };

  PolisTopicMap.prototype._token = function (token, topic, perLevel, joint) {
    if (typeof token === "function") return token(topic, this.level);
    if (token === "topic") return this.level === "all" ? topic[joint] : topic[perLevel];
    return token;
  };

  /* The labels of the current level, measured in the theme's type: lines,
     size, and the width and height of the text block. Measured once per level
     and theme; the selected and hovered topics are measured as they come. */
  PolisTopicMap.prototype._labels = function () {
    if (this._measure && this._remeasure) {
      /* A typeface finished loading. If the labels measure as they did, the
         measurements (and everything worked out from them) are kept. */
      var before = this._measure;
      this._measure = null;
      this._remeasure = false;
      var after = this._labels();
      var same = after.list.length === before.list.length && after.list.every(function (m, i) {
        var b = before.list[i];
        return m.t === b.t && m.w === b.w && m.h === b.h && m.size === b.size && m.lines.join("\n") === b.lines.join("\n");
      });
      if (same) this._measure = before;
      return this._measure;
    }
    this._remeasure = false;
    if (this._measure) return this._measure;
    var topics = this.data.topics, theme = this.theme.label, ctx = this.ctx;
    var set = this._labelSets[String(this.level)];
    var sizes = labelSizes(set.map(function (t) { return topics[t].weight; }), theme.sizeMinPx, theme.sizeMaxPx);
    var lo = Infinity, hi = -Infinity;
    set.forEach(function (t) { lo = Math.min(lo, topics[t].weight); hi = Math.max(hi, topics[t].weight); });
    var family = this.theme.font.family;
    var measure = function (t, size, order) {
      var lines = wrapLabel(topics[t].name, theme.wrapChars);
      ctx.font = theme.weight + " " + size + "px " + family;
      var w = 0;
      for (var i = 0; i < lines.length; i++) w = Math.max(w, ctx.measureText(lines[i]).width);
      return { t: t, lines: lines, size: size, w: w, h: lines.length * size * theme.lineHeight, order: order };
    };
    var byTopic = {};
    var list = set.map(function (t, i) { return (byTopic[t] = measure(t, sizes[i], i)); });
    this._measure = {
      list: list,
      get: function (t) {
        if (byTopic[t]) return byTopic[t];
        var w = topics[t].weight;
        var size = hi > lo ? clamp((w - lo) * ((theme.sizeMaxPx - theme.sizeMinPx) / (hi - lo)) + theme.sizeMinPx, theme.sizeMinPx, theme.sizeMaxPx) : (theme.sizeMaxPx + theme.sizeMinPx) / 2;
        return (byTopic[t] = measure(t, size, list.length + t));
      }
    };
    return this._measure;
  };

  /* Which labels deck.gl 9.4 draws for datamapplot's page today, found by
     experiment on that page (two labels at a time, sizes and order swapped):

       - the ground a label's letters cover, outline included, belongs to the
         heaviest label with letters there;
       - ground no letters cover belongs to the heaviest label whose text block
         (enlarged, without the plate's padding) covers it;
       - letters always beat blocks, so a light label's letters can take the
         anchor of a heavy label whose anchor falls between two of its lines.

     A label is drawn if the ground at its anchor is its own, tested and faded
     as in resolveCollisions. The ownership is painted, as deck.gl paints it,
     into a hidden canvas: every label in a colour of its own, from the top
     down, each painting only where nothing is painted yet.

     Painting it is the one slow thing the map does (about a millisecond a
     label: every letter is stroked wide and large), so it is done as seldom
     as the picture allows and never in the way of a frame:

       - nothing that decides it has changed: the last answer is used;
       - the map was only dragged a whole number of pixels: the picture of
         claims moves with the map, so the last answer is moved with it;
       - the zoom changed, or the hovered or selected topic did: the frame is
         drawn with the last answer, the new one is painted a few
         milliseconds at a time between frames, and the map is drawn again
         when it is ready;
       - the level, the theme or the typeface changed (and the first time):
         it is painted at once, as it always was.

     Only the 25 pixels around each anchor are ever read, so the painting is
     clipped to the box around all of them and a label that cannot reach that
     box is not painted. Neither changes a pixel that is read. */
  var SLICE_MS = 4;
  var claimColour = function (q) { return [(q * 53 + 17) % 256, (q * 101 + 71) % 256, (q * 197 + 113) % 256]; };

  /* Sets up one painting of the claims for these labels at these places. */
  PolisTopicMap.prototype._claimsBegin = function (pool, items) {
    var lt = this.theme.label, w = this._w, h = this._h, n = pool.length, i, j;
    if (!this._claims) {
      this._claims = document.createElement("canvas");
      this._claimsCtx = this._claims.getContext("2d", { willReadFrequently: true });
    }
    var ctx = this._claimsCtx;
    if (this._claims.width !== w || this._claims.height !== h) {
      this._claims.width = w;
      this._claims.height = h;
      this._claimsSaved = false;
    }
    if (this._claimsSaved) ctx.restore();
    ctx.save();
    this._claimsSaved = true;
    ctx.globalCompositeOperation = "source-over";
    ctx.clearRect(0, 0, w, h);
    /* The box around every anchor's 25 pixels that lie on the canvas. */
    var x0 = w, y0 = h, x1 = 0, y1 = 0;
    var ax = new Int32Array(n), ay = new Int32Array(n);
    for (i = 0; i < n; i++) {
      ax[i] = Math.round(items[i].x);
      ay[i] = Math.round(items[i].y);
      if (ax[i] + 2 < 0 || ay[i] + 2 < 0 || ax[i] - 2 >= w || ay[i] - 2 >= h) continue;
      x0 = Math.min(x0, Math.max(0, ax[i] - 2));
      y0 = Math.min(y0, Math.max(0, ay[i] - 2));
      x1 = Math.max(x1, Math.min(w, ax[i] + 3));
      y1 = Math.max(y1, Math.min(h, ay[i] + 3));
    }
    var job = { pool: pool, items: items, ax: ax, ay: ay, ops: [], at: 0, x0: x0, y0: y0, cw: Math.max(0, x1 - x0), ch: Math.max(0, y1 - y0), w: w, h: h };
    if (!job.cw || !job.ch) return job;
    ctx.beginPath();
    ctx.rect(x0, y0, job.cw, job.ch);
    ctx.clip();
    ctx.globalCompositeOperation = "destination-over";
    ctx.textAlign = "center";
    ctx.textBaseline = "alphabetic";
    ctx.lineJoin = "round";
    var rank = [];
    for (i = 0; i < n; i++) {
      /* A label reaches no further than its enlarged block and half its
         enlarged type size beyond it (outline, descenders, accents). */
      var big = clamp(pool[i].size * lt.collisionScale, lt.collisionMinPx, lt.collisionMaxPx);
      var k = big / pool[i].size;
      var rx = (pool[i].w * k) / 2 + big / 2, ry = (pool[i].h * k) / 2 + big / 2;
      if (items[i].x + rx < x0 || items[i].x - rx > x1 || items[i].y + ry < y0 || items[i].y - ry > y1) continue;
      rank.push(i);
    }
    rank.sort(function (a, b) {
      return (items[b].tier - items[a].tier) || (items[b].weight - items[a].weight) || (items[b].order - items[a].order);
    });
    /* The selected and the hovered topic own their whole block. */
    for (j = 0; j < rank.length && items[rank[j]].tier > 0; j++) job.ops.push(rank[j], 0, rank[j], 1);
    var rest = j;
    for (j = rest; j < rank.length; j++) job.ops.push(rank[j], 0);
    for (j = rest; j < rank.length; j++) job.ops.push(rank[j], 1);
    return job;
  };

  /* Paints on from where the painting stopped. With a time to stop at, the
     canvas is made to finish each label before the clock is read, and false
     is returned if there is more to do. */
  PolisTopicMap.prototype._claimsPaint = function (job, stopAt) {
    var lt = this.theme.label, family = this.theme.font.family, ctx = this._claimsCtx;
    var pool = job.pool, items = job.items, ops = job.ops;
    while (job.at < ops.length) {
      var q = ops[job.at], block = ops[job.at + 1];
      job.at += 2;
      var m = pool[q], it = items[q];
      var big = clamp(m.size * lt.collisionScale, lt.collisionMinPx, lt.collisionMaxPx);
      var c = claimColour(q);
      if (block) {
        var k = big / m.size;
        ctx.fillStyle = "rgb(" + c[0] + "," + c[1] + "," + c[2] + ")";
        ctx.fillRect(it.x - (m.w * k) / 2, it.y - (m.h * k) / 2, m.w * k, m.h * k);
        continue;
      }
      var rowH = big * lt.lineHeight;
      var top = it.y - (m.lines.length * rowH) / 2;
      ctx.fillStyle = ctx.strokeStyle = "rgb(" + c[0] + "," + c[1] + "," + c[2] + ")";
      ctx.font = lt.weight + " " + big + "px " + family;
      ctx.lineWidth = 2 * lt.haloEm * big;
      for (var r = 0; r < m.lines.length; r++) {
        var by = top + (r + 0.5) * rowH + lt.baselineEm * big;
        ctx.strokeText(m.lines[r], it.x, by);
        ctx.fillText(m.lines[r], it.x, by);
      }
      if (stopAt) {
        ctx.getImageData(job.x0, job.y0, 1, 1);
        if (performance.now() >= stopAt && job.at < ops.length) return false;
      }
    }
    return true;
  };

  /* Reads the finished painting: for each label, which of its 25 pixels are
     its own (one bit each), and the opacity that gives it. */
  PolisTopicMap.prototype._claimsRead = function (job) {
    var n = job.pool.length, byTopic = new Map();
    var px = job.cw && job.ch ? this._claimsCtx.getImageData(job.x0, job.y0, job.cw, job.ch).data : null;
    for (var i = 0; i < n; i++) {
      var c = claimColour(i), mask = 0, own = 0;
      for (var s = 0; px && s < 25; s++) {
        var sx = job.ax[i] + (s % 5) - 2, sy = job.ay[i] + Math.floor(s / 5) - 2;
        if (sx < 0 || sy < 0 || sx >= job.w || sy >= job.h) continue;
        var o = ((sy - job.y0) * job.cw + (sx - job.x0)) * 4;
        if (px[o + 3] === 255 && px[o] === c[0] && px[o + 1] === c[1] && px[o + 2] === c[2]) { mask |= 1 << s; own++; }
      }
      byTopic.set(job.pool[i].t, { mask: mask, ax: job.ax[i], ay: job.ay[i], alpha: Math.pow(own / 25, 2.2) });
    }
    return byTopic;
  };

  PolisTopicMap.prototype._claimsDone = function (job, state) {
    state.byTopic = this._claimsRead(job);
    state.exact = true;
    this._col = state;
  };

  /* The last answer, moved with a map that was dragged a whole number of
     pixels. True if that answers for every label; a label whose 25 pixels
     include one that was off the canvas before is not answered. */
  PolisTopicMap.prototype._claimsMoved = function (pool, items) {
    var c = this._col, v = this._view, w = this._w, h = this._h;
    var k = Math.pow(2, v.zoom);
    var fx = (c.cx - v.cx) * k, fy = (v.cy - c.cy) * k;
    var dx = Math.round(fx), dy = Math.round(fy);
    if (Math.abs(fx - dx) > 1e-6 || Math.abs(fy - dy) > 1e-6) return false;
    var all = true;
    for (var i = 0; i < pool.length; i++) {
      var e = c.byTopic.get(pool[i].t);
      var ax = Math.round(items[i].x), ay = Math.round(items[i].y);
      if (!e || ax - e.ax !== dx || ay - e.ay !== dy) { all = false; continue; }
      var now = 0, known = true;
      for (var s = 0; s < 25; s++) {
        var sx = ax + (s % 5) - 2, sy = ay + Math.floor(s / 5) - 2;
        if (sx < 0 || sy < 0 || sx >= w || sy >= h) continue;
        now |= 1 << s;
        if (sx - dx < 0 || sy - dy < 0 || sx - dx >= w || sy - dy >= h) known = false;
      }
      if (!known) { all = false; continue; }
      var mask = e.mask & now, own = 0;
      for (var b = mask; b; b &= b - 1) own++;
      e.mask = mask; e.ax = ax; e.ay = ay; e.alpha = Math.pow(own / 25, 2.2);
    }
    c.cx = v.cx;
    c.cy = v.cy;
    c.exact = all;
    return all;
  };

  PolisTopicMap.prototype._collideAsDrawn = function (pool, items) {
    var c = this._col, v = this._view, self = this;
    var state = { measure: this._measure, w: this._w, h: this._h, selected: this.selected, hovered: this.hovered, zoom: v.zoom, cx: v.cx, cy: v.cy, exact: false, byTopic: null };
    var sameLabels = c && c.measure === state.measure && c.w === state.w && c.h === state.h;
    var sameOrder = sameLabels && c.selected === state.selected && c.hovered === state.hovered;
    var answer = function () {
      return pool.map(function (m) { var e = self._col.byTopic.get(m.t); return e ? e.alpha : 0; });
    };
    if (sameOrder && c.exact && c.zoom === v.zoom) {
      if ((c.cx === v.cx && c.cy === v.cy) || this._claimsMoved(pool, items)) return answer();
    }
    if (!sameLabels || this._settling) {
      this._job = null;
      var now = this._claimsBegin(pool, items);
      this._claimsPaint(now, 0);
      this._claimsDone(now, state);
      return answer();
    }
    /* The last answer for now. Two things are known without painting: the
       selected and the hovered topic own their anchors, and a label whose 25
       pixels all lie inside the enlarged block of one of those two owns
       nothing, because that block is painted before everything else. */
    var lt = this.theme.label, on = [];
    pool.forEach(function (m, i) {
      if (items[i].tier === 0) return;
      var k = clamp(m.size * lt.collisionScale, lt.collisionMinPx, lt.collisionMaxPx) / m.size;
      on.push([Math.ceil(items[i].x - (m.w * k) / 2), Math.ceil(items[i].y - (m.h * k) / 2), Math.floor(items[i].x + (m.w * k) / 2), Math.floor(items[i].y + (m.h * k) / 2)]);
    });
    var last = pool.map(function (m, i) {
      if (items[i].tier > 0) return items[i].x >= 0 && items[i].y >= 0 && items[i].x < state.w && items[i].y < state.h ? 1 : 0;
      var ax = Math.round(items[i].x), ay = Math.round(items[i].y);
      for (var b = 0; b < on.length; b++) {
        if (ax - 2 >= on[b][0] && ay - 2 >= on[b][1] && ax + 3 <= on[b][2] && ay + 3 <= on[b][3]) return 0;
      }
      var e = c.byTopic.get(m.t);
      return e ? e.alpha : 0;
    });
    if (!this._job) {
      this._job = this._claimsBegin(pool.slice(), items);
      this._job.state = state;
      this._claimsNext();
    }
    return last;
  };

  /* Asks for the next slice as its own task, so that frames and the pointer
     get their turn between slices. */
  PolisTopicMap.prototype._claimsNext = function () {
    var self = this;
    if (!this._jobChannel) {
      this._jobChannel = new MessageChannel();
      this._jobChannel.port1.onmessage = function (e) { if (self._job && e.data === self._job.id) self._claimsSlice(); };
    }
    this._job.id = this._job.id || (this._jobCount = (this._jobCount || 0) + 1);
    this._jobChannel.port2.postMessage(this._job.id);
  };

  /* A few milliseconds of the painting that is under way. */
  PolisTopicMap.prototype._claimsSlice = function () {
    var job = this._job;
    if (!job) return;
    var t = performance.now();
    var finished = this._claimsPaint(job, t + SLICE_MS);
    if (finished) {
      this._job = null;
      this._claimsDone(job, job.state);
      this.redraw();
    } else {
      this._claimsNext();
    }
    if (this.onTiming) this.onTiming("claims", performance.now() - t);
  };

  /* Finishes at once whatever is being worked out and draws the result: the
     picture the map comes to rest on. */
  PolisTopicMap.prototype.settle = function () {
    this._settling = true;
    this._draw();
    this._settling = false;
  };

  PolisTopicMap.prototype._draw = function () {
    if (!this.data || !this._view || !this._w) return;
    var started = this.onTiming ? performance.now() : 0;
    var ctx = this.ctx, theme = this.theme, data = this.data, topics = data.topics;
    var w = this._w, h = this._h, hw = w / 2, hh = h / 2;
    var k = Math.pow(2, this._view.zoom), cx = this._view.cx, cy = this._view.cy;
    var i, j;

    ctx.setTransform(this._dpr, 0, 0, this._dpr, 0, 0);
    ctx.globalAlpha = 1;
    ctx.fillStyle = theme.ground;
    ctx.fillRect(0, 0, w, h);

    /* Comments. */
    var order = this._order[String(this.level)];
    var row = this.level === "all" ? this._finest : data.points.topic[this.level];
    var sel = this._selection();
    var r = this._radius(k);
    var pt = theme.point;
    var rSel = sel ? clamp(data.pointRadius * k, sel.minPx, Math.max(sel.minPx, pt.radiusMaxPx)) : r;
    var strokePx = clamp(pt.strokeWidth * k, pt.strokeMinPx, pt.strokeMaxPx);
    var fills = topics.map(function (t) { return this._token(pt.fill, t, "color", "colorAll"); }, this);
    var lastFill = null, lastAlpha = -1;
    ctx.strokeStyle = pt.stroke;
    ctx.lineWidth = strokePx;
    for (j = 0; j < order.length; j++) {
      i = order[j];
      var sx = (this._wx[i] - cx) * k + hw;
      var sy = hh - (this._wy[i] - cy) * k;
      if (sx < -r || sy < -r || sx > w + r || sy > h + r) continue;
      var inSel = !sel || sel.row[i] === sel.index;
      var fill = row[i] < 0 ? pt.unclustered : fills[row[i]];
      var alpha = inSel ? pt.opacity : pt.opacity * pt.dimOpacity;
      if (fill !== lastFill) { ctx.fillStyle = fill; lastFill = fill; }
      if (alpha !== lastAlpha) { ctx.globalAlpha = alpha; lastAlpha = alpha; }
      ctx.beginPath();
      ctx.arc(sx, sy, !sel ? r : inSel ? rSel : r * pt.dimRadius, 0, 6.283185307179586);
      ctx.fill();
      if (strokePx >= 0.25) ctx.stroke();
    }
    if (this._hoverPoint >= 0) {
      i = this._hoverPoint;
      ctx.globalAlpha = 1;
      ctx.fillStyle = pt.hover;
      ctx.beginPath();
      ctx.arc((this._wx[i] - cx) * k + hw, hh - (this._wy[i] - cy) * k, !sel ? r : sel.row[i] === sel.index ? rSel : r * pt.dimRadius, 0, 6.283185307179586);
      ctx.fill();
    }

    /* Labels: the level's own, and the selected and hovered topics whatever
       their level, which outrank every other label. */
    var lt = theme.label;
    var measured = this._labels();
    var pool = measured.list.slice();
    var selT = this.selected === null ? -1 : this._topicById[this.selected];
    var hovT = this.hovered === null ? -1 : this._topicById[this.hovered];
    [selT, hovT].forEach(function (t) {
      if (t >= 0 && pool.indexOf(measured.get(t)) < 0) pool.push(measured.get(t));
    });
    var items = pool.map(function (m) {
      return {
        x: (this._twx[m.t] - cx) * k + hw,
        y: hh - (this._twy[m.t] - cy) * k,
        w: m.w, h: m.h, size: m.size,
        tier: m.t === selT ? 2 : m.t === hovT ? 1 : 0,
        weight: topics[m.t].weight, order: m.order
      };
    }, this);
    var shown = this.collision === "as-drawn"
      ? this._collideAsDrawn(pool, items)
      : resolveCollisions(items, { scale: lt.collisionScale, minPx: lt.collisionMinPx, maxPx: lt.collisionMaxPx, padPx: lt.platePadPx });
    this._labelHits = [];
    ctx.fillStyle = lt.plate;
    for (i = 0; i < pool.length; i++) {
      if (shown[i] <= 0) continue;
      ctx.globalAlpha = shown[i];
      ctx.fillRect(items[i].x - pool[i].w / 2 - lt.platePadPx, items[i].y - pool[i].h / 2 - lt.platePadPx, pool[i].w + 2 * lt.platePadPx, pool[i].h + 2 * lt.platePadPx);
    }
    ctx.textAlign = "center";
    ctx.textBaseline = "alphabetic";
    ctx.lineJoin = "round";
    ctx.strokeStyle = lt.halo;
    for (i = 0; i < pool.length; i++) {
      if (shown[i] <= 0) continue;
      var m = pool[i];
      var lineH = m.size * lt.lineHeight;
      var top = items[i].y - m.h / 2;
      ctx.globalAlpha = shown[i];
      ctx.font = lt.weight + " " + m.size + "px " + theme.font.family;
      ctx.lineWidth = 2 * lt.haloEm * m.size;
      ctx.fillStyle = this._token(lt.ink, topics[m.t], "labelColor", "labelColorAll");
      for (j = 0; j < m.lines.length; j++) {
        var ly = top + (j + 0.5) * lineH + lt.baselineEm * m.size;
        if (lt.haloEm > 0) ctx.strokeText(m.lines[j], items[i].x, ly);
        ctx.fillText(m.lines[j], items[i].x, ly);
      }
      if (shown[i] > 0.5) this._labelHits.push({ id: topics[m.t].id, x: items[i].x, y: items[i].y, hw: m.w / 2, hh: m.h / 2 });
    }
    ctx.globalAlpha = 1;
    if (this.onTiming) this.onTiming("draw", performance.now() - started);
  };

  PolisTopicMap.geometry = {
    lngToWorld: lngToWorld, latToWorld: latToWorld, latToWorldLinear: latToWorldLinear,
    initialView: initialView, wheelScale: wheelScale, wrapLabel: wrapLabel,
    labelSizes: labelSizes, resolveCollisions: resolveCollisions
  };

  root.PolisTopicMap = PolisTopicMap;
  if (typeof module !== "undefined" && module.exports) module.exports = PolisTopicMap;
})(typeof globalThis !== "undefined" ? globalThis : this);
