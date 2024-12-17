// Copyright (C) 2012-present, The Authors. This program is free software: you can redistribute it and/or  modify it under the terms of the GNU Affero General Public License, version 3, as published by the Free Software Foundation. This program is distributed in the hope that it will be useful, but WITHOUT ANY WARRANTY; without even the implied warranty of MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the GNU Affero General Public License for more details. You should have received a copy of the GNU Affero General Public License along with this program.  If not, see <http://www.gnu.org/licenses/>.

import React from "react";
import CommentList from "./commentList.jsx";
import * as globals from "../globals.js";
import Narrative from "../narrative/index.jsx";

const UncertaintyNarrative = ({
  conversation,
  comments,
  ptptCount,
  formatTid,
  math,
  voteColors,
  narrative,
  model
}) => {
  if (!conversation || !narrative || !narrative?.responseClaude || !narrative?.responseGemini) {
    return <div>Loading Uncertainty...</div>;
  }

  const txt = model === "claude" ? narrative?.responseClaude.content[0].text : narrative?.responseGemini;

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
      <p style={globals.primaryHeading}> Uncertainty Narrative </p>
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

export default UncertaintyNarrative;
