/* eslint-disable no-console */
import { Response } from "express";
import fail from "../utils/fail";
import { getZidForRid } from "../utils/zinvite";

import Anthropic from "@anthropic-ai/sdk";
import {
  GenerateContentRequest,
  GoogleGenerativeAI,
} from "@google/generative-ai";
import OpenAI from "openai";
import { convertXML } from "simple-xml-to-json";
import fs from "fs/promises";
import { parse } from "csv-parse/sync";
import { create } from "xmlbuilder2";
import { sendCommentGroupsSummary } from "./export";
import { getTopicsFromRID } from "../report_experimental/topics-example";
import DynamoStorageService from "../utils/storage";
import { PathLike } from "fs";

const js2xmlparser = require("js2xmlparser");

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
          const groupId = key.split("-")[1]; // Extract "a" from "group-a-votes"
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
  apiKey: process.env.ANTHROPIC_API_KEY,
});

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY as string);

const getCommentsAsXML = async (
  id: number,
  filter?: (v: {
    votes: number;
    agrees: number;
    disagrees: number;
    passes: number;
    group_aware_consensus?: number;
    comment_extremity?: number;
    comment_id: number;
  }) => boolean
) => {
  try {
    const resp = await sendCommentGroupsSummary(id, undefined, false, filter);
    const xml = PolisConverter.convertToXml(resp as string);
    // eslint-disable-next-line no-console
    if (xml.trim().length === 0)
      console.error("No data has been returned by sendCommentGroupsSummary");
    return xml;
  } catch (e) {
    console.error("Error in getCommentsAsXML:", e);
    throw e; // Re-throw instead of returning empty string
  }
};

type QueryParams = {
  [key: string]: string | string[] | undefined;
};

const isFreshData = (timestamp: string) => {
  const now = new Date().getTime();
  const then = new Date(timestamp).getTime();
  const elapsed = Math.abs(now - then);
  return (
    elapsed <
    (((process.env.MAX_REPORT_CACHE_DURATION as unknown) as number) || 3600000)
  );
};

const getModelResponse = async (
  model: string,
  system_lore: string,
  prompt_xml: string,
  modelVersion?: string
) => {
  try {
    const gemeniModel = genAI.getGenerativeModel({
      // model: "gemini-1.5-pro-002",
      model: modelVersion || "gemini-2.0-pro-exp-02-05",
      generationConfig: {
        // https://cloud.google.com/vertex-ai/docs/reference/rest/v1/GenerationConfig
        responseMimeType: "application/json",
        maxOutputTokens: 50000, // high for reliability for now.
      },
    });
    const gemeniModelprompt: GenerateContentRequest = {
      contents: [
        {
          parts: [
            {
              text: `
                  ${prompt_xml}
  
                  You MUST respond with a JSON object that follows this EXACT structure:
  
                  \`\`\`json
                  {
                    "key1": "string value",
                    "key2": [
                      {
                        "nestedKey1": 123,
                        "nestedKey2": "another string"
                      }
                    ],
                    "key3": true
                  }
                  \`\`\`
  
                  Make sure the JSON is VALID. DO NOT begin with an array '[' - begin with an object '{' - All keys MUST be enclosed in double quotes. NO trailing comma's should be included after the last element in a block (not valid json). Do NOT include any additional text outside of the JSON object.  Do not provide explanations, only the JSON.
                `,
            },
          ],
          role: "user",
        },
      ],
      systemInstruction: system_lore,
    };
    const openai = new OpenAI();

    switch (model) {
      case "Gemini": {
        const respGem = await gemeniModel.generateContent(gemeniModelprompt);
        const result = await respGem.response.text();
        return result;
      }
      case "Claude": {
        const responseClaude = await anthropic.messages.create({
          model: modelVersion || "claude-3-5-sonnet-20241022",
          max_tokens: 3000,
          temperature: 0,
          system: system_lore,
          messages: [
            {
              role: "user",
              content: [{ type: "text", text: prompt_xml }],
            },
            {
              role: "assistant",
              content: [{ type: "text", text: "{" }],
            },
          ],
        });

        return responseClaude;
      }
      case "openai": {
        console.log("RUNNING OPENAI MODEL FOR NARRATIVE");
        const responseOpenAI = await openai.chat.completions.create({
          model: modelVersion || "gpt-4o",
          messages: [
            { role: "system", content: system_lore },
            { role: "user", content: prompt_xml },
          ],
        });
        console.log(
          "OPENAI RESPONSE",
          responseOpenAI.choices[0].message.content
        );
        return responseOpenAI.choices[0].message.content;
      }
      default:
        return "";
    }
  } catch (error) {
    console.error(error);
    return {
      content: [],
    };
  }
};

export async function handle_GET_groupInformedConsensus(
  rid: string,
  storage: DynamoStorageService | undefined,
  res: Response<any, Record<string, any>>,
  model: string,
  system_lore: string,
  zid: number | undefined,
  modelVersion?: string
) {
  const section = {
    name: "group_informed_consensus",
    templatePath:
      "src/report_experimental/subtaskPrompts/group_informed_consensus.xml",
    filter: (v: { group_aware_consensus: number }) =>
      (v.group_aware_consensus ?? 0) > 0.7,
  };

  const cachedResponse = await storage?.queryItemsByRidSectionModel(
    `${rid}#${section.name}#${model}`
  );
  // @ts-expect-error function args ignore temp
  const structured_comments = await getCommentsAsXML(zid, section.filter);
  // send cached response first if avalable
  if (
    Array.isArray(cachedResponse) &&
    cachedResponse?.length &&
    isFreshData(cachedResponse[0].timestamp)
  ) {
    res.write(
      JSON.stringify({
        [section.name]: {
          [`response${model}`]: cachedResponse[0].report_data,
          errors:
            structured_comments?.trim().length === 0
              ? "NO_CONTENT_AFTER_FILTER"
              : undefined,
        },
      }) + `|||`
    );
  } else {
    const fileContents = await fs.readFile(section.templatePath, "utf8");
    const json = await convertXML(fileContents);
    if (Array.isArray(cachedResponse) && cachedResponse?.length) {
      storage?.deleteReportItem(
        cachedResponse[0].rid_section_model,
        cachedResponse[0].timestamp
      );
    }
    json.polisAnalysisPrompt.children[
      json.polisAnalysisPrompt.children.length - 1
    ].data.content = { structured_comments };

    const prompt_xml = js2xmlparser.parse(
      "polis-comments-and-group-demographics",
      json
    );

    const resp = await getModelResponse(
      model,
      system_lore,
      prompt_xml,
      modelVersion
    );

    const reportItem = {
      rid_section_model: `${rid}#${section.name}#${model}`,
      timestamp: new Date().toISOString(),
      report_data: resp,
      errors:
        structured_comments?.trim().length === 0
          ? "NO_CONTENT_AFTER_FILTER"
          : undefined,
    };

    storage?.putItem(reportItem);

    res.write(
      JSON.stringify({
        [section.name]: {
          [`response${model}`]: resp,
          errors:
            structured_comments?.trim().length === 0
              ? "NO_CONTENT_AFTER_FILTER"
              : undefined,
        },
      }) + `|||`
    );
  }
  // @ts-expect-error flush - calling due to use of compression
  res.flush();
}

export async function handle_GET_uncertainty(
  rid: string,
  storage: DynamoStorageService | undefined,
  res: Response<any, Record<string, any>>,
  model: string,
  system_lore: string,
  zid: number | undefined,
  modelVersion?: string
) {
  const section = {
    name: "uncertainty",
    templatePath: "src/report_experimental/subtaskPrompts/uncertainty.xml",
    // Revert to original simple pass ratio check
    filter: (v: { passes: number; votes: number }) => v.passes / v.votes >= 0.2,
  };

  const cachedResponse = await storage?.queryItemsByRidSectionModel(
    `${rid}#${section.name}#${model}`
  );
  // @ts-expect-error function args ignore temp
  const structured_comments = await getCommentsAsXML(zid, section.filter);
  // send cached response first if avalable
  if (
    Array.isArray(cachedResponse) &&
    cachedResponse?.length &&
    isFreshData(cachedResponse[0].timestamp)
  ) {
    res.write(
      JSON.stringify({
        [section.name]: {
          [`response${model}`]: cachedResponse[0].report_data,
          errors:
            structured_comments?.trim().length === 0
              ? "NO_CONTENT_AFTER_FILTER"
              : undefined,
        },
      }) + `|||`
    );
  } else {
    const fileContents = await fs.readFile(section.templatePath, "utf8");
    const json = await convertXML(fileContents);
    if (Array.isArray(cachedResponse) && cachedResponse?.length) {
      storage?.deleteReportItem(
        cachedResponse[0].rid_section_model,
        cachedResponse[0].timestamp
      );
    }
    json.polisAnalysisPrompt.children[
      json.polisAnalysisPrompt.children.length - 1
    ].data.content = { structured_comments };

    const prompt_xml = js2xmlparser.parse(
      "polis-comments-and-group-demographics",
      json
    );

    const resp = await getModelResponse(
      model,
      system_lore,
      prompt_xml,
      modelVersion
    );

    const reportItem = {
      rid_section_model: `${rid}#${section.name}#${model}`,
      timestamp: new Date().toISOString(),
      report_data: resp,
      errors:
        structured_comments?.trim().length === 0
          ? "NO_CONTENT_AFTER_FILTER"
          : undefined,
    };

    storage?.putItem(reportItem);

    res.write(
      JSON.stringify({
        [section.name]: {
          [`response${model}`]: resp,
          errors:
            structured_comments?.trim().length === 0
              ? "NO_CONTENT_AFTER_FILTER"
              : undefined,
        },
      }) + `|||`
    );
  }
  // @ts-expect-error flush - calling due to use of compression
  res.flush();
}

export async function handle_GET_groups(
  rid: string,
  storage: DynamoStorageService | undefined,
  res: Response<any, Record<string, any>>,
  model: string,
  system_lore: string,
  zid: number | undefined,
  modelVersion?: string
) {
  const section = {
    name: "groups",
    templatePath: "src/report_experimental/subtaskPrompts/groups.xml",
    filter: (v: { comment_extremity: number }) => {
      return (v.comment_extremity ?? 0) > 1;
    },
  };

  const cachedResponse = await storage?.queryItemsByRidSectionModel(
    `${rid}#${section.name}#${model}`
  );
  // @ts-expect-error function args ignore temp
  const structured_comments = await getCommentsAsXML(zid, section.filter);
  // send cached response first if avalable
  if (
    Array.isArray(cachedResponse) &&
    cachedResponse?.length &&
    isFreshData(cachedResponse[0].timestamp)
  ) {
    res.write(
      JSON.stringify({
        [section.name]: {
          [`response${model}`]: cachedResponse[0].report_data,
          errors:
            structured_comments?.trim().length === 0
              ? "NO_CONTENT_AFTER_FILTER"
              : undefined,
        },
      }) + `|||`
    );
  } else {
    const fileContents = await fs.readFile(section.templatePath, "utf8");
    const json = await convertXML(fileContents);
    if (Array.isArray(cachedResponse) && cachedResponse?.length) {
      storage?.deleteReportItem(
        cachedResponse[0].rid_section_model,
        cachedResponse[0].timestamp
      );
    }
    json.polisAnalysisPrompt.children[
      json.polisAnalysisPrompt.children.length - 1
    ].data.content = { structured_comments };

    const prompt_xml = js2xmlparser.parse(
      "polis-comments-and-group-demographics",
      json
    );

    const resp = await getModelResponse(
      model,
      system_lore,
      prompt_xml,
      modelVersion
    );

    const reportItem = {
      rid_section_model: `${rid}#${section.name}#${model}`,
      timestamp: new Date().toISOString(),
      report_data: resp,
      errors:
        structured_comments?.trim().length === 0
          ? "NO_CONTENT_AFTER_FILTER"
          : undefined,
    };

    storage?.putItem(reportItem);

    res.write(
      JSON.stringify({
        [section.name]: {
          [`response${model}`]: resp,
          errors:
            structured_comments?.trim().length === 0
              ? "NO_CONTENT_AFTER_FILTER"
              : undefined,
        },
      }) + `|||`
    );
  }
  // @ts-expect-error flush - calling due to use of compression
  res.flush();
}

export async function handle_GET_topics(
  rid: string,
  storage: DynamoStorageService | undefined,
  res: Response<any, Record<string, any>>,
  model: string,
  system_lore: string,
  zid: number,
  modelVersion?: string
) {
  let topics;
  const cachedTopics = await storage?.queryItemsByRidSectionModel(
    `${rid}#topics`
  );

  if (cachedTopics?.length && isFreshData(cachedTopics[0].timestamp)) {
    topics = cachedTopics[0].report_data;
  } else {
    if (cachedTopics?.length) {
      storage?.deleteReportItem(
        cachedTopics[0].rid_section_model,
        cachedTopics[0].timestamp
      );
    }
    topics = await getTopicsFromRID(zid);
    const reportItemTopics = {
      rid_section_model: `${rid}#topics`,
      timestamp: new Date().toISOString(),
      report_data: topics,
    };

    storage?.putItem(reportItemTopics);
  }
  const sections = topics.map(
    (topic: { name: string; citations: number[] }) => ({
      name: `topic_${topic.name.toLowerCase().replace(/\s+/g, "_")}`,
      templatePath: "src/report_experimental/subtaskPrompts/topics.xml",
      filter: (v: { comment_id: number }) => {
        // Check if the comment_id is in the citations array for this topic
        return topic.citations.includes(v.comment_id);
      },
    })
  );

  sections.forEach(
    async (
      section: { name: any; templatePath: PathLike | fs.FileHandle },
      i: number,
      arr: any
    ) => {
      const cachedResponse = await storage?.queryItemsByRidSectionModel(
        `${rid}#${section.name}#${model}`
      );
      // @ts-expect-error function args ignore temp
      const structured_comments = await getCommentsAsXML(zid, section.filter);
      // send cached response first if avalable
      if (
        Array.isArray(cachedResponse) &&
        cachedResponse?.length &&
        isFreshData(cachedResponse[0].timestamp)
      ) {
        res.write(
          JSON.stringify({
            [section.name]: {
              [`response${model}`]: cachedResponse[0].report_data,
              errors:
                structured_comments?.trim().length === 0
                  ? "NO_CONTENT_AFTER_FILTER"
                  : undefined,
            },
          }) + `|||`
        );
      } else {
        const fileContents = await fs.readFile(section.templatePath, "utf8");
        const json = await convertXML(fileContents);
        if (Array.isArray(cachedResponse) && cachedResponse?.length) {
          storage?.deleteReportItem(
            cachedResponse[0].rid_section_model,
            cachedResponse[0].timestamp
          );
        }
        json.polisAnalysisPrompt.children[
          json.polisAnalysisPrompt.children.length - 1
        ].data.content = { structured_comments };

        const prompt_xml = js2xmlparser.parse(
          "polis-comments-and-group-demographics",
          json
        );
        setTimeout(async () => {
          console.log("CALLING TOPIC");
          const resp = await getModelResponse(
            model,
            system_lore,
            prompt_xml,
            modelVersion
          );

          const reportItem = {
            rid_section_model: `${rid}#${section.name}#${model}`,
            timestamp: new Date().toISOString(),
            report_data: resp,
            errors:
              structured_comments?.trim().length === 0
                ? "NO_CONTENT_AFTER_FILTER"
                : undefined,
          };

          storage?.putItem(reportItem);

          res.write(
            JSON.stringify({
              [section.name]: {
                [`response${model}`]: resp,
                errors:
                  structured_comments?.trim().length === 0
                    ? "NO_CONTENT_AFTER_FILTER"
                    : undefined,
              },
            }) + `|||`
          );
          console.log("topic over");
          // @ts-expect-error flush - calling due to use of compression
          res.flush();

          if (arr.length - 1 === i) {
            console.log("all promises completed");
            res.end();
          }
        }, 3000 * i);
      }
    }
  );
}

export async function handle_GET_reportNarrative(
  req: { p: { rid: string }; query: QueryParams },
  res: Response
) {
  let storage;
  if (process.env.AWS_REGION && process.env.AWS_REGION?.trim().length > 0) {
    storage = new DynamoStorageService(
      process.env.AWS_REGION,
      "report_narrative_store"
    );
  }
  const modelParam = req.query.model;
  const modelVersionParam = req.query.modelVersion;

  res.writeHead(200, {
    "Content-Type": "text/plain; charset=utf-8",
    "Transfer-Encoding": "chunked",
  });
  const { rid } = req.p;

  res.write(`POLIS-PING: AI bootstrap`);

  // @ts-expect-error flush - calling due to use of compression
  res.flush();

  const zid = await getZidForRid(rid);
  if (!zid) {
    fail(res, 404, "polis_error_report_narrative_notfound");
    return;
  }

  res.write(`POLIS-PING: retrieving system lore`);

  // @ts-expect-error flush - calling due to use of compression
  res.flush();

  const system_lore = await fs.readFile(
    "src/report_experimental/system.xml",
    "utf8"
  );

  res.write(`POLIS-PING: retrieving stream`);

  // @ts-expect-error flush - calling due to use of compression
  res.flush();
  try {
    const promises = [
      handle_GET_groupInformedConsensus(
        rid,
        storage,
        res,
        modelParam as string,
        system_lore,
        zid,
        modelVersionParam as string
      ),
      handle_GET_uncertainty(
        rid,
        storage,
        res,
        modelParam as string,
        system_lore,
        zid,
        modelVersionParam as string
      ),
      handle_GET_groups(
        rid,
        storage,
        res,
        modelParam as string,
        system_lore,
        zid,
        modelVersionParam as string
      ),
      handle_GET_topics(
        rid,
        storage,
        res,
        modelParam as string,
        system_lore,
        zid,
        modelVersionParam as string
      ),
    ];
    await Promise.all(promises);
  } catch (err) {
    // @ts-expect-error flush - calling due to use of compression
    res.flush();
    console.log(err);
    const msg =
      err instanceof Error && err.message && err.message.startsWith("polis_")
        ? err.message
        : "polis_err_report_narrative";
    fail(res, 500, msg, err);
  }
}
