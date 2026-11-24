/*
 * The page at /topicsVizReport/<report id>: the topic map and nothing else.
 * ?job_id=<id> draws one named Delphi run's map; ?theme=light|dark picks the
 * theme (themes.js names the default). A page built with a document inlined
 * (build.mjs --standalone) draws that document and asks nothing.
 */
import { render } from "@solidjs/web";
import h from "@solidjs/h";
import TopicMap from "./TopicMap.js";
import { fromAddress } from "./load.js";
import { themeFor, themeName } from "./themes.js";

const address = fromAddress(window.location.pathname, window.location.search);
const theme = themeName(address.theme);
const inlined = window.POLIS_TOPIC_MAP_DOCUMENT || null;

document.documentElement.dataset.theme = theme;
document.documentElement.style.colorScheme = theme === "dark" ? "dark" : "light";
document.body.style.background = themeFor(theme).ground;

const root = document.getElementById("topic-map");
render(
  () =>
    h(TopicMap, {
      reportId: address.reportId,
      jobId: address.jobId,
      theme,
      document: inlined,
    }),
  root,
);
