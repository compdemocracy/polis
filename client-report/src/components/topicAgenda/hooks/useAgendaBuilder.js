import { useState, useEffect } from "react";

export const useAgendaBuilder = (hierarchyAnalysis) => {
  const [currentLayer, setCurrentLayer] = useState(null);
  const [bankedTopics, setBankedTopics] = useState(new Map());
  const [currentSelections, setCurrentSelections] = useState(new Set());
  const [completedLayers, setCompletedLayers] = useState(new Set());

  // Set current layer to the highest available layer when hierarchy is loaded
  useEffect(() => {
    if (currentLayer === null && hierarchyAnalysis && hierarchyAnalysis.layers.length > 0) {
      const maxLayer = Math.max(...hierarchyAnalysis.layers);
      setCurrentLayer(maxLayer);
      console.log(`Setting current layer to highest available: ${maxLayer}`);
    }
  }, [hierarchyAnalysis, currentLayer]);

  const toggleTopicSelection = (topicKey) => {
    const newSelections = new Set(currentSelections);
    if (newSelections.has(topicKey)) {
      newSelections.delete(topicKey);
    } else {
      newSelections.add(topicKey);
    }
    setCurrentSelections(newSelections);
  };

  const bankAndClear = () => {
    if (currentSelections.size === 0) {
      alert("Please select at least one topic to bank before proceeding.");
      return;
    }

    // Bank the current selections
    const newBankedTopics = new Map(bankedTopics);
    newBankedTopics.set(currentLayer, new Set(currentSelections));
    setBankedTopics(newBankedTopics);

    // Mark current layer as completed
    const newCompletedLayers = new Set(completedLayers);
    newCompletedLayers.add(currentLayer);
    setCompletedLayers(newCompletedLayers);

    // Clear current selections
    setCurrentSelections(new Set());

    // Move to next layer (lower number = finer granularity)
    const nextLayer = currentLayer - 1;
    const minLayer = hierarchyAnalysis ? Math.min(...hierarchyAnalysis.layers) : 0;

    if (
      nextLayer >= minLayer &&
      hierarchyAnalysis &&
      hierarchyAnalysis.layers.includes(nextLayer)
    ) {
      setCurrentLayer(nextLayer);
      console.log(
        `Banked ${currentSelections.size} topics from Layer ${currentLayer}, moving to Layer ${nextLayer}`
      );
    } else {
      // Set currentLayer to null to indicate completion
      setCurrentLayer(null);
      console.log(
        `Agenda building complete! Banked topics from ${newCompletedLayers.size} layers.`
      );
    }
  };

  const resetAgenda = () => {
    setBankedTopics(new Map());
    setCurrentSelections(new Set());
    setCompletedLayers(new Set());
    if (hierarchyAnalysis && hierarchyAnalysis.layers.length > 0) {
      const maxLayer = Math.max(...hierarchyAnalysis.layers);
      setCurrentLayer(maxLayer);
    }
  };

  return {
    currentLayer,
    bankedTopics,
    currentSelections,
    completedLayers,
    setCurrentSelections,
    toggleTopicSelection,
    bankAndClear,
    resetAgenda,
  };
};
