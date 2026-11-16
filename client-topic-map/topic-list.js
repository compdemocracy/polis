/*
 * PolisTopicList: the same topics as the map, as a tree. A component with the
 * map's data and theme in, and the map's events out.
 *
 *   var list = new PolisTopicList(element, { data: data, theme: theme, level: 0 });
 *   element.addEventListener("topicselect", function (e) { e.detail.topic });
 *   list.select("1_4");  list.setLevel(2);  list.hover(null);
 *
 * Events are the map's: topichover and topicselect, with origin "list" when a
 * person did it here and "api" when the host called a method.
 *
 * The tree is the data's: each topic sits under the topic one level coarser
 * that holds the most of its comments. A topic with no such parent stands at
 * the root. Coarsest first; inside a parent, in cluster order.
 */
(function (root) {
  "use strict";

  function PolisTopicList(host, options) {
    options = options || {};
    this.host = host;
    this.theme = options.theme;
    this.level = options.level == null ? 0 : options.level;
    this.selected = null;
    this.hovered = null;
    this._rows = {};
    var self = this;
    this._on = {
      click: function (e) {
        var row = e.target.closest("[data-topic]");
        if (row) self.select(row.dataset.topic === self.selected ? null : row.dataset.topic, "list");
      },
      pointerover: function (e) {
        var row = e.target.closest("[data-topic]");
        self.hover(row ? row.dataset.topic : null, "list");
      },
      pointerleave: function () { self.hover(null, "list"); },
      focusin: function (e) {
        var row = e.target.closest("[data-topic]");
        if (row) self.hover(row.dataset.topic, "list");
      },
      focusout: function () { self.hover(null, "list"); }
    };
    Object.keys(this._on).forEach(function (name) { host.addEventListener(name, self._on[name]); });
    if (options.data) this.setData(options.data);
    if (options.selected) this.select(options.selected, "api");
  }

  PolisTopicList.prototype.setData = function (data) {
    if (!data || data.schema !== "polis-topic-map/1") throw new Error("PolisTopicList: expected a polis-topic-map/1 document");
    this.data = data;
    this.selected = null;
    this.hovered = null;
    this._render();
  };

  PolisTopicList.prototype.setTheme = function (theme) {
    this.theme = theme;
    this._render();
  };

  PolisTopicList.prototype.setLevel = function (level) {
    if (level !== "all") level = Number(level);
    if (level === this.level) return;
    this.level = level;
    this._paint();
  };

  PolisTopicList.prototype.select = function (id, origin) {
    id = id == null ? null : String(id);
    if (id !== null && !this._rows[id]) throw new Error("PolisTopicList: no topic " + id);
    if (id === this.selected) return;
    var previous = this.selected;
    this.selected = id;
    this._paint([previous, id]);
    if (id !== null && origin !== "list") this._rows[id].scrollIntoView({ block: "nearest" });
    this._emit("topicselect", { topic: id, previous: previous, origin: origin || "api" });
  };

  PolisTopicList.prototype.hover = function (id, origin) {
    id = id == null ? null : String(id);
    if (id !== null && !this._rows[id]) throw new Error("PolisTopicList: no topic " + id);
    if (id === this.hovered) return;
    var previous = this.hovered;
    this.hovered = id;
    this._paint([previous, id]);
    this._emit("topichover", { topic: id, previous: previous, origin: origin || "api" });
  };

  PolisTopicList.prototype.destroy = function () {
    var self = this;
    Object.keys(this._on).forEach(function (name) { self.host.removeEventListener(name, self._on[name]); });
    this.host.textContent = "";
  };

  PolisTopicList.prototype._emit = function (name, detail) {
    this.host.dispatchEvent(new CustomEvent(name, { detail: detail, bubbles: true }));
  };

  PolisTopicList.prototype._render = function () {
    var data = this.data, t = this.theme, self = this;
    var children = {};
    var roots = [];
    data.topics.forEach(function (topic) {
      if (topic.parent) (children[topic.parent] = children[topic.parent] || []).push(topic);
      else roots.push(topic);
    });
    roots.sort(function (a, b) { return b.level - a.level || a.cluster - b.cluster; });
    this._rows = {};
    var build = function (topics, depth) {
      var ul = document.createElement("ul");
      ul.setAttribute("role", depth ? "group" : "tree");
      ul.style.cssText = "list-style:none;margin:0;padding:0";
      topics.forEach(function (topic) {
        var li = document.createElement("li");
        li.setAttribute("role", "none");
        var row = document.createElement("button");
        row.type = "button";
        row.dataset.topic = topic.id;
        row.setAttribute("role", "treeitem");
        row.setAttribute("aria-level", String(depth + 1));
        row.style.cssText =
          "display:flex;align-items:baseline;width:100%;box-sizing:border-box;border:0;margin:0;text-align:left;cursor:pointer;" +
          "font:" + t.font.uiWeight + " " + t.font.uiSizePx + "px " + t.font.family + ";" +
          "padding:" + t.list.rowPadPx + "px " + t.list.gapPx + "px " + t.list.rowPadPx + "px " + (t.list.gapPx + depth * t.list.indentPx) + "px;" +
          "gap:" + t.list.gapPx + "px";
        var swatch = document.createElement("span");
        swatch.style.cssText = "flex:none;width:" + t.list.swatchPx + "px;height:" + t.list.swatchPx + "px;border-radius:50%";
        var name = document.createElement("span");
        name.textContent = topic.name;
        name.style.cssText = "flex:1;min-width:0";
        var count = document.createElement("span");
        count.textContent = String(topic.count);
        count.style.cssText = "flex:none;font-size:" + t.font.smallSizePx + "px;font-variant-numeric:tabular-nums";
        row.appendChild(swatch);
        row.appendChild(name);
        row.appendChild(count);
        li.appendChild(row);
        self._rows[topic.id] = row;
        var kids = children[topic.id];
        if (kids) {
          kids.sort(function (a, b) { return a.cluster - b.cluster; });
          li.appendChild(build(kids, depth + 1));
        }
        ul.appendChild(li);
      });
      return ul;
    };
    this.host.textContent = "";
    this.host.style.background = t.ground;
    this.host.appendChild(build(roots, 0));
    this._paint();
  };

  /* Applies the state: which rows are of the level the map shows (full ink;
     the others muted), which is hovered, which is selected. Given topic ids,
     only those rows are touched: a hover or a selection changes two rows, and
     writing all of them made the browser lay the whole list out again on
     every move of the pointer. */
  PolisTopicList.prototype._paint = function (only) {
    var t = this.theme, data = this.data, self = this;
    data.topics.forEach(function (topic) {
      if (only && only.indexOf(topic.id) < 0) return;
      var row = self._rows[topic.id];
      var onLevel = self.level === "all" || topic.level === self.level;
      var isSelected = topic.id === self.selected;
      var fill = t.point.fill === "topic" ? (self.level === "all" ? topic.colorAll : topic.color) : typeof t.point.fill === "function" ? t.point.fill(topic, self.level) : t.point.fill;
      row.style.color = onLevel || isSelected ? t.ink : t.inkMuted;
      row.style.background = isSelected ? t.list.selectedGround : topic.id === self.hovered ? t.list.hoverGround : "transparent";
      row.style.fontWeight = isSelected ? t.list.selectedWeight : t.font.uiWeight;
      row.setAttribute("aria-selected", isSelected ? "true" : "false");
      row.firstChild.style.background = fill;
      row.firstChild.style.opacity = onLevel || isSelected ? t.point.opacity : t.point.opacity * t.point.dimOpacity;
      row.lastChild.style.color = t.inkMuted;
    });
  };

  root.PolisTopicList = PolisTopicList;
  if (typeof module !== "undefined" && module.exports) module.exports = PolisTopicList;
})(typeof globalThis !== "undefined" ? globalThis : this);
