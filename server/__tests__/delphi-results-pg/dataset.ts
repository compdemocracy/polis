/** Generated Delphi result items shaped like the pipeline's writers. Sizes are
 * chosen so the families the readers read exceed 1,000 items and 1 MB. */
import { Tagged } from "./support";

const S = (s: string) => ({S: s});
const N = (n: number | string) => ({N: String(n)});
const L = (xs: any[]) => ({L: xs});
const M = (m: Record<string, any>) => ({M: m});
const BOOL = (b: boolean) => ({BOOL: b});

/** Deterministic decimals with at most six places, in DynamoDB's canonical form. */
function decimals(seed: number) {
  let x = seed;
  return () => {
    x = (x * 1103515245 + 12345) % 2147483648;
    const value = ((x % 2000001) - 1000000) / 100000;
    return String(Number(value.toFixed(5)));
  };
}

export const ZID = 101, OTHER_ZID = 102;
export const REPORT = "r101generatedparity0000", OTHER_REPORT = "r102generatedparity0000";
export const JOBS = ["00000000-0000-4000-8000-0000000a0101", "00000000-0000-4000-8000-0000000b0101"];

export function umapGraph(zid: number, nodes: number): Tagged[] {
  const next = decimals(zid);
  const cid = String(zid);
  const items: Tagged[] = [];
  for (let i = 0; i < nodes; i++) {
    items.push({conversation_id: S(cid), edge_id: S(`${i}_${i}`), source_id: N(i), target_id: N(i),
      weight: N(1), distance: N(0), is_nearest_neighbor: BOOL(true), shared_cluster_layers: L([]),
      position: M({x: N(next()), y: N(next())})});
    for (let j = i + 1; j < Math.min(nodes, i + 7); j++) {
      items.push({conversation_id: S(cid), edge_id: S(`${i}_${j}`), source_id: N(i), target_id: N(j),
        weight: N(next().replace("-", "")), distance: N(next().replace("-", "")), is_nearest_neighbor: BOOL(j === i + 1),
        shared_cluster_layers: L([N(0), N(1)])});
    }
  }
  return items;
}

export function assignments(zid: number, comments: number): Tagged[] {
  const next = decimals(zid + 7);
  return Array.from({length: comments}, (_, t) => ({
    conversation_id: S(String(zid)), comment_id: N(t), is_outlier: BOOL(t % 17 === 0),
    layer0_cluster_id: N(t % 9), layer1_cluster_id: N(t % 4), layer2_cluster_id: t % 5 ? N(t % 2) : {NULL: true},
    distance_to_centroid: M({"0": N(next().replace("-", "")), "1": N(next().replace("-", ""))}),
    cluster_confidence: M({"0": N("0.95"), "1": N("0.87")}),
    ...(t % 3 === 0 ? {layer_id: N(t % 2)} : {}),
  }));
}

export function topicNames(zid: number): Tagged[] {
  const items: Tagged[] = [];
  for (const job of JOBS) {
    for (let layer = 0; layer < 3; layer++) {
      for (let cluster = 0; cluster < 250; cluster++) {
        items.push({conversation_id: S(String(zid)), topic_key: S(`${job}#${layer}#${cluster}`), layer_id: N(layer),
          cluster_id: N(cluster), topic_name: S(`Generated topic ${layer}.${cluster} about the shared library hours`),
          model_name: S("generated-model-a"), created_at: S(`2026-01-0${1 + (cluster % 9)}T00:00:00.000000`), job_id: S(job)});
      }
    }
  }
  for (let cluster = 0; cluster < 40; cluster++) {
    items.push({conversation_id: S(String(zid)), topic_key: S(`layer0_${cluster}`), layer_id: N(0), cluster_id: N(cluster),
      topic_name: S(`Generated legacy topic ${cluster}`), model_name: S("unknown"), created_at: S("2025-11-13T08:00:00")});
  }
  return items;
}

/** Cluster keys include non-ASCII text so UTF-8 byte order differs from UTF-16 order. */
export function structureKeywords(zid: number, count: number): Tagged[] {
  const odd = ["ｚ", "\u{1F600}", "é", "Z", "a"];
  return Array.from({length: count}, (_, k) => ({
    conversation_id: S(String(zid)), cluster_key: S(`layer${k % 3}_${k}${k < odd.length ? odd[k] : ""}`), layer_id: N(k % 3),
    cluster_id: N(k), topic_label: S(`Generated label ${k}`), size: N(5 + (k % 40)),
    sample_comments: L(Array.from({length: 6}, (_, i) => S(`Generated sample comment ${k}-${i} `.repeat(4)))),
    centroid_coordinates: M({x: N("1.25"), y: N("-3.5")}), top_words: L([S("alpha"), S("beta"), S("gamma")]),
    top_tfidf_scores: L([N("0.5"), N("0.25"), N("0.125")]), parent_cluster: M({layer_id: N(1), cluster_id: N(0)}), child_clusters: L([]),
  }));
}

export function narrativeReports(report: string, count: number): Tagged[] {
  return Array.from({length: count}, (_, i) => {
    const section = `topic_${String(i).padStart(4, "0")}`;
    return {rid_section_model: S(`${report}#${section}#generated-model-a`),
      timestamp: S(`2026-02-01T00:${String(Math.floor(i / 60) % 60).padStart(2, "0")}:${String(i % 60).padStart(2, "0")}.${String(i).padStart(6, "0")}`),
      report_id: S(report), section: S(section), model: S("generated-model-a"),
      report_data: S(JSON.stringify({paragraphs: [{id: `p${i}`, text: "Generated narrative paragraph. ".repeat(40)}]}))};
  });
}

export function collectiveStatements(zid: number, count: number): Tagged[] {
  return Array.from({length: count}, (_, i) => ({
    zid_topic_jobid: S(`${zid}#${JOBS[0]}#0#${i}#00000000-0000-4000-8000-${String(i).padStart(12, "0")}`),
    zid: S(String(zid)), topic_key: S(`${JOBS[0]}#0#${i % 7}`), topic_name: S(`Generated topic ${i % 7}`),
    statement_data: S(JSON.stringify({paragraphs: [{id: "p1", title: "Generated", sentences: []}]})),
    comments_data: S("[]"), created_at: S(`2026-03-01T00:00:${String(i % 60).padStart(2, "0")}.${String(i).padStart(3, "0")}Z`),
    model: S("generated-model-a"),
  }));
}

export function narrativeStore(report: string, count: number): Tagged[] {
  return Array.from({length: count}, (_, i) => ({
    rid_section_model: S(`${report}#section_${String(i).padStart(4, "0")}#openai`),
    timestamp: S(`2026-04-01T00:00:00.${String(i).padStart(3, "0")}Z`), report_id: S(report), model: S("openai"),
    report_data: S(JSON.stringify({id: `generated-${i}`, body: "Generated cached narrative. ".repeat(40)})),
  }));
}

/** The served data. Narrative-store rows are a second generation over the first. */
export function dataset() {
  return {
    first: {
      Delphi_UMAPGraph: umapGraph(ZID, 1200),
      Delphi_CommentHierarchicalClusterAssignments: assignments(ZID, 1500),
      Delphi_CommentClustersLLMTopicNames: topicNames(ZID),
      Delphi_CommentClustersStructureKeywords: structureKeywords(ZID, 1100),
      Delphi_NarrativeReports: narrativeReports(REPORT, 1100),
      Delphi_CollectiveStatement: collectiveStatements(ZID, 30),
      report_narrative_store: narrativeStore(REPORT, 5),
    },
    second: {report_narrative_store: narrativeStore(REPORT, 1050)},
    other: {
      Delphi_UMAPGraph: umapGraph(OTHER_ZID, 20),
      Delphi_CommentHierarchicalClusterAssignments: assignments(OTHER_ZID, 30),
      Delphi_CommentClustersLLMTopicNames: topicNames(OTHER_ZID).slice(0, 30),
      Delphi_NarrativeReports: narrativeReports(OTHER_REPORT, 12),
      Delphi_CollectiveStatement: collectiveStatements(OTHER_ZID, 3),
      report_narrative_store: narrativeStore(OTHER_REPORT, 20),
    },
  };
}
