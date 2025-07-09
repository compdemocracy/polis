import Anthropic from "@anthropic-ai/sdk";
import { convertXML } from "simple-xml-to-json";
import fs from "fs/promises";
import { parse } from "csv-parse/sync";
import { create } from "xmlbuilder2";
import logger from "../../../utils/logger";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const js2xmlparser = require("js2xmlparser");
const report_id = process.argv[2];

interface PolisRecord {
  [key: string]: string; // Allow any string keys
}

export class PolisConverter {
  static convertToXml(csvContent: string): string {
    // Parse CSV content
    const records = parse(csvContent, {
      columns: true,
      skip_empty_lines: true,
    }) as PolisRecord[];

    if (records.length === 0) return "";

    // Create XML document
    const doc = create({ version: "1.0", encoding: "UTF-8" }).ele(
      "polis-comments"
    );

    // Process each record
    records.forEach((record) => {
      // Extract base comment data
      const comment = doc.ele("comment", {
        id: record["comment-id"],
        votes: record["total-votes"],
        agrees: record["total-agrees"],
        disagrees: record["total-disagrees"],
        passes: record["total-passes"],
      });

      // Add comment text
      comment.ele("text").txt(record["comment"]);

      // Find and process all group data
      const groupKeys = Object.keys(record)
        .filter((key) => key.match(/^group-[a-z]-/))
        .reduce((groups, key) => {
          const groupId = key.split("-")[1]; // Extract 'a' from 'group-a-votes'
          if (!groups.includes(groupId)) groups.push(groupId);
          return groups;
        }, [] as string[]);

      // Add data for each group
      groupKeys.forEach((groupId) => {
        comment.ele(`group-${groupId}`, {
          votes: record[`group-${groupId}-votes`],
          agrees: record[`group-${groupId}-agrees`],
          disagrees: record[`group-${groupId}-disagrees`],
          passes: record[`group-${groupId}-passes`],
        });
      });
    });

    // Return formatted XML string
    return doc.end({ prettyPrint: true });
  }

  static async convertFromFile(filePath: string): Promise<string> {
    const fs = await import("fs/promises");
    const csvContent = await fs.readFile(filePath, "utf-8");
    return PolisConverter.convertToXml(csvContent);
  }

  // Helper method to validate CSV structure
  static validateCsvStructure(headers: string[]): boolean {
    const requiredBaseFields = [
      "comment-id",
      "comment",
      "total-votes",
      "total-agrees",
      "total-disagrees",
      "total-passes",
    ];

    const hasRequiredFields = requiredBaseFields.every((field) =>
      headers.includes(field)
    );

    // Check if group fields follow the expected pattern
    const groupFields = headers.filter((h) => h.startsWith("group-"));
    const validGroupPattern = groupFields.every((field) =>
      field.match(/^group-[a-z]-(?:votes|agrees|disagrees|passes)$/)
    );

    return hasRequiredFields && validGroupPattern;
  }
}

const anthropic = new Anthropic({
  // defaults to process.env["ANTHROPIC_API_KEY"]
});

const getJSONuserMsg = async () => {
  const report_xml_template = await fs.readFile(
    "src/prompts/report_experimental/subtasks/uncertainty.xml",
    "utf8"
  ); // unsure if this should be uncertainty or group_informed_consensus
  const asJSON = await convertXML(report_xml_template);
  return asJSON;
};

const getCommentsAsJson = async (id: string) => {
  const resp = await fetch(
    `http://localhost/api/v3/reportExport/${id}/comment-groups.csv`
  ); // this should be rewritten to call internal api or db, not depending on localhost
  const data = await resp.text();
  const xml = PolisConverter.convertToXml(data);
  return xml;
};

async function main() {
  const system_lore = await fs.readFile(
    "src/prompts/report_experimental/system.xml",
    "utf8"
  );
  const json = await getJSONuserMsg();
  const structured_comments = await getCommentsAsJson(report_id);
  json.polisAnalysisPrompt.children[
    json.polisAnalysisPrompt.children.length - 1
  ].data.content = { structured_comments }; // insert dynamic report stuff here
  const prompt_xml = js2xmlparser.parse(
    "polis-comments-and-group-demographics",
    json
  ); // then convert back to xml
  logger.debug(prompt_xml);
  const msg = await anthropic.messages.create({
    model: "claude-3-7-sonnet-20250219",
    max_tokens: 1000,
    temperature: 0,
    system: system_lore,
    messages: [
      {
        role: "user",
        content: [
          {
            type: "text",
            text: prompt_xml,
          },
        ],
      },
      {
        role: "assistant",
        content: [
          {
            type: "text",
            text: "{",
          },
        ],
      },
    ],
  });
  logger.debug(msg);
}

main().catch(logger.error);
