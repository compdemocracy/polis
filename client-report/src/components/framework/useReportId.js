import { useEffect, useState } from 'react';

export function useReportId() {
  const [report_id, setReportId] = useState(null);

  useEffect(() => {
    // Parse the URL to extract the report ID
    const pathname = window.location.pathname;

    // Match patterns like /report/rid or /narrativeReport/rid or /commentsReport/rid or /topicHierarchy/rid or /topicStats/rid
    const match = pathname.match(
      /^\/(report|narrativeReport|commentsReport|topicMapNarrativeReport|topicHierarchy|topicReport|topicsVizReport|exportReport|topicStats)\/([a-zA-Z0-9]+)/
    );

    if (match && match[2]) {
      setReportId(match[2]);
    } else {
      console.error("Could not extract report_id from URL:", pathname);
    }
  }, []);

  return { report_id };
}