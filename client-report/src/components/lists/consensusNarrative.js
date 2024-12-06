import React from "react";
import Narrative from "../narrative";
import CommentList from "./commentList";
const ConsensusNarrative = ({
  math,
  comments,
  conversation,
  ptptCount,
  formatTid,
  voteColors,
  narrative,
}) => {
  if (!narrative?.group_informed_consensus) {
    return null;
  }
  const txt = narrative.group_informed_consensus.content[0].text;

  console.log("NARRATIVE123", narrative)

  const narrativeJSON = JSON.parse(`{${txt}`);

  // Extract all citation IDs from the narrative structure
  const uniqueTids = narrativeJSON.paragraphs.reduce((acc, paragraph) => {
    paragraph?.sentences?.forEach((sentence) => {
      sentence?.clauses?.forEach((clause) => {
        if (Array.isArray(clause?.citations)) {
          acc.push(...clause.citations);
        }
      });
    });
    return acc;
  }, []);

  // Deduplicate the IDs
  const dedupedTids = [...new Set(uniqueTids || [])];
  return (
    <div>
      <Narrative sectionData={narrative.group_informed_consensus} />
      <div style={{ marginTop: 50 }}>
        <CommentList
          conversation={conversation}
          ptptCount={ptptCount}
          math={math}
          formatTid={formatTid}
          tidsToRender={dedupedTids}
          comments={comments}
          voteColors={voteColors}
        />
      </div>
    </div>
  );
};
export default ConsensusNarrative;