// This JSON structure represents topics from the Bowling Green 2050 discussion
// Each topic includes:
//   - name: The main topic name
//   - citations: All comment IDs associated with this topic (including subtopic citations)
//   - subtopics: Array of subtopics, each with their specific citations

import { sendCommentGroupsSummary } from "../../routes/export";
import { SensemakerPrompt } from "@tevko/sensemaking-tools/src/sensemaker";
import { Comment, VoteTally } from "@tevko/sensemaking-tools/src/types";
import { parse } from "csv-parse";
import { GenerateContentRequest, GenerativeModel } from "node_modules/@google/generative-ai/dist/generative-ai";

const TOPIC_INSTRUCTIONS = `
Example of correct output for the following task:

[
  {
    "name": "Economic Development",
    "citations": [5, 55, 79, 150, 184],
    "subtopics": [
        { "name": "Job Creation", "citations": [6, 54, 78, 151, 189] },
        { "name": "Business Growth", "citations": [9, 53, 81, 157, 188] },
      ]
  },
  {
    "name": "Tourism",
    "citations": [...],
    ...
  },
  // ... other topics
]

Citations are mandatory and MUST map to relevant comments. If there are no relevant comments, the topic or subtopic should be disgarded. Ensure no fewer than 85% of available coments are included in citations
`

async function parseCsvString(csvString: string) {
  return new Promise((resolve, reject) => {
    const data: Comment[] = [];
    const parser = parse({
      columns: true, // Use first row as headers
      skip_empty_lines: true, // Ignore empty lines
      relax_column_count: true
    });

    parser.on("error", (error) => reject(error));

    parser.on("data", (row) => {
      if (row.moderated == -1) {
        return;
      }
      data.push({
        text: row.comment_text,
        id: row["comment-id"].toString(),
        voteTalliesByGroup: {
          "group-0": new VoteTally(
            Number(row["group-0-agree-count"]),
            Number(row["group-0-disagree-count"]),
            Number(row["group-0-pass-count"])
          ),
          "group-1": new VoteTally(
            Number(row["group-1-agree-count"]),
            Number(row["group-1-disagree-count"]),
            Number(row["group-1-pass-count"])
          ),
        },
      });
    });

    parser.on("end", () => resolve(data));

    // Write the CSV string to the parser
    parser.write(csvString);
    parser.end(); // Signal the end of the input
  });
}

export async function getTopicsFromRID(zId: number, model: GenerativeModel, system_lore: string) {
  const resp = await sendCommentGroupsSummary(zId, undefined, false);
  const modified = (resp as string).split("\n");
  modified[0] = `comment-id,comment_text,total-votes,total-agrees,total-disagrees,total-passes,group-a-votes,group-0-agree-count,group-0-disagree-count,group-0-pass-count,group-b-votes,group-1-agree-count,group-1-disagree-count,group-1-pass-count`;
  
  const comments = await parseCsvString(modified.join("\n"));
  const topicsPrompt = await new SensemakerPrompt().learnTopics(comments as Comment[], true);

  const gemeniModelprompt: GenerateContentRequest = {
    contents: [
      {
        parts: [
          {
            text: topicsPrompt,
          },
        ],
        role: "user",
      },
    ],
    systemInstruction: TOPIC_INSTRUCTIONS,
  };

  const respGem = await model.generateContent(gemeniModelprompt);
  const topics = await respGem.response.text();
  return JSON.parse(topics);
}










