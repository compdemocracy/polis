import { useState, useEffect, useCallback } from "react";
import net from "../../../util/net";

export const useTopicData = (reportId) => {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [topicData, setTopicData] = useState(null);
  const [hierarchyAnalysis, setHierarchyAnalysis] = useState(null);
  const [umapData, setUmapData] = useState(null);
  const [clusterGroups, setClusterGroups] = useState({});

  const analyzeHierarchy = (data) => {
    const runKeys = Object.keys(data.runs);
    if (runKeys.length === 0) {
      setHierarchyAnalysis({ hasHierarchy: false, reason: "No runs data" });
      return;
    }

    const firstRun = data.runs[runKeys[0]];
    if (!firstRun.topics_by_layer) {
      setHierarchyAnalysis({ hasHierarchy: false, reason: "No topics_by_layer data in run" });
      return;
    }

    const layers = Object.keys(firstRun.topics_by_layer)
      .map((k) => parseInt(k))
      .sort((a, b) => a - b);
    console.log("Analyzing layers:", layers);

    const analysis = {
      hasHierarchy: false,
      layers: layers,
      layerCounts: {},
      sampleTopics: {},
      totalComments: 0,
      structure: "unknown",
      runInfo: {
        model_name: firstRun.model_name,
        created_at: firstRun.created_at,
        job_uuid: firstRun.job_uuid,
      },
    };

    layers.forEach((layerId) => {
      const topics = firstRun.topics_by_layer[layerId];
      analysis.layerCounts[layerId] = Object.keys(topics).length;

      analysis.sampleTopics[layerId] = Object.values(topics)
        .slice(0, 3)
        .map((topic) => ({
          name: topic.topic_name,
          key: topic.topic_key,
          cluster_id: topic.cluster_id,
          model_name: topic.model_name,
        }));
    });

    const counts = Object.values(analysis.layerCounts);
    const hasVariedCounts = Math.max(...counts) !== Math.min(...counts);

    if (hasVariedCounts && layers.length > 1) {
      analysis.hasHierarchy = true;
      analysis.structure = "hierarchical";
      analysis.reason = `Found ${layers.length} layers with varying topic counts: ${counts.join(
        ", "
      )}`;
    } else if (layers.length === 1) {
      analysis.structure = "flat";
      analysis.reason = "Only one layer found - flat structure";
    } else {
      analysis.structure = "unclear";
      analysis.reason = "Multiple layers but similar counts - unclear hierarchy";
    }

    console.log("Hierarchy analysis:", analysis);
    setHierarchyAnalysis(analysis);
  };

  const groupPointsByLayer = (data) => {
    const groups = {};
    const allClusterIds = new Set();

    for (let layer = 0; layer <= 3; layer++) {
      groups[layer] = new Map();
    }

    data.forEach((point) => {
      Object.entries(point.clusters || {}).forEach(([layerId, clusterId]) => {
        const layer = parseInt(layerId);
        const key = `${layer}_${clusterId}`;

        if (layer === 0) {
          allClusterIds.add(clusterId);
        }

        if (!groups[layer].has(key)) {
          groups[layer].set(key, []);
        }

        groups[layer].get(key).push({
          comment_id: point.comment_id,
          cluster_id: clusterId,
          layer: layer,
          umap_x: point.umap_x,
          umap_y: point.umap_y,
          weight: point.weight || 1,
        });
      });
    });

    return groups;
  };

  const fetchUMAPData = useCallback(async (conversation) => {
    try {
      const conversationId = conversation?.conversation_id || reportId;
      console.log("Fetching UMAP data for spatial filtering...");

      const response = await fetch(
        `/api/v3/topicMod/proximity?conversation_id=${conversationId}&layer_id=all`
      );
      const data = await response.json();

      if (data.status === "success" && data.proximity_data) {
        console.log(`Loaded ${data.proximity_data.length} UMAP points for spatial filtering`);
        setUmapData(data.proximity_data);

        const groups = groupPointsByLayer(data.proximity_data);
        setClusterGroups(groups);

        console.log("UMAP cluster groups:", groups);
      } else {
        console.log("No UMAP data available for spatial filtering");
      }
    } catch (err) {
      console.error("Error fetching UMAP data:", err);
    }
  }, [reportId]);

  useEffect(() => {
    if (!reportId) return;

    setLoading(true);
    net
      .polisGet("/api/v3/delphi", {
        report_id: reportId,
      })
      .then((response) => {
        console.log("TopicAgenda topics response:", response);

        if (response && response.status === "success") {
          if (response.runs && Object.keys(response.runs).length > 0) {
            setTopicData(response);
            analyzeHierarchy(response);
          } else {
            setError("No LLM topic data available yet. Run Delphi analysis first.");
          }
        } else {
          setError("Failed to retrieve topic data");
        }

        setLoading(false);
      })
      .catch((err) => {
        console.error("Error fetching topic data:", err);
        setError("Failed to connect to the topicMod endpoint");
        setLoading(false);
      });
  }, [reportId]);

  return {
    loading,
    error,
    topicData,
    hierarchyAnalysis,
    umapData,
    clusterGroups,
    fetchUMAPData,
  };
};
