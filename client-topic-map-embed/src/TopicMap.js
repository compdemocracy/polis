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
 *   drawing        optional: "dense" for the map's dense drawing
 *                  (client-topic-map's drawing option, or an object of its
 *                  settings); the level and name-rule buttons, which do
 *                  nothing in it, are then left out. None, null or "default":
 *                  the map as drawn without it.
 *   onDrawingChange
 *                  optional: puts two buttons first in the row, one per
 *                  drawing (DRAWINGS), shown in both drawings; a press calls
 *                  it with "dense" or null, and the host gives the new
 *                  drawing back as the drawing prop
 *   controls       false to leave out the row of buttons above the map
 *   onTopicSelect, onTopicHover, onLevelChange
 *                  optional: called with the map's event detail
 *                  ({ topic | level, previous, origin }) for each event
 *   fetch          optional: the fetch to ask the route with
 *   token          optional: a Bearer token sent with every request, for a
 *                  placement whose reader is signed in; the public page sends
 *                  none. A new token (or none) reloads the map and its text.
 *   conversationId, modLevel
 *                  optional: the report's conversation id and moderation
 *                  level (reports.mod_level), when the host knows both, so
 *                  the comment text costs one request, not two; with either
 *                  missing the report is read for them
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
 * comes from the report's comment list under the report's moderation level,
 * asked for at the first pointer move over the map and kept in memory for
 * that reader only (load.js names the requests; commentText.js the keeping).
 * In the dense drawing the comment list is asked for as soon as the map is
 * drawn, with the conversation's math result beside it, and both are joined
 * onto the points with a comment id for the deepest zoom (deepZoom.js); the
 * map's own drawing never asks for the math result.
 *
 * The map itself is client-topic-map's PolisTopicMap, used as it is. The
 * row of buttons is the host's, as the prototype's host page writes it: one
 * button per level and one for every level together, then the two rules for
 * which topic names show.
 */
import { createEffect, createSignal, onCleanup, untrack } from "solid-js";
import h from "@solidjs/h";
import PolisTopicMapDense from "../../client-topic-map/dense.js";
import PolisTopicMap from "../../client-topic-map/topic-map.js";
import { isDense, mapRequest, readTopicMap, TEXT } from "./load.js";
import { allowedIds, readerDataFor, wireMap } from "./deepZoom.js";
import { countLine, withTooltipText } from "./points.js";
import { chromeProperties, themeFor } from "./themes.js";

const RULES = [
  ["as-drawn", "Names as datamapplot draws them today"],
  ["by-weight", "Largest topic first"],
];

// The two drawings, as the buttons name them (shown when the host passes
// onDrawingChange): the map's own, and the dense drawing.
export const DRAWINGS = [
  ["default", "Points coloured by topic"],
  ["dense", "Topic zones and districts"],
];

// The dense drawing's rules, where the map looks for them (dense.js sets them
// there itself when it runs; naming them here keeps them in every build).
if (!globalThis.PolisTopicMapDense) globalThis.PolisTopicMapDense = PolisTopicMapDense;

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
  let drawnWith = null; // the drawing the map was last given (null: its own)

  const fetchFn = () => untrack(() => props.fetch) || globalThis.fetch.bind(globalThis);
  // This component's comment text and math result, for one reader at a time
  // (commentText.js keeps it; deepZoom.js reads it), made afresh with every
  // read of the map.
  const freshData = () => readerDataFor((url, init) => fetchFn()(url, init));
  let dataFor = freshData();
  let wiring = null;

  // The one read: again if the report, the run, the rule, the document or
  // the reader's token, conversation or moderation level changes; the old map and text go.
  createEffect(
    () => [props.reportId, props.jobId, props.selection, props.document, props.token, props.conversationId, props.modLevel],
    ([reportId, jobId, selection, doc, token]) => {
      dataFor = freshData();
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
      readTopicMap(fetchFn(), request, { token }).then((answer) => {
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
      const drawing = untrack(() => props.drawing);
      try {
        map = new PolisTopicMap(mapElement, {
          data,
          theme: resolveTheme(untrack(() => props.theme)),
          level: 0,
          ...(isDense(drawing) ? { drawing } : {}),
        });
        drawnWith = isDense(drawing) ? drawing : null;
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
      const reportId = untrack(() => props.reportId);
      const inputs =
        reportId && untrack(() => props.commentText) !== false
          ? dataFor({
              reportId,
              conversationId: untrack(() => props.conversationId),
              modLevel: untrack(() => props.modLevel),
              token: untrack(() => props.token),
              // the reads keep only what concerns this map's comments
              ids: allowedIds(data),
            })
          : null;
      // The map's own drawing: text at the first pointer move. The dense
      // drawing: text and the math result at once, joined after the map draws.
      const wired = wireMap({ map: made, element: mapElement, data, inputs, drawing: drawnWith });
      wiring = wired;
      return () => {
        wired.destroy();
        if (wiring === wired) wiring = null;
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

  // Another drawing for a map already drawn.
  createEffect(
    () => (isDense(props.drawing) ? props.drawing : null),
    (drawing) => {
      if (!map || drawing === drawnWith) return;
      drawnWith = drawing;
      if (wiring) wiring.setDrawing(drawing);
      else map.setDrawing(drawing);
    },
  );

  onCleanup(() => {
    // the wiring first: it revokes the reader's lifetime (deepZoom.js)
    if (wiring) wiring.destroy();
    wiring = null;
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

  const drawingButtons = () =>
    DRAWINGS.map(([mode, text]) =>
      h(
        "button",
        {
          type: "button",
          "data-drawing": mode,
          "aria-pressed": () => String((isDense(props.drawing) ? "dense" : "default") === mode),
          onClick: () => {
            if (typeof props.onDrawingChange === "function") props.onDrawingChange(mode === "dense" ? "dense" : null);
          },
        },
        text,
      ),
    );

  const choosesDrawing = () => typeof props.onDrawingChange === "function";

  return h(
    "div",
    {
      class: "polis-topic-map",
      "data-state": () => state().kind,
      style: () => chromeProperties(resolveTheme(props.theme)),
    },
    () => props.header,
    () =>
      showsMap() && props.controls !== false && (choosesDrawing() || !isDense(props.drawing))
        ? h("div", { class: "polis-topic-map-controls" }, [
            choosesDrawing()
              ? h("div", { class: "polis-topic-map-drawings", role: "group", "aria-label": "How the map is drawn" }, drawingButtons)
              : null,
            // The level and rule buttons do nothing in the dense drawing (the
            // drawing buttons stay, so a pressed one keeps its focus).
            () =>
              isDense(props.drawing)
                ? null
                : [
                    h("div", { class: "polis-topic-map-levels", role: "group", "aria-label": "Level of the topics shown" }, levelButtons),
                    h("div", { class: "polis-topic-map-rules", role: "group", "aria-label": "Which topic names show" }, ruleButtons),
                  ],
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
