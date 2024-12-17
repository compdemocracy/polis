import React, { useState } from "react";
import * as globals from "../globals.js";
import Narrative from "../narrative/index.jsx";
import CommentList from "./commentList.jsx";
const ConsensusNarrative = ({
  math,
  comments,
  conversation,
  ptptCount,
  formatTid,
  voteColors,
  narrative,
  model
}) => {

  if (!narrative) {
    return <div>Loading Consensus...</div>;
  }
  const txt = model === "claude" ? narrative.responseClaude.content[0].text : narrative.responseGemini;

  const narrativeJSON = model === "claude" ? JSON.parse(`{${txt}`) : JSON.parse(txt);

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
      <p style={globals.primaryHeading}> Group Aware Consensus Narrative </p>
      <p style={globals.paragraph}>
        This narrative summary may contain hallucinations. Check each clause.
      </p>
      <Narrative sectionData={narrative} model={model} />
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
