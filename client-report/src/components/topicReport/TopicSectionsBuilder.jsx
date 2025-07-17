import React from 'react';

const TopicSectionsBuilder = ({ topicData, narrativeData, children }) => {
  console.log("TopicSectionsBuilder: Processing data");

  // Extract the latest run from topic data
  const getLatestRun = () => {
    if (!topicData?.runs || Object.keys(topicData.runs).length === 0) {
      return null;
    }

    return Object.values(topicData.runs).reduce((latest, run) => {
      return !latest || new Date(run.created_at) > new Date(latest.created_at) ? run : latest;
    }, null);
  };

  // Build global sections using narrative data
  const buildGlobalSections = () => {
    // Only build global sections if we have actual narrative reports
    if (!narrativeData?.reports || Object.keys(narrativeData.reports).length === 0) {
      console.log("No narrative reports available, skipping global sections");
      return [];
    }

    const globalSectionTypes = [
      { key: 'groups', name: 'Divisive Comments (Global)', sortKey: -300 },
      { key: 'group_informed_consensus', name: 'Cross-Group Consensus (Global)', sortKey: -200 },
      { key: 'uncertainty', name: 'High Uncertainty Comments (Global)', sortKey: -100 }
    ];

    return globalSectionTypes.map(({ key, name, sortKey }) => {
      // Check what keys actually exist in the narrative reports
      const longFormatKey = narrativeData?.current_job_id ? `${narrativeData.current_job_id}_global_${key}` : null;
      const shortFormatKey = `global_${key}`;
      
      let sectionKey;
      if (narrativeData?.reports) {
        // Check which format exists in the data
        if (narrativeData.reports[longFormatKey]) {
          sectionKey = longFormatKey;
        } else if (narrativeData.reports[shortFormatKey]) {
          sectionKey = shortFormatKey;
        } else if (narrativeData.reports[key]) {
          sectionKey = key;
        } else {
          // Default to short format if no data found
          sectionKey = shortFormatKey;
        }
      } else {
        sectionKey = shortFormatKey;
      }

      return {
        key: sectionKey,
        name: name,
        sortKey: sortKey,
        isGlobal: true
      };
    });
  };

  // Build layer topics from topic data
  const buildLayerTopics = (latestRun) => {
    if (!latestRun?.topics_by_layer) {
      return [];
    }

    const allTopics = [];
    const jobUuid = latestRun.job_uuid;
    const maxLayer = Math.max(...Object.keys(latestRun.topics_by_layer).map(Number));

    Object.keys(latestRun.topics_by_layer).forEach(layer => {
      const clusters = latestRun.topics_by_layer[layer];
      
      if (clusters && typeof clusters === 'object') {
        Object.entries(clusters).forEach(([clusterId, topic]) => {
          const topicKey = `${layer}_${clusterId}`;
          
          // Extract section key from topic_key, converting # to _
          let sectionKey;
          if (topic.topic_key && topic.topic_key.includes('#')) {
            sectionKey = topic.topic_key.replace(/#/g, '_');
          } else if (jobUuid) {
            sectionKey = `${jobUuid}_${layer}_${clusterId}`;
          } else {
            sectionKey = topic.topic_key || `layer${layer}_${clusterId}`;
          }

          
          allTopics.push({
            key: sectionKey,
            displayKey: topicKey,
            name: topic.topic_name || topicKey,
            sortKey: (maxLayer - parseInt(layer)) * 1000 + parseInt(clusterId)
          });
        });
      }
    });

    return allTopics;
  };

  const latestRun = getLatestRun();
  
  if (!latestRun) {
    return children({ 
      sections: [], 
      runInfo: null, 
      error: "No topic runs found" 
    });
  }

  // Build all sections
  const globalSections = buildGlobalSections();
  const layerTopics = buildLayerTopics(latestRun);
  const allSections = [...globalSections, ...layerTopics].sort((a, b) => a.sortKey - b.sortKey);

  const runInfo = {
    model_name: latestRun.model_name,
    created_date: latestRun.created_date,
    item_count: latestRun.item_count
  };

  console.log(`TopicSectionsBuilder: Built ${allSections.length} sections (${globalSections.length} global, ${layerTopics.length} topics)`);
  
  // Find the cross-group consensus section for default selection
  const defaultSection = allSections.find(section => 
    section.isGlobal && section.name.includes('Cross-Group Consensus')
  );
  
  return children({ 
    sections: allSections, 
    runInfo, 
    error: null,
    defaultSectionKey: defaultSection?.key || null
  });
};

export default TopicSectionsBuilder;