// Copyright (C) 2012-present, The Authors. This program is free software: you can redistribute it and/or  modify it under the terms of the GNU Affero General Public License, version 3, as published by the Free Software Foundation. This program is distributed in the hope that it will be useful, but WITHOUT ANY WARRANTY; without even the implied warranty of MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the GNU Affero General Public License for more details. You should have received a copy of the GNU Affero General Public License along with this program.  If not, see <http://www.gnu.org/licenses/>.

import React from "react";
import CommentList from "./commentList.jsx";
import * as globals from "../globals.js";
import Narrative from "../narrative/index.jsx";
import getNarrativeJSON from "../../util/getNarrativeJSON.js";

const GroupsNarrative = ({
  conversation,
  comments,
  ptptCount,
  formatTid,
  math,
  voteColors,
  narrative,
  model,
}) => {
  try {
    const narrativeJSON = getNarrativeJSON(narrative, narrative?.model);

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
        <p style={globals.primaryHeading}> Differences Between Groups </p>
        <p style={globals.paragraph}>
          This narrative summary may contain hallucinations. Check each clause.
        </p>
        <Narrative sectionData={narrative} model={model} />
        {narrative.errors === undefined && (
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
        )}
      </div>
    );
  } catch (err) {
    console.error("Failed to parse narrative:", {
      error: err,
      rawText: narrative,
      model: narrative?.model,
    });
    return (
      <div>
        <p>Error parsing narrative data</p>
        <pre>{err.message}</pre>
      </div>
    );
  }
};

export default GroupsNarrative;
