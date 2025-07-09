// This JSON structure represents topics from the Bowling Green 2050 discussion
// Each topic includes:
//   - name: The main topic name
//   - citations: All comment IDs associated with this topic (including subtopic citations)
//   - subtopics: Array of subtopics, each with their specific citations

import { sendCommentGroupsSummary } from "../../routes/export";
import { Sensemaker } from "@tevko/sensemaking-tools/src/sensemaker";
import { GoogleAIModel } from "@tevko/sensemaking-tools/src/models/aiStudio_model";
import { Comment, VoteTally, Topic } from "@tevko/sensemaking-tools/src/types";
import { parse } from "csv-parse";
import config from "../../config";
import logger from "../../utils/logger";

async function parseCsvString(csvString: string) {
  return new Promise((resolve, reject) => {
    const data: Comment[] = [];
    const parser = parse({
      columns: true, // Use first row as headers
      skip_empty_lines: true, // Ignore empty lines
      relax_column_count: true,
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

export async function getTopicsFromRID(zId: number) {
  try {
    if (!config.geminiApiKey) {
      throw new Error("polis_err_gemini_api_key_not_set");
    }
    const resp = await sendCommentGroupsSummary(zId, undefined, false);
    const modified = (resp as string).split("\n");
    modified[0] = `comment-id,comment_text,total-votes,total-agrees,total-disagrees,total-passes,group-a-votes,group-0-agree-count,group-0-disagree-count,group-0-pass-count,group-b-votes,group-1-agree-count,group-1-disagree-count,group-1-pass-count`;

    const comments = await parseCsvString(modified.join("\n"));
    const topics = await new Sensemaker({
      defaultModel: new GoogleAIModel(config.geminiApiKey, "gemini-exp-1206"),
    }).learnTopics(comments as Comment[], false);
    const categorizedComments = await new Sensemaker({
      defaultModel: new GoogleAIModel(
        config.geminiApiKey,
        "gemini-1.5-flash-8b"
      ),
    }).categorizeComments(comments as Comment[], false, topics);

    const topics_master_list = new Map();

    categorizedComments.forEach((c: Comment) => {
      c.topics?.forEach((t: Topic) => {
        const existingTopic = topics_master_list.get(t.name);
        if (existingTopic) {
          existingTopic.citations.push(Number(c.id));
        } else {
          topics_master_list.set(t.name, { citations: [Number(c.id)] });
        }
      });
    });

    return Array.from(topics_master_list, ([name, value]) => ({
      name,
      citations: value.citations,
    }));
  } catch (error) {
    logger.error(error);
    return [];
  }
}
