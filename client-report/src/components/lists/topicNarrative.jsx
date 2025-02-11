import React from "react";
import * as globals from "../globals.js";
import Narrative from "../narrative/index.jsx";
import CommentList from "./commentList.jsx";

const TopicNarrative = ({
  conversation,
  comments,
  ptptCount,
  formatTid,
  math,
  voteColors,
  narrative,
  model,
  topicName,
}) => {
  try {
    const txt =
      model === "claude" ? narrative?.response.content[0].text : narrative?.response;

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
        <p style={globals.primaryHeading}>
          {topicName.charAt(0).toUpperCase() + topicName.slice(1)}
        </p>
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
  } catch (err) {
    console.error(`Failed to parse narrative for topic ${topicName}:`, {
      error: err,
      rawText: model === "claude" ? narrative?.response.content[0].text : narrative?.response,
      model,
    });
    return (
      <div>
        <p>Error parsing narrative data</p>
        <pre>{err.message}</pre>
      </div>
    );
  }
};

export default TopicNarrative;
