/*
 * The page at /topicsVizReport/<report id>: the topic map, the chooser of
 * runs, and nothing else. The address maps to the component's props:
 *   ?job_id=<id>        one named run's map
 *   ?selection=<rule>   without job_id: the current map under another
 *                       comment rule (load.js SELECTIONS)
 *   ?theme=light|dark   the theme (themes.js names the default)
 *   ?chooser=0          no chooser of runs (and no list asked for)
 * Choosing a run draws it and puts its job_id in the address, so the view can
 * be linked to. The list of runs is asked for beside the map, never before
 * it: when the list does not answer, there is no chooser and the map draws.
 * A page built with a document inlined (build.mjs --standalone) draws that
 * document, or answers from the runs inlined, and asks no host.
 */
import { render } from "@solidjs/web";
import h from "@solidjs/h";
import { createSignal } from "solid-js";
import TopicMap from "./TopicMap.js";
import JobChooser from "./JobChooser.js";
import { addressWithJob, fromAddress, readJobList } from "./load.js";
import { offlineFetch } from "./offline.js";
import { themeFor, themeName } from "./themes.js";

const address = fromAddress(window.location.pathname, window.location.search);
const theme = themeName(address.theme);
const inlined = window.POLIS_TOPIC_MAP_DOCUMENT || null;
const offline = window.POLIS_TOPIC_MAP_OFFLINE || null;
const fetchFn = offline ? offlineFetch(offline) : globalThis.fetch.bind(globalThis);
const reportId = offline ? offline.reportId : address.reportId;

document.documentElement.dataset.theme = theme;
document.documentElement.style.colorScheme = theme === "dark" ? "dark" : "light";
document.body.style.background = themeFor(theme).ground;

const [jobId, setJobId] = createSignal(address.jobId);
const [selection, setSelection] = createSignal(address.selection);
const [list, setList] = createSignal(null);

if (address.chooser && reportId && !inlined) {
  readJobList(fetchFn, reportId).then(setList);
}

function choose(value) {
  setJobId(value || null);
  setSelection(null);
  const next = window.location.pathname + addressWithJob(window.location.search, value) + window.location.hash;
  try {
    window.history.replaceState(null, "", next);
  } catch (e) {
    // A page opened from disk may not be allowed to change its address.
  }
}

const root = document.getElementById("topic-map");
render(
  () =>
    h(TopicMap, {
      reportId,
      jobId: () => jobId(),
      selection: () => selection(),
      theme,
      document: inlined,
      fetch: (url, init) => fetchFn(url, init),
      commentText: !offline,
      header: h(JobChooser, {
        list: () => list(),
        jobId: () => jobId(),
        selection: () => selection(),
        onChoose: (value) => choose(value),
      }),
    }),
  root,
);
