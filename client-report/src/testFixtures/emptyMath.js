// Synthetic zero-vote fixtures derived from the single committed engine contract.
import schedule from "../../../delphi/scripts/schedules/pc-zerovote-01-empty.json";
export function emptyMath(legacy = false) {
  const math = {
    pca: { comps: [[], []] },
    "base-clusters": { id: [], x: [], y: [], count: [], members: [] },
    repness: {},
  };
  for (const [key, value] of Object.entries(schedule.empty_output)) {
    const [parent, leaf] = key.split(".");
    const copy = JSON.parse(JSON.stringify(value));
    if (leaf) math[parent][leaf] = copy;
    else math[parent] = copy;
  }
  if (legacy)
    for (const key of schedule.legacy_absent_keys) {
      const [parent, leaf] = key.split(".");
      if (leaf) delete math[parent][leaf];
      else delete math[parent];
    }
  return math;
}
