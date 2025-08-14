import React, { useState, useEffect } from "react";
import { jsonrepair } from "jsonrepair";
import net from "../../util/net";
import { useReportId } from "../framework/useReportId";
import CommentList from "../lists/commentList.jsx";
import "./CommentsReport.css";

const CommentsReport = ({ math, comments, conversation, ptptCount, formatTid, voteColors, showControls = true, authToken }) => {
  const { report_id } = useReportId();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [runs, setRuns] = useState({});
  const [selectedRunKey, setSelectedRunKey] = useState(null);
  const [visualizationJobs, setVisualizationJobs] = useState([]);
  const [visualizationsLoading, setVisualizationsLoading] = useState(true);
  const [narrativeReports, setNarrativeReports] = useState({});
  const [narrativeLoading, setNarrativeLoading] = useState(true);
  const [narrativeRunInfo, setNarrativeRunInfo] = useState(null);
  const [topicData, setTopicData] = useState(null);
  const [topicDataLoading, setTopicDataLoading] = useState(true);
  const [jobFormOpen, setJobFormOpen] = useState(false);
  const [jobFormData, setJobFormData] = useState({
    job_type: "FULL_PIPELINE",
    priority: 50,
    max_votes: "",
    batch_size: "",
    model: "claude-opus-4-20250514",
    include_topics: true,
  });
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [jobCreationResult, setJobCreationResult] = useState(null);
  const [batchReportLoading, setBatchReportLoading] = useState(false);
  const [batchReportResult, setBatchReportResult] = useState(null);
  const [selectedLayer, setSelectedLayer] = useState(0);
  const [selectedReportSection, setSelectedReportSection] = useState("");
  const [showGlobalSections, setShowGlobalSections] = useState(false);

  useEffect(() => {
    if (!report_id) return;

    setLoading(true);
    // Fetch LLM topics from Delphi endpoint
    net
      .polisGet("/api/v3/delphi", {
        report_id: report_id,
      })
      .then((response) => {
        console.log("Delphi response:", response);

        if (response && response.status === "success") {
          if (response.runs && Object.keys(response.runs).length > 0) {
            // Set the runs data
            setRuns(response.runs);

            // Select the first (most recent) run by default
            const runKeys = Object.keys(response.runs);
            setSelectedRunKey(runKeys[0]);
          } else if (response.available_tables) {
            setError(
              `DynamoDB connected but the required table doesn't exist yet. This is normal until the Delphi pipeline has been run for this conversation.`
            );
          } else if (response.error) {
            setError(`Error: ${response.error}`);
          } else {
            setError("No LLM topic data available yet");
          }
        } else {
          setError("Failed to retrieve LLM topics");
        }

        setLoading(false);
      })
      .catch((err) => {
        console.error("Error fetching LLM topics:", err);
        setError("Failed to connect to the Delphi endpoint");
        setLoading(false);
      });

    // Fetch visualizations from the new endpoint
    setVisualizationsLoading(true);
    net
      .polisGet("/api/v3/delphi/visualizations", {
        report_id: report_id,
      })
      .then((response) => {
        console.log("Visualizations response:", response);

        if (response && response.status === "success" && response.jobs) {
          setVisualizationJobs(response.jobs);
        }

        setVisualizationsLoading(false);
      })
      .catch((err) => {
        console.error("Error fetching visualizations:", err);
        setVisualizationsLoading(false);
      });

    // Fetch topic data from Delphi (same endpoint as TopicReport)
    setTopicDataLoading(true);
    net
      .polisGet("/api/v3/delphi", {
        report_id: report_id,
      })
      .then((response) => {
        console.log("Topic data response:", response);

        if (response && response.status === "success") {
          setTopicData(response);
        }

        setTopicDataLoading(false);
      })
      .catch((err) => {
        console.error("Error fetching topic data:", err);
        setTopicDataLoading(false);
      });

    // Fetch narrative reports from Delphi
    setNarrativeLoading(true);
    net
      .polisGet("/api/v3/delphi/reports", {
        report_id: report_id,
      })
      .then((response) => {
        console.log("Narrative reports response:", response);

        if (response && response.status === "success" && response.reports) {
          setNarrativeReports(response.reports);

          // Store run info
          if (response.available_runs) {
            setNarrativeRunInfo({
              current_job_id: response.current_job_id, // Changed from current_run
              available: response.available_runs,
            });

            // Log available runs info
            if (response.available_runs.length > 1) {
              console.log(
                `Found ${response.available_runs.length} narrative report runs:`,
                response.available_runs
              );
              console.log(
                `Currently showing run for job_id: ${response.current_job_id}`
              );
            }
          }
        }

        setNarrativeLoading(false);
      })
      .catch((err) => {
        console.error("Error fetching narrative reports:", err);
        setNarrativeLoading(false);
      });
  }, [report_id]);

  // Handle job form input changes
  const handleJobFormChange = (e) => {
    const { name, value, type, checked } = e.target;
    setJobFormData((prev) => ({
      ...prev,
      [name]: type === "checkbox" ? checked : value,
    }));
  };

  // Handle job form submission
  const handleJobFormSubmit = (e) => {
    e.preventDefault();
    setIsSubmitting(true);
    setJobCreationResult(null);

    // Send request to create a new job
    net
      .polisPost("/api/v3/delphi/jobs", {
        report_id: report_id,
        ...jobFormData,
      }, authToken)
      .then((response) => {
        console.log("Job creation response:", response);

        if (response && response.status === "success") {
          setJobCreationResult({
            success: true,
            message: `Job created successfully with ID: ${response.job_id}`,
            job_id: response.job_id,
          });
        } else {
          throw new Error(response?.error || "Unknown error creating job");
        }

        // Refresh visualizations list after a slight delay
        setTimeout(() => {
          // Fetch visualizations to get the new job
          net
            .polisGet("/api/v3/delphi/visualizations", {
              report_id: report_id,
            })
            .then((response) => {
              if (response && response.status === "success" && response.jobs) {
                setVisualizationJobs(response.jobs);
              }
            })
            .catch((err) => {
              console.error("Error refreshing visualizations:", err);
            });
        }, 2000);
      })
      .catch((err) => {
        console.error("Error creating job:", err);
        setJobCreationResult({
          success: false,
          message: `Error creating job: ${err.error ||err.message || "Unknown error"}`,
        });
      })
      .finally(() => {
        setIsSubmitting(false);
      });
  };

  // Toggle job form visibility
  const toggleJobForm = () => {
    setJobFormOpen(!jobFormOpen);
    // Reset result message when closing the form
    if (jobFormOpen) {
      setJobCreationResult(null);
    }
  };

  // Handle generate narrative report button click
  const handleGenerateNarrativeReport = () => {
    setBatchReportLoading(true);
    setBatchReportResult(null);

    // Send request to generate batch report
    net
      .polisPost("/api/v3/delphi/batchReports", {
        report_id: report_id,
        model: "claude-opus-4-20250514",
        no_cache: false,
      }, authToken)
      .then((response) => {
        console.log("Batch report response:", response);

        if (response && response.status === "success") {
          setBatchReportResult({
            success: true,
            message: `Batch report generation started. Batch ID: ${response.batch_id || "N/A"}`,
            batch_id: response.batch_id,
          });
        } else {
          throw new Error(response?.error || "Unknown error generating batch report");
        }
      })
      .catch((err) => {
        console.error("Error generating batch report:", err);
        setBatchReportResult({
          success: false,
          message: `Error generating batch report: ${err.message || "Unknown error"}`,
        });
      })
      .finally(() => {
        setBatchReportLoading(false);
      });
  };

  // Get the current selected run data
  const selectedRun = selectedRunKey ? runs[selectedRunKey] : null;

  // Helper function to find the best job to display (prioritize completed jobs with visualizations)
  const getBestVisualizationJob = () => {
    if (!visualizationJobs || visualizationJobs.length === 0) {
      return null;
    }

    // First, try to find a completed job with visualizations
    const completedJobWithViz = visualizationJobs.find(job => 
      job.status === "COMPLETED" && 
      job.visualizations && 
      Array.isArray(job.visualizations) && 
      job.visualizations.length > 0
    );
    
    if (completedJobWithViz) {
      return completedJobWithViz;
    }
    
    // If no completed job with visualizations, return the first job
    return visualizationJobs[0];
  };

  // Get available layers with topic counts from visualization data
  const getAvailableLayers = () => {
    const bestJob = getBestVisualizationJob();
    if (!bestJob || !bestJob.visualizations) {
      return [];
    }

    const layerMap = new Map();
    
    // Get layers from visualizations
    bestJob.visualizations
      .filter((vis) => vis && vis.type === "interactive")
      .forEach((vis) => {
        layerMap.set(vis.layerId, { layerId: vis.layerId, topicCount: 0 });
      });

    // Add topic counts from selected run data
    if (selectedRun && selectedRun.topics_by_layer) {
      Object.keys(selectedRun.topics_by_layer).forEach((layerId) => {
        const numLayerId = parseInt(layerId);
        const topicCount = Object.keys(selectedRun.topics_by_layer[layerId]).length;
        if (layerMap.has(numLayerId)) {
          layerMap.set(numLayerId, { layerId: numLayerId, topicCount });
        }
      });
    }

    return Array.from(layerMap.values()).sort((a, b) => a.layerId - b.layerId);
  };

  const availableLayers = getAvailableLayers();

  // Get available report sections for dropdown - combines topic data and narrative reports  
  const getAvailableReportSections = () => {
    const sections = [];
    
    // If we have topic data, always show sections (with status indicators)
    // This ensures consistent dropdown behavior like TopicReport
    if (topicData && topicData.runs && Object.keys(topicData.runs).length > 0) {
      const latestRun = Object.values(topicData.runs).reduce((latest, run) => {
        return !latest || new Date(run.created_at) > new Date(latest.created_at) ? run : latest;
      }, null);
      
      const jobUuid = latestRun?.job_uuid;

      if (showGlobalSections) {
        // Show global sections - combine topic data with narrative report status
        const globalSectionTypes = [
          { key: 'batch_re_global_groups', title: 'Divisive Comments (Global)' },
          { key: 'batch_re_global_group_informed_consensus', title: 'Cross-Group Consensus (Global)' },
          { key: 'batch_re_global_uncertainty', title: 'High Uncertainty Comments (Global)' }
        ];
        
        globalSectionTypes.forEach(({ key, title }) => {
          // Check what keys actually exist in the narrative reports (same logic as TopicSectionsBuilder)
          const longFormatKey = narrativeRunInfo?.current_job_id ? `${narrativeRunInfo.current_job_id}_global_${key}` : null;
          const shortFormatKey = `global_${key}`;
          
          let sectionKey;
          if (narrativeReports && Object.keys(narrativeReports).length > 0) {
            // Check which format exists in the data
            if (longFormatKey && narrativeReports[longFormatKey]) {
              sectionKey = longFormatKey;
              console.log(`CommentsReport global section ${key}: found long format - ${sectionKey}`);
            } else if (narrativeReports[shortFormatKey]) {
              sectionKey = shortFormatKey;
              console.log(`CommentsReport global section ${key}: found short format - ${sectionKey}`);
            } else if (narrativeReports[key]) {
              sectionKey = key;
              console.log(`CommentsReport global section ${key}: found bare format - ${sectionKey}`);
            } else {
              // Default to short format if no data found
              sectionKey = shortFormatKey;
              console.log(`CommentsReport global section ${key}: no data found, using default - ${sectionKey}`);
            }
          } else {
            sectionKey = shortFormatKey;
            console.log(`CommentsReport global section ${key}: no reports data, using fallback - ${sectionKey}`);
          }
          
          // Check if narrative report exists
          const hasNarrative = !!narrativeReports[sectionKey];
          
          sections.push({
            key: sectionKey,
            title: title + (hasNarrative ? '' : ' (pending narrative)'),
            hasNarrative: !!hasNarrative,
            hasTopicData: true // We know this exists from topic data
          });
        });
      } else {
        // Show topic sections for the selected layer
        if (latestRun.topics_by_layer && latestRun.topics_by_layer[selectedLayer]) {
          const layerTopics = latestRun.topics_by_layer[selectedLayer];
          
          Object.entries(layerTopics).forEach(([clusterId, topic]) => {
            // Extract section key from topic_key, converting # to _ (same logic as TopicReport)
            let sectionKey;
            if (topic.topic_key && topic.topic_key.includes('#')) {
              // Versioned format: convert uuid#layer#cluster -> uuid_layer_cluster
              sectionKey = topic.topic_key.replace(/#/g, '_');
            } else {
              // Fallback: construct from jobUuid
              sectionKey = `${jobUuid}_${selectedLayer}_${clusterId}`;
            }
            
            // Check if narrative report exists
            const hasNarrative = !!narrativeReports[sectionKey];
            
            sections.push({
              key: sectionKey,
              title: topic.topic_name + (hasNarrative ? '' : ' (pending narrative)'),
              hasNarrative: !!hasNarrative,
              hasTopicData: true,
              topicMetadata: topic
            });
          });
        }
      }
    }
    // No fallback needed - we require topic data for consistent behavior
    
    return sections.sort((a, b) => a.title.localeCompare(b.title));
  };

  const availableReportSections = getAvailableReportSections();

  // Auto-select cross-group consensus when available
  React.useEffect(() => {
    if (!selectedReportSection && availableReportSections.length > 0) {
      const crossGroupSection = availableReportSections.find(section => 
        section.title.includes('Cross-Group Consensus')
      );
      if (crossGroupSection) {
        setSelectedReportSection(crossGroupSection.key);
      }
    }
  }, [availableReportSections, selectedReportSection]);

  // Handle report section selection change
  const handleReportSectionChange = (event) => {
    setSelectedReportSection(event.target.value);
  };

  // Render layer switching buttons
  const renderLayerSwitcher = () => {
    return (
      <div className="layer-switcher">
        <h3>Report Type Selection</h3>
        <p className="switcher-description">
          Choose between global insights (cross-cutting themes) or layer-specific topics (granular analysis).
        </p>
        <div className="layer-buttons">
          {/* Global sections button */}
          <button
            className={`layer-button ${showGlobalSections ? 'active' : ''}`}
            onClick={() => {
              setShowGlobalSections(true);
              setSelectedReportSection(""); // Clear selected section when switching
            }}
          >
            Global Insights
            <span className="layer-description"> (Cross-cutting themes)</span>
          </button>
          
          {/* Layer-specific topic buttons */}
          {availableLayers.map((layer) => (
            <button
              key={layer.layerId}
              className={`layer-button ${!showGlobalSections && selectedLayer === layer.layerId ? 'active' : ''}`}
              onClick={() => {
                setShowGlobalSections(false);
                setSelectedLayer(layer.layerId);
                setSelectedReportSection(""); // Clear selected section when switching
              }}
            >
              Layer {layer.layerId}: {layer.topicCount} Topic{layer.topicCount !== 1 ? 's' : ''}
              <span className="layer-description">
                {layer.layerId === 0 ? ' (Finest)' : 
                 layer.layerId === availableLayers[availableLayers.length - 1].layerId ? ' (Coarsest)' : 
                 ' (Medium)'}
              </span>
            </button>
          ))}
        </div>
      </div>
    );
  };

  // Render topic cards for a layer
  const renderTopicCards = (layerId) => {
    if (!selectedRun || !selectedRun.topics_by_layer || !selectedRun.topics_by_layer[layerId]) {
      return <p>No topics found for this layer</p>;
    }

    const layerTopics = selectedRun.topics_by_layer[layerId];
    return (
      <div className="topics-grid">
        {Object.keys(layerTopics).map((clusterId) => {
          const topic = layerTopics[clusterId];
          // Skip topics that are clearly errors (like "Here are the topic labels:")
          if (
            topic.topic_name.toLowerCase().includes("here are the topic") ||
            topic.topic_name.toLowerCase().includes("topic label")
          ) {
            return null;
          }

          return (
            <div key={`${layerId}-${clusterId}`} className="topic-card">
              <h3>{topic.topic_name}</h3>
              <p>Group {clusterId}</p>
              <p className="topic-meta">
                Generated by {topic.model_name} on {topic.created_at.substring(0, 10)}
              </p>
            </div>
          );
        })}
      </div>
    );
  };

  // Render job creation form
  const renderJobCreationForm = () => {
    return (
      <div className="job-creation-form-container">
        <div className="form-header">
          <h3>Create New Delphi Job</h3>
          <button className="close-button" onClick={toggleJobForm} aria-label="Close form">
            &times;
          </button>
        </div>

        {jobCreationResult && (
          <div className={`result-message ${jobCreationResult.success ? "success" : "error"}`}>
            {jobCreationResult.message}
          </div>
        )}

        <form onSubmit={handleJobFormSubmit}>
          <div className="form-group">
            <label htmlFor="job_type">Job Type:</label>
            <select
              id="job_type"
              name="job_type"
              value={jobFormData.job_type}
              onChange={handleJobFormChange}
              disabled={isSubmitting}
            >
              <option value="FULL_PIPELINE">Full Pipeline (PCA + UMAP + Report)</option>
              <option value="PCA">PCA Only</option>
              <option value="UMAP">UMAP Only</option>
              <option value="REPORT">Report Only</option>
            </select>
          </div>

          <div className="form-group">
            <label htmlFor="priority">Priority (0-100):</label>
            <input
              type="number"
              id="priority"
              name="priority"
              min="0"
              max="100"
              value={jobFormData.priority}
              onChange={handleJobFormChange}
              disabled={isSubmitting}
            />
          </div>

          <div className="form-row">
            <div className="form-group">
              <label htmlFor="max_votes">Max Votes (optional):</label>
              <input
                type="number"
                id="max_votes"
                name="max_votes"
                min="0"
                value={jobFormData.max_votes}
                onChange={handleJobFormChange}
                disabled={isSubmitting}
                placeholder="Leave empty for all votes"
              />
            </div>

            <div className="form-group">
              <label htmlFor="batch_size">Batch Size (optional):</label>
              <input
                type="number"
                id="batch_size"
                name="batch_size"
                min="1"
                value={jobFormData.batch_size}
                onChange={handleJobFormChange}
                disabled={isSubmitting}
                placeholder="Default batch size"
              />
            </div>
          </div>

          <div className="form-group">
            <label htmlFor="model">LLM Model:</label>
            <select
              id="model"
              name="model"
              value={jobFormData.model}
              onChange={handleJobFormChange}
              disabled={isSubmitting}
            >
              <option value="claude-opus-4-20250514">Claude Opus 4</option>
              <option value="claude-3-7-sonnet-20250219">Claude 3.7 Sonnet</option>
              <option value="claude-3-5-sonnet-20241022">Claude 3.5 Sonnet</option>
            </select>
          </div>

          <div className="form-group checkbox">
            <label htmlFor="include_topics">
              <input
                type="checkbox"
                id="include_topics"
                name="include_topics"
                checked={jobFormData.include_topics}
                onChange={handleJobFormChange}
                disabled={isSubmitting}
              />
              Generate topic names
            </label>
          </div>

          <div className="form-actions">
            <button type="submit" className="submit-button" disabled={isSubmitting}>
              {isSubmitting ? "Creating Job..." : "Create Job"}
            </button>
          </div>
        </form>
      </div>
    );
  };

  // Render visualization section
  const renderVisualizations = () => {
    if (visualizationsLoading) {
      return <div className="loading">Loading visualizations...</div>;
    }

    return (
      <>
        <div className="section-header-actions">
          <button className="create-job-button" onClick={toggleJobForm}>
            {jobFormOpen ? "Cancel" : "Run New Delphi Analysis"}
          </button>
        </div>

        {jobFormOpen && renderJobCreationForm()}

        {!visualizationJobs ||
        !Array.isArray(visualizationJobs) ||
        visualizationJobs.length === 0 ? (
          <div className="info-message">
            <p>
              No visualizations available yet. Click &quot;Run New Delphi Analysis&quot; to create a new job.
            </p>
          </div>
        ) : (
          <div className="visualizations-container">
            {(() => {
              const bestJob = getBestVisualizationJob();
              return bestJob && (
                <div className="visualization-job">
                  <div className="job-header">
                    <h3>Interactive Topics Visualization (all comments)</h3>
                    <div className="job-meta">
                      <span className={`job-status status-${bestJob.status}`}>
                        {bestJob.status}
                      </span>
                      <span className="job-date">
                        Created: {new Date(bestJob.createdAt).toLocaleString()}
                      </span>
                    </div>
                  </div>

                  {bestJob.visualizations &&
                  Array.isArray(bestJob.visualizations) &&
                  bestJob.visualizations.length > 0 ? (
                  <div className="visualizations-grid">
                    {/* Show selected layer visualization */}
                    {bestJob.visualizations
                      .filter((vis) => vis && vis.type === "interactive" && vis.layerId === selectedLayer)
                      .map((vis) => (
                        <div key={vis.key} className="visualization-card">
                          <h4>Layer {vis.layerId} Interactive Visualization</h4>
                          <div className="iframe-container">
                            <iframe
                              src={vis.url}
                              title={`Layer ${vis.layerId} visualization`}
                              width="100%"
                              height="800"
                              frameBorder="0"
                            ></iframe>
                          </div>
                        </div>
                      ))}

                    {bestJob.visualizations
                      .filter(
                        (vis) =>
                          vis &&
                          (vis.type === "static_png" || vis.type === "presentation_png") &&
                          vis.layerId === selectedLayer
                      )
                      .map((vis) => (
                        <div key={vis.key} className="visualization-card">
                          <h4>Layer {vis.layerId} Static Visualization</h4>
                          <div className="img-container">
                            <img
                              src={vis.url}
                              alt={`Layer ${vis.layerId} visualization`}
                              width="100%"
                            />
                          </div>
                        </div>
                      ))}
                  </div>
                ) : (
                  <div className="no-visualizations-message">
                    <p>No visualizations available for this job yet.</p>
                    <p className="help-text">
                      Visualizations may take a few minutes to generate. You can refresh the page to
                      check for updates.
                    </p>
                  </div>
                )}
                </div>
              );
            })()}
          </div>
        )}
      </>
    );
  };

  // Render narrative reports section with dropdown
  const renderNarrativeReports = () => {
    if (narrativeLoading && topicDataLoading) {
      return <div className="loading">Loading topic and narrative data...</div>;
    }

    const availableSections = getAvailableReportSections();
    const hasAnyData = availableSections.length > 0;

    if (!hasAnyData) {
      return (
        <div className="info-message">
          <p>
            No topic or narrative data available yet. Run a Delphi analysis to generate topics and narratives.
          </p>
        </div>
      );
    }

    return (
      <div className="narrative-reports-container">
        {narrativeRunInfo &&
            narrativeRunInfo.available &&
            narrativeRunInfo.available.length > 0 && (
              <div className="run-info-banner">
                <p>
                  Showing reports for Job ID:{" "}
                  <strong>{narrativeRunInfo.current_job_id}</strong>
                  {(() => {
                    const currentRunDetails = narrativeRunInfo.available.find(
                      (run) => run.job_id === narrativeRunInfo.current_job_id
                    );
                    if (currentRunDetails && currentRunDetails.latest_timestamp) {
                      return ` (Generated: ${new Date(
                        currentRunDetails.latest_timestamp
                      ).toLocaleString()})`;
                    }
                    return "";
                  })()}
                  . ({narrativeRunInfo.available.length} run
                  {narrativeRunInfo.available.length !== 1 ? "s" : ""} available - showing most
                  recent)
                </p>
              </div>
            )}
        {/* Report section dropdown with enhanced status indicators */}
        <div className="report-selector">
          <select 
            value={selectedReportSection} 
            onChange={handleReportSectionChange}
          >
            <option value="">Select a report section...</option>
            {availableSections.map(section => (
              <option key={section.key} value={section.key}>
                {section.title}
              </option>
            ))}
          </select>
          
          {/* Status summary */}
          <div className="section-status-summary">
            <span className="status-indicator">
              {availableSections.filter(s => s.hasTopicData).length} topics identified
            </span>
            <span className="status-indicator">
              {availableSections.filter(s => s.hasNarrative).length} narratives generated
            </span>
          </div>
        </div>

        {/* Render selected report */}
        {selectedReportSection && renderSelectedReport()}
      </div>
    );
  };

  // Render the selected report section
  const renderSelectedReport = () => {
    const availableSections = getAvailableReportSections();
    const selectedSection = availableSections.find(s => s.key === selectedReportSection);
    
    if (!selectedSection) return null;

    const report = narrativeReports[selectedReportSection];
    const sectionTitle = selectedSection.title;

    return (
      <div key={selectedReportSection} className="report-section">
        <h3>{sectionTitle}</h3>
        
        {/* Enhanced metadata section showing both topic and narrative info */}
        <div className="report-metadata">
          <div className="metadata-row">
            <span className="metadata-label">Topic Status:</span>
            <span className={`status-badge ${selectedSection.hasTopicData ? 'available' : 'missing'}`}>
              {selectedSection.hasTopicData ? 'Identified' : 'Not Available'}
            </span>
          </div>
          <div className="metadata-row">
            <span className="metadata-label">Narrative Status:</span>
            <span className={`status-badge ${selectedSection.hasNarrative ? 'available' : 'pending'}`}>
              {selectedSection.hasNarrative ? 'Generated' : 'Pending'}
            </span>
          </div>
          {report && (
            <div className="metadata-row">
              <span className="metadata-label">Generated:</span>
              <span>{new Date(report.timestamp).toLocaleString()}</span>
              <span> | Model: {report.model || "N/A"}</span>
            </div>
          )}
          {selectedSection.topicMetadata && (
            <div className="metadata-row">
              <span className="metadata-label">Topic Info:</span>
              <span>Generated by {selectedSection.topicMetadata.model_name} on {selectedSection.topicMetadata.created_at?.substring(0, 10)}</span>
            </div>
          )}
        </div>
        <div className="report-content">
          {(() => {
            // Show narrative content if available
            if (report && report.report_data) {
              if (report.errors)
              return (
                <p>Not enough data has been provided for analysis, please check back later</p>
              );

            if (
              typeof report.report_data !== "string" ||
              !report.report_data.trim().startsWith("{") ||
              !report.report_data.trim().endsWith("}")
            ) {
              return (
                <article style={{ maxWidth: "600px" }}>
                  <h5>Report data is not in the expected JSON format.</h5>
                  <pre style={{ whiteSpace: "pre-wrap", wordBreak: "break-all" }}>
                    {report.report_data}
                  </pre>
                </article>
              );
            }

            try {
              const respData = JSON.parse(jsonrepair(report.report_data));

              const extractCitationsForThisSection = (data) => {
                const collectedCitations = [];

                if (data?.paragraphs) {
                  data.paragraphs.forEach((paragraph) => {
                    if (paragraph?.sentences) {
                      paragraph.sentences.forEach((sentence) => {
                        if (sentence?.clauses) {
                          sentence.clauses.forEach((clause) => {
                            if (clause?.citations && Array.isArray(clause.citations)) {
                              clause.citations.forEach((citation) => {
                                if (typeof citation === "number") {
                                  collectedCitations.push(citation);
                                }
                              });
                            }
                          });
                        }
                      });
                    }
                  });
                }
                return [...new Set(collectedCitations)];
              };

              const sectionCitationIds = extractCitationsForThisSection(respData);

              return (
                <div className="narrative-layout-container">
                  <article className="narrative-text-content">
                    {respData?.paragraphs?.map((pSection) => (
                      <div key={pSection.id}>
                        <h5>{pSection.title}</h5>
                        {pSection.sentences.map((sentence, idx) => (
                          <p key={idx}>
                            {sentence.clauses.map((clause, cIdx) => (
                              <span key={cIdx}>
                                {clause.text}
                                {clause.citations
                                  ?.filter((c) => typeof c === "number")
                                  .map((citation, citIdx, arr) => (
                                    <sup key={citIdx}>
                                      {citation}
                                      {citIdx < arr.length - 1 ? ", " : ""}
                                    </sup>
                                  ))}
                                {cIdx < sentence.clauses.length - 1 ? " " : ""}
                              </span>
                            ))}
                          </p>
                        ))}
                      </div>
                    ))}
                  </article>

                  {sectionCitationIds.length > 0 && (
                    <div className="narrative-comments-column">
                      <h5>Referenced Comments</h5>
                      <CommentList
                        conversation={conversation}
                        ptptCount={ptptCount}
                        math={math}
                        formatTid={formatTid}
                        tidsToRender={sectionCitationIds}
                        comments={comments}
                        voteColors={voteColors}
                      />
                    </div>
                  )}
                </div>
              );
            } catch (error) {
              console.error(
                `[${selectedReportSection}] Error processing narrative report section:`,
                error,
                "Report data was:",
                report.report_data
              );
              return (
                <article style={{ maxWidth: "600px" }}>
                  <h5>An error occurred while processing this report section.</h5>
                  <pre>{error.message}</pre>
                  <p>Problematic data for section {selectedReportSection}:</p>
                  <pre style={{ whiteSpace: "pre-wrap", wordBreak: "break-all" }}>
                    {report.report_data}
                  </pre>
                </article>
              );
            }
            } else if (selectedSection.hasTopicData && !selectedSection.hasNarrative) {
              // Show topic metadata when narrative is not yet available
              return (
                <div className="topic-preview">
                  <h5>Topic Identified - Narrative Pending</h5>
                  <p>This topic has been identified and named by Polis, but the detailed narrative report has not yet been generated.</p>
                  
                  {selectedSection.topicMetadata && (
                    <div className="topic-metadata-display">
                      <h6>Topic Information:</h6>
                      <p><strong>Name:</strong> {selectedSection.topicMetadata.topic_name}</p>
                      <p><strong>Generated by:</strong> {selectedSection.topicMetadata.model_name}</p>
                      <p><strong>Created:</strong> {selectedSection.topicMetadata.created_at}</p>
                      
                      {selectedSection.topicMetadata.sample_comments && selectedSection.topicMetadata.sample_comments.length > 0 && (
                        <div className="sample-comments">
                          <h6>Sample Comments:</h6>
                          <ul>
                            {selectedSection.topicMetadata.sample_comments.slice(0, 3).map((comment, idx) => (
                              <li key={idx}>{comment}</li>
                            ))}
                          </ul>
                        </div>
                      )}
                    </div>
                  )}
                  
                  <div className="action-hint">
                    <p>To generate the narrative report, use the &quot;Generate Batch Topics&quot; button above.</p>
                  </div>
                </div>
              );
            } else {
              // No data available
              return (
                <div className="no-data">
                  <p>No data available for this section.</p>
                </div>
              );
            }
          })()}
        </div>
      </div>
    );
  };

  return (
    <div className="comments-report">
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          borderBottom: "1px solid #ccc",
          marginBottom: 20,
          paddingBottom: 10,
        }}
      >
        <h1>Comments Report</h1>
        <div>Report ID: {report_id}</div>
      </div>

      {loading ? (
        <div className="loading">Loading LLM topics data...</div>
      ) : error ? (
        <div className="error-message">
          <h3>Not Available Yet</h3>
          <p>{error}</p>
          <p>
            The Delphi system needs to process this conversation with LLM topic generation before
            this report will be available.
          </p>
          <div className="section-header-actions" style={{ marginTop: "20px" }}>
            <button className="create-job-button" onClick={toggleJobForm}>
              {jobFormOpen ? "Cancel" : "Run New Delphi Analysis"}
            </button>
          </div>

          {jobFormOpen && showControls && renderJobCreationForm()}
        </div>
      ) : (
        <div className="report-content">
          {/* Action buttons at the top */}
          {showControls && (
            <div className="section">
              <h2>Analysis Actions</h2>
              <div className="action-buttons-grid">
                <div className="action-button-group">
                  <h3>Data Processing</h3>
                  <div className="section-header-actions">
                    <button className="create-job-button" onClick={toggleJobForm}>
                      {jobFormOpen ? "Cancel" : "Run New Delphi Analysis"}
                    </button>
                  </div>
                  {jobFormOpen && renderJobCreationForm()}
                </div>
                
                <div className="action-button-group">
                  <h3>Narrative Generation</h3>
                  <div className="section-header-actions">
                    <button
                      className="batch-report-button"
                      onClick={handleGenerateNarrativeReport}
                      disabled={batchReportLoading}
                    >
                      {batchReportLoading ? "Generating..." : "Generate Batch Topics"}
                    </button>
                  </div>
                  {batchReportResult && (
                    <div className={`result-message ${batchReportResult.success ? "success" : "error"}`}>
                      {batchReportResult.message}
                    </div>
                  )}
                </div>
              </div>
            </div>
          )}

          <div className="section">
            <h2>Topic Visualizations</h2>
            <p className="info-text">
              These visualizations show the spatial relationships between topics and comments.
              Similar comments are positioned closer together on the map.
            </p>
            {renderLayerSwitcher()}
            {renderVisualizations()}
          </div>

          <div className="section">
            <h2>Narrative Report</h2>
            <p className="info-text">
              This narrative report provides insights about group consensus, differences, and key
              topics in the conversation.
            </p>
            {renderNarrativeReports()}
          </div>

          {/* Topics section moved to bottom */}
          <div className="section">
            <div className="run-info">
              <div className="run-header">
                <h2>
                  Group Topics{" "}
                  <span style={{ fontWeight: "normal", fontSize: "0.8em" }}>
                    generated by {selectedRun?.model_name}
                  </span>
                </h2>
                <p className="generated-date">Generated on {selectedRun?.created_date}</p>
              </div>

              <p className="info-text">
                These are LLM-generated topic names based on the comments in each group. The
                algorithm has analyzed the content of comments to extract the main themes.
              </p>

              {selectedRun?.topics_by_layer && selectedRun.topics_by_layer[selectedLayer] && (
                <div className="layer-section">
                  <h2>Group Themes - Layer {selectedLayer}</h2>
                  {renderTopicCards(selectedLayer)}
                </div>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default CommentsReport;
