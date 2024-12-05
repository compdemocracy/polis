import React from "react";
import Narrative from "../narrative";
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
  return (
    <div>
      <Narrative sectionData={narrative.group_informed_consensus} />
    </div>
  );
};
export default ConsensusNarrative;