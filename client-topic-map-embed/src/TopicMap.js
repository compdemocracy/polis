/*
 * TopicMap: the topic map of one report as a Solid component.
 *
 * Props:
 *   reportId       the report whose map is drawn
 *   jobId          optional: one named Delphi run's map instead of the current one
 *   theme          "light" or "dark" (themes.js), or a theme object
 *   document       optional: a polis-topic-map/1 document to draw instead of
 *                  asking the route (a page that already holds one)
 *   controls       false to leave out the row of buttons above the map
 *   onTopicSelect, onTopicHover, onLevelChange
 *                  optional: called with the map's event detail
 *                  ({ topic | level, previous, origin }) for each event
 *   fetch          optional: the fetch to ask the route with
 *
 * The map itself is client-topic-map's PolisTopicMap, used as it is. The
 * row of buttons is the host's, as the prototype's host page writes it: one
 * button per level and one for every level together, then the two rules for
 * which topic names show.
 */
import { createEffect, createSignal, onCleanup, untrack } from "solid-js";
import h from "@solidjs/h";
import PolisTopicMap from "../../client-topic-map/topic-map.js";
import { readTopicMap, TEXT } from "./load.js";
import { chromeProperties, themeFor } from "./themes.js";

const RULES = [
  ["as-drawn", "Names as datamapplot draws them today"],
  ["by-weight", "Largest topic first"],
];

const count = (n) => n.toLocaleString("en-US");

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

  // The one read: again only if the report or the run changes.
  createEffect(
    () => [props.reportId, props.jobId, props.document],
    ([reportId, jobId, doc]) => {
      if (doc) {
        setState({ kind: "map", doc });
        return undefined;
      }
      let current = true;
      setState({ kind: "loading", text: TEXT.loading });
      const fetchFn = untrack(() => props.fetch) || globalThis.fetch.bind(globalThis);
      readTopicMap(fetchFn, reportId, jobId).then((answer) => {
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
      try {
        map = new PolisTopicMap(mapElement, {
          data: s.doc,
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
      return () => {
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
    () =>
      showsMap() && props.controls !== false
        ? h("div", { class: "polis-topic-map-controls" }, [
            h("div", { class: "polis-topic-map-levels", role: "group", "aria-label": "Level of the topics shown" }, levelButtons),
            h("div", { class: "polis-topic-map-rules", role: "group", "aria-label": "Which topic names show" }, ruleButtons),
          ])
        : null,
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
