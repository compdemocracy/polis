/*
 * TopicMap: the topic map of one report as a Solid component.
 *
 * Props:
 *   reportId       the report whose map is drawn
 *   jobId          optional: one named Delphi run's map instead of the current one
 *   selection      optional, without jobId: the current map made under another
 *                  comment rule (participant_visible, all_but_moderated_out,
 *                  all_comments); the route decides whether this reader may
 *                  have it
 *   theme          "light" or "dark" (themes.js), or a theme object
 *   document       optional: a polis-topic-map/1 document to draw instead of
 *                  asking the route (a page that already holds one)
 *   controls       false to leave out the row of buttons above the map
 *   onTopicSelect, onTopicHover, onLevelChange
 *                  optional: called with the map's event detail
 *                  ({ topic | level, previous, origin }) for each event
 *   fetch          optional: the fetch to ask the route with
 *   token          optional: a Bearer token sent with every request, for a
 *                  placement whose reader is signed in; the public page sends none
 *   conversationId optional: the report's conversation id, when the host
 *                  knows it, so the comment text costs one request, not two
 *   commentText    false to ask for no comment text (tooltips then say only
 *                  "Moderated out", on held-back points)
 *   counts         false to leave out the line of counts
 *   header         optional: shown above the buttons (the page puts its
 *                  chooser of runs here)
 *
 * Held-back comments (the document's last points.moderatedOut points: a
 * position, no id, no topic) are drawn as the package draws a point with no
 * topic, grey and beneath, and their tooltip says "Moderated out". A line
 * under the buttons gives the counts the document holds. Other points' text
 * comes from the report's comment list, asked for at the first pointer move
 * over the map and kept in memory (load.js names the requests).
 *
 * The map itself is client-topic-map's PolisTopicMap, used as it is. The
 * row of buttons is the host's, as the prototype's host page writes it: one
 * button per level and one for every level together, then the two rules for
 * which topic names show.
 */
import { createEffect, createSignal, onCleanup, untrack } from "solid-js";
import h from "@solidjs/h";
import PolisTopicMap from "../../client-topic-map/topic-map.js";
import { mapRequest, readCommentText, readTopicMap, TEXT } from "./load.js";
import { countLine, fillText, withTooltipText } from "./points.js";
import { chromeProperties, themeFor } from "./themes.js";

const RULES = [
  ["as-drawn", "Names as datamapplot draws them today"],
  ["by-weight", "Largest topic first"],
];

const count = (n) => n.toLocaleString("en-US");

/* Comment text by report, asked for once per page and kept in memory. */
const commentText = new Map();

function textFor(fetchFn, reportId, conversationId, token) {
  const key = `${reportId}|${conversationId || ""}`;
  if (!commentText.has(key)) commentText.set(key, readCommentText(fetchFn, reportId, { conversationId, token }));
  return commentText.get(key);
}

function resolveTheme(theme) {
  return theme && typeof theme === "object" ? theme : themeFor(theme);
}

export function levelChoices(doc) {
  const choices = doc.levels.map((l) => ({ level: l.level, text: count(l.topics) + " topics" }));
  choices.push({ level: "all", text: "All " + count(doc.topics.length) + " together" });
  return choices;
}

export default function TopicMap(props) {
  const [state, setState] = createSignal({ kind: "loading", text: TEXT.loading });
  const [level, setLevel] = createSignal(0);
  const [collision, setCollision] = createSignal("as-drawn");
  let mapElement;
  let map = null;

  const fetchFn = () => untrack(() => props.fetch) || globalThis.fetch.bind(globalThis);

  // The one read: again only if the report, the run or the rule changes.
  createEffect(
    () => [props.reportId, props.jobId, props.selection, props.document],
    ([reportId, jobId, selection, doc]) => {
      if (doc) {
        setState({ kind: "map", doc });
        return undefined;
      }
      const request = mapRequest({ reportId, jobId, selection });
      if (!request) {
        setState({ kind: "none", text: TEXT.noReport });
        return undefined;
      }
      let current = true;
      setState({ kind: "loading", text: TEXT.loading });
      readTopicMap(fetchFn(), request, { token: untrack(() => props.token) }).then((answer) => {
        if (current) setState(answer);
      });
      return () => {
        current = false;
      };
    },
  );

  // The map, made when there is a document to draw.
  createEffect(
    () => state(),
    (s) => {
      if (s.kind !== "map" || !mapElement) return undefined;
      // The map reads each point's text when it shows its tooltip, so the
      // text can arrive after it is drawn.
      const data = withTooltipText(s.doc);
      try {
        map = new PolisTopicMap(mapElement, {
          data,
          theme: resolveTheme(untrack(() => props.theme)),
          level: 0,
        });
      } catch (e) {
        map = null;
        setState({ kind: "refused", text: TEXT.undrawable });
        return undefined;
      }
      const made = map;
      setLevel(made.level);
      setCollision(made.collision);
      const pass = (name) => (e) => {
        const callback = untrack(() => props[name]);
        if (typeof callback === "function") callback(e.detail);
      };
      const onSelect = pass("onTopicSelect");
      const onHover = pass("onTopicHover");
      const onLevel = pass("onLevelChange");
      const onLevelShown = (e) => setLevel(e.detail.level);
      mapElement.addEventListener("topicselect", onSelect);
      mapElement.addEventListener("topichover", onHover);
      mapElement.addEventListener("levelchange", onLevel);
      mapElement.addEventListener("levelchange", onLevelShown);
      let asked = false;
      const askText = () => {
        if (asked) return;
        asked = true;
        mapElement.removeEventListener("pointermove", askText);
        const reportId = untrack(() => props.reportId);
        if (!reportId || untrack(() => props.commentText) === false) return;
        textFor(fetchFn(), reportId, untrack(() => props.conversationId), untrack(() => props.token)).then((byId) => {
          if (map === made) fillText(data, byId);
        });
      };
      mapElement.addEventListener("pointermove", askText);
      return () => {
        mapElement.removeEventListener("pointermove", askText);
        mapElement.removeEventListener("topicselect", onSelect);
        mapElement.removeEventListener("topichover", onHover);
        mapElement.removeEventListener("levelchange", onLevel);
        mapElement.removeEventListener("levelchange", onLevelShown);
        made.destroy();
        if (map === made) map = null;
      };
    },
  );

  // Another theme for a map already drawn.
  createEffect(
    () => resolveTheme(props.theme),
    (theme) => {
      if (map) map.setTheme(theme);
    },
  );

  onCleanup(() => {
    if (map) map.destroy();
    map = null;
  });

  const showsMap = () => state().kind === "map";
  const counts = () => {
    const s = state();
    return s.kind === "map" && props.counts !== false ? countLine(s.doc) : null;
  };

  const levelButtons = () => {
    const s = state();
    if (s.kind !== "map") return null;
    return levelChoices(s.doc).map((c) =>
      h(
        "button",
        {
          type: "button",
          "data-level": String(c.level),
          "aria-pressed": () => String(level() === c.level),
          onClick: () => {
            if (map) map.setLevel(c.level, "host");
          },
        },
        c.text,
      ),
    );
  };

  const ruleButtons = () =>
    RULES.map(([mode, text]) =>
      h(
        "button",
        {
          type: "button",
          "data-names": mode,
          "aria-pressed": () => String(collision() === mode),
          onClick: () => {
            if (!map) return;
            map.setCollision(mode);
            setCollision(mode);
          },
        },
        text,
      ),
    );

  return h(
    "div",
    {
      class: "polis-topic-map",
      "data-state": () => state().kind,
      style: () => chromeProperties(resolveTheme(props.theme)),
    },
    () => props.header,
    () =>
      showsMap() && props.controls !== false
        ? h("div", { class: "polis-topic-map-controls" }, [
            h("div", { class: "polis-topic-map-levels", role: "group", "aria-label": "Level of the topics shown" }, levelButtons),
            h("div", { class: "polis-topic-map-rules", role: "group", "aria-label": "Which topic names show" }, ruleButtons),
          ])
        : null,
    () => (counts() ? h("p", { class: "polis-topic-map-counts" }, counts()) : null),
    h("div", {
      class: "polis-topic-map-canvas",
      ref: (el) => {
        mapElement = el;
      },
      style: () => ({ display: showsMap() ? "block" : "none" }),
    }),
    () => (showsMap() ? null : h("p", { class: "polis-topic-map-message", role: "status" }, () => state().text)),
  );
}
