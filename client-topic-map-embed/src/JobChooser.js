/*
 * JobChooser: the page's quiet choice of which run's map to draw, shown only
 * when the report has more than one run with a stored map (jobs.js says what
 * it offers). Part of the page, not of the TopicMap component.
 *
 * Props:
 *   list       the list's answer (load.js readJobList), or null while asked
 *   jobId      the run the page names, or null
 *   selection  the comment rule the page names, or null
 *   onChoose   called with the chosen run's id ("" for the current map)
 */
import h from "@solidjs/h";
import { chooserState } from "./jobs.js";

export default function JobChooser(props) {
  const state = () => chooserState(props.list, { jobId: props.jobId, selection: props.selection });
  return () => {
    const s = state();
    if (!s.show) return null;
    return h("label", { class: "polis-topic-map-jobs" }, [
      h("span", "Map: "),
      h(
        "select",
        {
          "aria-label": "Which run's topic map is drawn",
          onChange: (e) => props.onChoose(e.currentTarget.value),
        },
        s.choices.map((c) => h("option", { value: c.value, selected: c.value === s.value }, c.text)),
      ),
    ]);
  };
}
