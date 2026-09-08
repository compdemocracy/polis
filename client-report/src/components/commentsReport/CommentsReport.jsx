import React, { useState, useEffect, useRef, SetStateAction } from "react";
import { jsonrepair } from "jsonrepair";
import net from "../../util/net";
import { useReportId } from "../framework/useReportId";
import CommentList from "../lists/commentList.jsx";
import { jwtDecode } from "jwt-decode"
import "./CommentsReport.css";

const decodedJwt = (token) => {
  if (token) {
    return jwtDecode(token)
  }
  return null
}

const hasDelphiEnabled = (token) => {
  const decoded = decodedJwt(token);
  return decoded && decoded[`${process.env.AUTH_NAMESPACE}delphi_enabled`]
}

// Durable Delphi job states in which work is still outstanding.
//
// PENDING is the one this component used to be blind to: the job is queued and
// no worker has claimed it. That is the ordinary state during a cold start, and
// rendering only PROCESSING meant a queued job looked like nothing had
// happened, which is what pushed people into submitting the same report twice.
// The others mirror delphi/scripts/job_poller.py and 803_check_batch_status.py.
const QUEUED_JOB_STATUS = "PENDING";
const ACTIVE_JOB_STATUSES = [
  QUEUED_JOB_STATUS,
  "PROCESSING",
  "AWAITING_RECHECK",
  "LOCKED_FOR_CHECKING",
];

// Only these two mean a job row is durably finished. Anything else — including
// "unknown", which the visualizations endpoint returns for a row with no status
// — is uncertainty and must not be read as completion.
const TERMINAL_JOB_STATUSES = ["COMPLETED", "FAILED"];
const isTerminalJobStatus = (status) =>
  TERMINAL_JOB_STATUSES.includes(status);

const isBatchReportJob = (job) => Boolean(job?.jobId?.includes("batch_report_"));

// A listed job is worth adopting if its own status says it is running, or if
// the server says work is still outstanding under it. The second half matters
// on reload: a COMPLETED root whose checker is still going is reported
// `workLive: true`, and ignoring that loses the banner and the polling for
// exactly the case the server went to the trouble of computing.
const isListedJobLive = (job) =>
  ACTIVE_JOB_STATUSES.includes(job?.status) || responseWorkLive(job) === true;

const findActiveJob = (jobs, wantBatch) =>
  (jobs || []).find(
    (job) => isListedJobLive(job) && isBatchReportJob(job) === wantBatch
  ) || null;

// The server's per-job effective-work answer, when the response carried one.
// `undefined` means this response cannot speak to it. The server computes it
// from a strongly-read sweep, so a `false` is evidence, not an index artefact.
const responseWorkLive = (job) =>
  typeof job?.workLive === "boolean"
    ? job.workLive
    : typeof job?.work_live === "boolean"
      ? job.work_live
      : undefined;

// A tracked job is worth polling unless it is durably finished *and* the server
// says nothing is outstanding under it. Anything the client cannot classify —
// "unknown" from a row with no status, a status this build does not know — is
// uncertainty, and uncertainty means keep watching.
export const isTrackedJobLive = (tracked) =>
  Boolean(tracked) &&
  (!isTerminalJobStatus(tracked.status) || Boolean(tracked.workLive));

/**
 * Reconcile a tracked job against a fresh durable job list.
 *
 * The acknowledged job id is resolved first and only ever replaced by its own
 * durable record. Absence from the list is uncertainty — the list is read
 * through an eventually consistent index — so an acknowledged job that is not
 * listed is kept, not dropped. Only once the acknowledged job is durably
 * finished do we look for other work of the same kind, so a queued job A is
 * never silently swapped for an unrelated running job B.
 */
export const reconcileTrackedJob = (previous, jobs, wantBatch, reportId) => {
  const list = jobs || [];
  const adopt = () => {
    const active = findActiveJob(list, wantBatch);
    if (!active) {
      return null;
    }
    return {
      jobId: active.jobId,
      status: active.status,
      // A job picked up after a reload starts with whatever the server says.
      workLive: responseWorkLive(active) ?? true,
      reportId,
    };
  };

  // State belongs to one report; a report change starts over.
  if (!previous || previous.reportId !== reportId) {
    return adopt();
  }

  const durable = list.find((job) => job?.jobId === previous.jobId);
  if (!durable) {
    // Absence is uncertainty: this list comes from an eventually consistent
    // index, so a job it does not mention has not been shown to be finished.
    return previous;
  }
  // Every reconcile refreshes the liveness flag from this response, so an
  // optimistic `true` set at submission time can actually clear. Where the
  // response says nothing, an unfinished status is live and a terminal one
  // inherits the previous answer.
  const reported = responseWorkLive(durable);
  if (!isTerminalJobStatus(durable.status)) {
    // Includes "unknown" and any status this client does not recognise.
    return {
      jobId: durable.jobId,
      status: durable.status,
      workLive: reported ?? true,
      reportId,
    };
  }
  const stillLive = reported ?? previous.workLive;
  // The acknowledged job is durably terminal. Any live child or successor shows
  // up as its own row, so hand over rather than stopping while work remains.
  const successor = adopt();
  if (successor) {
    return successor;
  }
  // Nothing else is listed. If work is still outstanding under this job — a
  // completed root whose checker has not surfaced yet — keep watching rather
  // than declaring it done on the strength of one index read.
  return stillLive
    ? { jobId: durable.jobId, status: durable.status, workLive: true, reportId }
    : null;
};

const CommentsReport = ({ math, comments, conversation, ptptCount, formatTid, voteColors, showControls = true, authToken, reportModLevel }) => {
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
  const jobFormData = {
    job_type: "FULL_PIPELINE",
    priority: 50,
    include_moderation: reportModLevel !== -2,
  };
  const [isSubmitting, setIsSubmitting] = useState(false);
  // { jobId, status } for the outstanding pipeline job, taken from durable job
  // state so it survives a reload rather than living only in this component.
  const [activeJob, setActiveJob] = useState(null);
  // Batch narrative jobs are acknowledged and polled separately: they are
  // excluded from the pipeline selector, so without their own slot a batch
  // submission gained no polling loop at all.
  const [activeBatchJob, setActiveBatchJob] = useState(null);
  const [jobCreationResult, setJobCreationResult] = useState(null);
  const [batchReportLoading, setBatchReportLoading] = useState(false);
  const [batchReportResult, setBatchReportResult] = useState(null);
  const [selectedLayer, setSelectedLayer] = useState(0);
  const [selectedReportSection, setSelectedReportSection] = useState("");
  const [showGlobalSections, setShowGlobalSections] = useState(false);
  const [processedLogs, setProcessedLogs] = useState(undefined);
  const [confirmDelphiRunModalVisible, setConfirmDelphiRunModalVisible] = useState(false);
  // The report this component is currently tracking. Every asynchronous
  // continuation compares against this ref rather than against the `report_id`
  // captured in its own closure: after a report change, an old render's
  // callback still sees old === old and would happily install stale state.
  const trackedReportRef = useRef(report_id);

  const DelphiModal = () => {
    return confirmDelphiRunModalVisible ? (
      <div style={{
        position: "fixed",
        top: 0,
        left: 0,
        width: "100%",
        height: "100%",
        zIndex: 1000,
        backgroundColor: "rgba(0, 0, 0, 0.5)",
        display: "flex",
        justifyContent: "center",
        alignItems: "center",
        flexDirection: "column"
      }}>
        <div style={{ backgroundColor: "#fff", padding: "1em", borderRadius: "8px", maxWidth: "400px", flexDirection: "column", alignItems: "center", }}>
          <div style={{ display: "flex", justifyContent: "space-between", flexDirection: "column" }}>
            {hasDelphiEnabled(authToken) ? (
              <>
                <h4>Are you sure you want to run a new Delphi analysis? This will erase previous results, and may take several minutes.</h4>
                <button style={{ marginBottom: "1em", color: "#fff", backgroundColor: "#f44336", padding: "8px 16px", cursor: "pointer", border: "0", borderRadius: "4px", fontWeight: "bold" }} onClick={() => setConfirmDelphiRunModalVisible(false)}>Cancel</button>
                <button className="batch-report-button" onClick={confirmDelphiRunModalVisible === "batch" ? handleGenerateNarrativeReport : handleJobFormSubmit}>Run Analysis</button> {/* eslint-disable-line quotes */}
              </>
              ) : (
              <p>
                Discover more with Delphi - advanced data analysis and AI - Upgrade at <a target="_blank" rel="noreferrer" href="https://pro.pol.is">pro.pol.is</a> to run a new analysis.
                <button style={{ marginTop: "1em", color: "#fff", backgroundColor: "#4caf50", padding: "8px 16px", cursor: "pointer", border: "0", borderRadius: "4px", fontWeight: "bold" }} onClick={() => setConfirmDelphiRunModalVisible(false)}>Close</button>
              </p>
            )}
          </div>
        </div>
      </div>
      ) : null;
  };

  // Point the ref at the current report before anything can resolve against
  // it, and drop state belonging to the report we just left.
  useEffect(() => {
    trackedReportRef.current = report_id;
    setActiveJob(null);
    setActiveBatchJob(null);
    setVisualizationJobs([]);
    setProcessedLogs(undefined);
    setJobCreationResult(null);
    setBatchReportResult(null);
    // A submission still in flight for the previous report will not clear these
    // any more, so the report change has to.
    setIsSubmitting(false);
    setBatchReportLoading(false);
    setConfirmDelphiRunModalVisible(false);
  }, [report_id]);

  useEffect(() => {
    if (!report_id) return;

    setLoading(true);
    // Fetch LLM topics from Delphi endpoint
    net
      .polisGet("/api/v3/delphi", {
        report_id: report_id,
      })
      .then((response) => {

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

        if (response && response.status === "success" && response.jobs) {
          applyJobsFromResponse(response.jobs, report_id);
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

        if (response && response.status === "success" && response.reports) {
          setNarrativeReports(response.reports);

          // Store run info
          if (response.available_runs) {
            setNarrativeRunInfo({
              current_job_id: response.current_job_id, // Changed from current_run
              available: response.available_runs,
            });
          }
        }

        setNarrativeLoading(false);
      })
      .catch((err) => {
        console.error("Error fetching narrative reports:", err);
        setNarrativeLoading(false);
      });
  }, [report_id]);

  // Reconcile both tracked jobs against a fresh durable list. Responses that
  // arrive for a different report than the one now on screen are dropped, so a
  // late reply cannot install another report's job.
  function applyJobsFromResponse(jobs, forReportId) {
    if (forReportId !== trackedReportRef.current) {
      return;
    }
    setVisualizationJobs(jobs);
    setActiveJob((previous) =>
      reconcileTrackedJob(previous, jobs, false, forReportId)
    );
    setActiveBatchJob((previous) =>
      reconcileTrackedJob(previous, jobs, true, forReportId)
    );
  }

  // Poll while either kind of job is outstanding, bound to the acknowledged
  // ids rather than to whatever happens to be running when the timer fires.
  useEffect(() => {
    if (!isTrackedJobLive(activeJob) && !isTrackedJobLive(activeBatchJob)) {
      return undefined;
    }
    const pollReportId = report_id;
    const pipelineJobId = activeJob?.jobId;
    const timer = setInterval(
      () => pollJobState(pollReportId, pipelineJobId),
      30000
    );
    return () => clearInterval(timer);
  }, [activeJob?.jobId, activeBatchJob?.jobId, report_id]);

  const pollJobState = (pollReportId, pipelineJobId) => {
    // Refresh the durable status so PENDING flips to Processing when a worker
    // claims the job, and clears when it finishes.
    net
      .polisGet("/api/v3/delphi/visualizations", { report_id: pollReportId })
      .then((response) => {
        if (response && response.status === "success" && response.jobs) {
          applyJobsFromResponse(response.jobs, pollReportId);
        }
      })
      .catch((err) => {
        console.error("Error refreshing Delphi job state:", err);
      });

    if (!pipelineJobId) {
      return;
    }
    net.polisGet("/api/v3/delphi/logs", { job_id: pipelineJobId }, authToken)
      .then(response => {
        if (pollReportId !== trackedReportRef.current) return;
        setProcessedLogs(response);
        const isFinished = response?.find(m => m.message.includes("Results stored in DynamoDB for conversation"));
        if (isFinished) {
          setActiveJob(null);
          window.location.reload();
        }
      })
      .catch((err) => {
        console.error("Error fetching Delphi job logs:", err);
      });
  };

  // Handle job form submission
  const handleJobFormSubmit = (e) => {
    e.preventDefault();
    const submittedForReportId = report_id;
    setIsSubmitting(true);
    setJobCreationResult(null);

    // Send request to create a new job
    net
      .polisPost("/api/v3/delphi/jobs", {
        report_id: report_id,
        ...jobFormData,
      }, authToken)
      .then((response) => {

        if (submittedForReportId !== trackedReportRef.current) {
          // The user moved to another report while this was in flight. Its
          // result belongs to the report that asked for it, not to this one.
          return;
        }
        if (response && response.status === "success") {
          // The server deduplicates on an active (conversation, report,
          // job type) scope, so a resubmit after a reload comes back as the job
          // that is already queued rather than a second paid run. Say so
          // instead of claiming a new job was created.
          setJobCreationResult({
            success: true,
            message: response.deduplicated
              ? `This report already has a job in progress (ID: ${response.job_id}); reusing it rather than starting another run.`
              : `Job created successfully with ID: ${response.job_id}`,
            job_id: response.job_id,
            deduplicated: Boolean(response.deduplicated),
          });
          setActiveJob({
            jobId: response.job_id,
            status: response.job_status || QUEUED_JOB_STATUS,
            // The root can be COMPLETED while a checker child of it still
            // runs; work_live is the server's answer to "keep polling?".
            workLive: response.work_live !== false,
            reportId: submittedForReportId,
          });
        } else {
          throw new Error(response?.error || "Unknown error creating job");
        }

        // Refresh visualizations list after a slight delay
        setTimeout(() => {
          // Fetch visualizations to get the new job
          net
            .polisGet("/api/v3/delphi/visualizations", {
              report_id: submittedForReportId,
            })
            .then((response) => {
              if (response && response.status === "success" && response.jobs) {
                applyJobsFromResponse(response.jobs, submittedForReportId);
              }
            })
            .catch((err) => {
              console.error("Error refreshing visualizations:", err);
            });
        }, 2000);
      })
      .catch((err) => {
        console.error("Error creating job:", err);
        if (submittedForReportId !== trackedReportRef.current) return;
        setJobCreationResult({
          success: false,
          message: `Error creating job: ${err.error ||err.message || "Unknown error"}`,
        });
      })
      .finally(() => {
        if (submittedForReportId !== trackedReportRef.current) return;
        setIsSubmitting(false);
        // The queued/processing state no longer replaces the whole report, so
        // the confirmation modal has to be dismissed explicitly.
        setConfirmDelphiRunModalVisible(false);
      });
  };

  // Handle generate narrative report button click
  const handleGenerateNarrativeReport = () => {
    const submittedForReportId = report_id;
    setBatchReportLoading(true);
    setBatchReportResult(null);

    // Send request to generate batch report
    net
      .polisPost("/api/v3/delphi/batchReports", {
        report_id: report_id,
        no_cache: false,
        include_moderation: reportModLevel !== -2,
      }, authToken)
      .then((response) => {

        if (submittedForReportId !== trackedReportRef.current) {
          return;
        }
        if (response && response.status === "success") {
          setBatchReportResult({
            success: true,
            message: response.deduplicated
              ? `A batch report job is already outstanding for this report (ID: ${response.batch_id || response.job_id}); reusing it rather than starting another run.`
              : `Batch report generation started. Batch ID: ${response.batch_id || "N/A"}`,
            batch_id: response.batch_id,
            deduplicated: Boolean(response.deduplicated),
          });
          // Acknowledge the batch job so it gets the same polling loop and
          // banner as a pipeline job; without this a batch-only submission was
          // never polled at all.
          setActiveBatchJob({
            jobId: response.batch_id || response.job_id,
            status: response.job_status || QUEUED_JOB_STATUS,
            workLive: response.work_live !== false,
            reportId: submittedForReportId,
          });
        } else {
          throw new Error(response?.error || response?.message || "Unknown error generating batch report");
        }
      })
      .catch((err) => {
        console.error("Error generating batch report:", err);
        if (submittedForReportId !== trackedReportRef.current) return;
        setBatchReportResult({
          success: false,
          message: `Error generating batch report: ${err.message || "Unknown error"}`,
        });
      })
      .finally(() => {
        if (submittedForReportId !== trackedReportRef.current) return;
        setBatchReportLoading(false);
        setConfirmDelphiRunModalVisible(false);
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
        const globalSectionTypes = [ // eslint-disable-line quotes
          { key: "batch_re_global_groups", title: "Divisive Comments (Global)" },
          { key: "batch_re_global_group_informed_consensus", title: "Cross-Group Consensus (Global)" },
          { key: "batch_re_global_uncertainty", title: "High Uncertainty Comments (Global)" }
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
            } else if (narrativeReports[shortFormatKey]) {
              sectionKey = shortFormatKey;
            } else if (narrativeReports[key]) {
              sectionKey = key;
            } else {
              // Default to short format if no data found
              sectionKey = shortFormatKey;
            }
          } else {
            sectionKey = shortFormatKey;
          }
          
          // Check if narrative report exists
          const hasNarrative = !!narrativeReports[sectionKey];
          
          sections.push({
            key: sectionKey,
            title: title + (hasNarrative ? "" : " (pending narrative)"),
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
            if (topic.topic_key && topic.topic_key.includes("#")) {
              // Versioned format: convert uuid#layer#cluster -> uuid_layer_cluster // eslint-disable-line quotes
              sectionKey = topic.topic_key.replace(/#/g, '_');
            } else {
              // Fallback: construct from jobUuid
              sectionKey = `${jobUuid}_${selectedLayer}_${clusterId}`;
            }
            
            // Check if narrative report exists
            const hasNarrative = !!narrativeReports[sectionKey];
            
            sections.push({
              key: sectionKey,
              title: topic.topic_name + (hasNarrative ? "" : " (pending narrative)"),
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
  useEffect(() => {
    if (!selectedReportSection && availableReportSections.length > 0) {
      const crossGroupSection = availableReportSections.find(section => 
        section.title.includes("Cross-Group Consensus")
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

  // Render the outstanding-job banner.
  //
  // This replaces a full-screen takeover that only recognised PROCESSING. It is
  // rendered above whatever the report already has, so a run that is queued or
  // in flight never hides results from the previous run, and a queued job is
  // reported honestly instead of looking like nothing happened.
  const renderTrackedJobBanner = (tracked, { testId, label, showLogs }) => {
    if (!isTrackedJobLive(tracked)) {
      return null;
    }
    const queued = tracked.status === QUEUED_JOB_STATUS;
    // A terminal status with work still live means the root finished but a
    // checker child of it is running; say that rather than "Queued".
    const terminalWithLiveChild =
      !ACTIVE_JOB_STATUSES.includes(tracked.status) && tracked.workLive;
    let heading = "Processing";
    let detail =
      "A worker is running this analysis. Anything already on this page stays available until it finishes.";
    if (queued) {
      heading = "Queued — waiting for a worker";
      detail =
        "This analysis is queued. No worker has picked it up yet, and one may still be starting up. Anything already on this page stays available until the new run finishes.";
    } else if (terminalWithLiveChild) {
      heading = "Finishing up";
      detail =
        "The main run has finished and a follow-up step is still outstanding. Anything already on this page stays available until it completes.";
    }
    return (
      <div className="job-status-banner" data-testid={testId}>
        <h3>
          {label}
          {label ? ": " : ""}
          {heading}
        </h3>
        <p>{detail}</p>
        <p className="job-status-id">Job ID: {tracked.jobId}</p>
        {showLogs && !queued && (
          <pre className="log-output">
            <code>
              {processedLogs?.map((l, index) => (
                <div key={l.timestamp || index} className="log-line">
                  {l.message}
                </div>
              ))}
            </code>
          </pre>
        )}
      </div>
    );
  };

  const renderJobStatusBanner = () => (
    <>
      {renderTrackedJobBanner(activeJob, {
        testId: "delphi-job-status",
        label: "",
        showLogs: true,
      })}
      {renderTrackedJobBanner(activeBatchJob, {
        testId: "delphi-batch-job-status",
        label: "Batch topics",
        showLogs: false,
      })}
    </>
  );

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
            className={`layer-button ${showGlobalSections ? "active" : ""}`}
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
              className={`layer-button ${!showGlobalSections && selectedLayer === layer.layerId ? "active" : ""}`}
              onClick={() => {
                setShowGlobalSections(false);
                setSelectedLayer(layer.layerId);
                setSelectedReportSection(""); // Clear selected section when switching
              }}
            >
              Layer {layer.layerId}: {layer.topicCount} Topic{layer.topicCount !== 1 ? 's' : ''}
              <span className="layer-description"> {/* eslint-disable-line quotes */}
                {layer.layerId === 0 ? " (Finest)" : 
                 layer.layerId === availableLayers[availableLayers.length - 1].layerId ? " (Coarsest)" : 
                 " (Medium)"}
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

  // Render visualization section
  const renderVisualizations = () => {
    if (visualizationsLoading) {
      return <div className="loading">Loading visualizations...</div>;
    }

    return (
      <>
        <div className="section-header-actions">
          <button className="create-job-button" onClick={() => setConfirmDelphiRunModalVisible(true)}>
            Run New Delphi Analysis
          </button>
        </div>

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
                      ).toLocaleString()})`; // eslint-disable-line quotes
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
            <option value="">Select a report section...</option> {/* eslint-disable-line quotes */}
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
            <span className={`status-badge ${selectedSection.hasTopicData ? "available" : "missing"}`}>
              {selectedSection.hasTopicData ? "Identified" : "Not Available"}
            </span>
          </div>
          <div className="metadata-row">
            <span className="metadata-label">Narrative Status:</span>
            <span className={`status-badge ${selectedSection.hasNarrative ? "available" : "pending"}`}>
              {selectedSection.hasNarrative ? "Generated" : "Pending"}
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

            // Only bail out early on data that isn't JSON-ish at all. Don't require a
            // trailing "}" here — responses truncated by max_tokens (e.g. from adaptive
            // thinking eating into the token budget) are missing their closing brackets,
            // and jsonrepair below can usually recover a valid partial object from those.
            if (
              typeof report.report_data !== "string" ||
              !report.report_data.trim().startsWith("{")
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

  if (loading) {
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
        <div className="loading">Loading LLM topics data...</div>
      </div>
    )
  }

  if (error) {
    console.log(error)
    return (
      <div className="comments-report">
        <DelphiModal />
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
        {renderJobStatusBanner()}
        <div className="error-message">
          <h3>Not Available Yet</h3>
          <p>{error}</p>
          <p>
            The Delphi system needs to process this conversation with LLM topic generation before
            this report will be available.
          </p>
          <div className="section-header-actions" style={{ marginTop: "20px" }}>
            <button
              className="create-job-button"
              onClick={() => setConfirmDelphiRunModalVisible(true)}
              disabled={isTrackedJobLive(activeJob)}
            >
              Run New Delphi Analysis
            </button>
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className="comments-report">
      <DelphiModal />
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
        {renderJobStatusBanner()}
        <div className="report-content">
          {/* Action buttons at the top */}
          {showControls && (
            <div className="section">
              <h2>Analysis Actions</h2>
              <div className="action-buttons-grid">
                <div className="action-button-group">
                  <h3>Data Processing</h3>
                  <div className="section-header-actions">
                    <button
                      className="create-job-button"
                      onClick={() => setConfirmDelphiRunModalVisible(true)}
                      disabled={isTrackedJobLive(activeJob)}
                    >
                      Run New Delphi Analysis
                    </button>
                  </div>
                  {jobCreationResult && (
                    <div className={`result-message ${jobCreationResult.success ? "success" : "error"}`}> {/* eslint-disable-line quotes */}
                      {jobCreationResult.message}
                    </div>
                  )}
                </div>

                <div className="action-button-group">
                  <h3>Narrative Generation</h3>
                  <div className="section-header-actions">
                    <button
                      className="batch-report-button"
                      onClick={() => setConfirmDelphiRunModalVisible("batch")}
                      disabled={batchReportLoading || isTrackedJobLive(activeBatchJob)}
                    >
                      {batchReportLoading ? "Generating..." : "Generate Batch Topics"}
                    </button>
                  </div>
                  {batchReportResult && (
                    <div className={`result-message ${batchReportResult.success ? "success" : "error"}`}> {/* eslint-disable-line quotes */}
                      {batchReportResult.message}
                    </div>
                  )}
                  {
                    isTrackedJobLive(activeBatchJob) && (
                      <div className="result-message success">
                        {activeBatchJob.status === QUEUED_JOB_STATUS
                          ? "A batch job is queued — waiting for a worker; please check back later"
                          : "A batch job is currently in progress, please check back later"}
                      </div>
                    )
                  }
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
    </div>
  );
};

export default CommentsReport;
