const schedule = require("../../delphi/scripts/schedules/pc-zerovote-01-empty.json");
module.exports = function emptyMath(legacy = false) {
  const data = {
    pca: { comps: [[], []] },
    "base-clusters": { id: [], x: [], y: [], count: [], members: [] },
    repness: {}
  };
  for (const [key, value] of Object.entries(schedule.empty_output)) {
    const [parent, leaf] = key.split(".");
    if (leaf) data[parent][leaf] = structuredClone(value);
    else data[parent] = structuredClone(value);
  }
  if (legacy)
    for (const key of schedule.legacy_absent_keys) {
      const [parent, leaf] = key.split(".");
      if (leaf) delete data[parent][leaf];
      else delete data[parent];
    }
  return data;
};
