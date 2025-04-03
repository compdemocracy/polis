import { Response } from "express";
import fail from "../utils/fail";
import { getZidForRid } from "../utils/zinvite";

import Anthropic from "@anthropic-ai/sdk";
import { countTokens } from "@anthropic-ai/tokenizer";
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
import config from "../config";
import logger from "../utils/logger";

// eslint-disable-next-line @typescript-eslint/no-var-requires
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

const anthropic = config.anthropicApiKey ? new Anthropic({
  apiKey: config.anthropicApiKey,
}) : null;

const genAI = config.geminiApiKey ? new GoogleGenerativeAI(config.geminiApiKey) : null;

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
    if (xml.trim().length === 0)
      logger.error("No data has been returned by sendCommentGroupsSummary");
    return xml;
  } catch (e) {
    logger.error("Error in getCommentsAsXML:", e);
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
  return elapsed < config.maxReportCacheDuration;
};

const getModelResponse = async (
  model: string,
  system_lore: string,
  prompt_xml: string,
  modelVersion?: string,
  isTopic?: boolean
) => {
  try {
    if (isTopic && countTokens(prompt_xml) > 30000) {
      return `{
        "id": "polis_narrative_error_message",
        "title": "Too many comments",
        "paragraphs": [
          {
            "id": "polis_narrative_error_message",
            "title": "Too many comments",
            "sentences": [
              {
                "clauses": [
                  {
                    "text": "There are currently too many comments in this conversation for our AI to generate a topic response",
                    "citations": []
                  }
                ]
              }
            ]
          }
        ]
      }`;
    }
    const gemeniModel = genAI?.getGenerativeModel({
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
  
                  Make sure the JSON is VALID, as defined at https://www.json.org/json-en.html. DO NOT begin with an array '[' - begin with an object '{' - All keys MUST be enclosed in double quotes. NO trailing comma's should be included after the last element in a block (not valid json). Do NOT include any additional text outside of the JSON object.  Do not provide explanations, only the JSON.

                  The following is an example of an INVALID response:
                  \`\`\`json
                  {
                  "key1": "string value",
                  "array": [1,2,3], // <-- THIS IS INVALID BECAUSE OF A TRAILING COMMA. NO TRAILING COMMAS ARE PERMITTED IN THE RESPONSE .VALID JSON ONLY
                  }
                `,
            },
          ],
          role: "user",
        },
      ],
      systemInstruction: system_lore,
    };
    const openai = config.openaiApiKey ? new OpenAI({
      apiKey: config.openaiApiKey,
    }) : null;

    switch (model) {
      case "gemini": {
        if (!gemeniModel) {
          throw new Error("polis_err_gemini_api_key_not_set");
        }
        const respGem = await gemeniModel.generateContent(gemeniModelprompt);
        const result = await respGem.response.text();
        return result;
      }
      case "claude": {
        if (!anthropic) {
          throw new Error("polis_err_anthropic_api_key_not_set");
        }
        const responseClaude = await anthropic.messages.create({
          model: modelVersion || "claude-3-7-sonnet-20250219",
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
        // Claude API response structure might change with version updates
        return `{${(responseClaude as any)?.content[0]?.text}`;
      }
      case "openai": {
        if (!openai) {
          throw new Error("polis_err_openai_api_key_not_set");
        }
        const responseOpenAI = await openai.chat.completions.create({
          model: modelVersion || "gpt-4o",
          messages: [
            { role: "system", content: system_lore },
            { role: "user", content: prompt_xml },
          ],
        });
        return responseOpenAI.choices[0].message.content;
      }
      default:
        return "";
    }
  } catch (error) {
    logger.error("ERROR IN GETMODELRESPONSE", error);
    return `{
      "id": "polis_narrative_error_message",
      "title": "Narrative Error Message",
      "paragraphs": [
        {
          "id": "polis_narrative_error_message",
          "title": "Narrative Error Message",
          "sentences": [
            {
              "clauses": [
                {
                  "text": "There was an error generating the narrative. Please refresh the page once all sections have been generated. It may also be a problem with this model, especially if your content discussed sensitive topics.",
                  "citations": []
                }
              ]
            }
          ]
        }
      ]
    }`;
  }
};

const getGacThresholdByGroupCount = (numGroups: number): number => {
  const thresholds: Record<number, number> = {
    2: 0.7,
    3: 0.47,
    4: 0.32,
    5: 0.24,
  };
  return thresholds[numGroups] ?? 0.24;
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
    filter: (v: { group_aware_consensus: number; num_groups: number }) =>
      (v.group_aware_consensus ?? 0) >
      getGacThresholdByGroupCount(v.num_groups),
  };

  const cachedResponse = await storage?.queryItemsByRidSectionModel(
    `${rid}#${section.name}#${model}`
  );
  // Use type assertion for filter function with different parameter shape but compatible runtime behavior
  const structured_comments = await getCommentsAsXML(zid, section.filter as any);
  // send cached response first if avalable
  if (Array.isArray(cachedResponse) && cachedResponse?.length) {
    res.write(
      JSON.stringify({
        [section.name]: {
          modelResponse: cachedResponse[0].report_data,
          model,
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
      model,
      errors:
        structured_comments?.trim().length === 0
          ? "NO_CONTENT_AFTER_FILTER"
          : undefined,
    };

    storage?.putItem(reportItem);

    res.write(
      JSON.stringify({
        [section.name]: {
          modelResponse: resp,
          model,
          errors:
            structured_comments?.trim().length === 0
              ? "NO_CONTENT_AFTER_FILTER"
              : undefined,
        },
      }) + `|||`
    );
  }
  // Express response has no flush method, but compression middleware adds it
  (res as any).flush();
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
  // Use type assertion for filter function with different parameter shape but compatible runtime behavior
  const structured_comments = await getCommentsAsXML(zid, section.filter as any);
  // send cached response first if avalable
  if (Array.isArray(cachedResponse) && cachedResponse?.length) {
    res.write(
      JSON.stringify({
        [section.name]: {
          modelResponse: cachedResponse[0].report_data,
          model,
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
      model,
      errors:
        structured_comments?.trim().length === 0
          ? "NO_CONTENT_AFTER_FILTER"
          : undefined,
    };

    storage?.putItem(reportItem);

    res.write(
      JSON.stringify({
        [section.name]: {
          modelResponse: resp,
          model,
          errors:
            structured_comments?.trim().length === 0
              ? "NO_CONTENT_AFTER_FILTER"
              : undefined,
        },
      }) + `|||`
    );
  }
  // Express response has no flush method, but compression middleware adds it
  (res as any).flush();
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
  // Use type assertion for filter function with different parameter shape but compatible runtime behavior
  const structured_comments = await getCommentsAsXML(zid, section.filter as any);
  // send cached response first if avalable
  if (Array.isArray(cachedResponse) && cachedResponse?.length) {
    res.write(
      JSON.stringify({
        [section.name]: {
          modelResponse: cachedResponse[0].report_data,
          model,
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
      model,
      errors:
        structured_comments?.trim().length === 0
          ? "NO_CONTENT_AFTER_FILTER"
          : undefined,
    };

    storage?.putItem(reportItem);

    res.write(
      JSON.stringify({
        [section.name]: {
          modelResponse: resp,
          model,
          errors:
            structured_comments?.trim().length === 0
              ? "NO_CONTENT_AFTER_FILTER"
              : undefined,
        },
      }) + `|||`
    );
  }
  // Express response has no flush method, but compression middleware adds it
  (res as any).flush();
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

  if (cachedTopics?.length) {
    topics = cachedTopics[0].report_data;
  } else {
    topics = await getTopicsFromRID(zid);
    const reportItemTopics = {
      rid_section_model: `${rid}#topics`,
      model,
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

  await Promise.all(
    sections.map(
      async (
        section: { name: any; templatePath: PathLike | fs.FileHandle },
        i: number
      ) => {
        const cachedResponse = await storage?.queryItemsByRidSectionModel(
          `${rid}#${section.name}#${model}`
        );
        // @ts-expect-error function args ignore temp
        const structured_comments = await getCommentsAsXML(zid, section.filter);
        // send cached response first if avalable
        if (Array.isArray(cachedResponse) && cachedResponse?.length) {
          await new Promise<void>((resolve) => {
            res.write(
              JSON.stringify({
                [section.name]: {
                  modelResponse: cachedResponse[0].report_data,
                  model,
                  errors:
                    structured_comments?.trim().length === 0
                      ? "NO_CONTENT_AFTER_FILTER"
                      : undefined,
                },
              }) + `|||`
            );
            resolve();
          });
        } else {
          await new Promise<void>((resolve) => {
            setTimeout(async () => {
              const fileContents = await fs.readFile(
                section.templatePath,
                "utf8"
              );
              const json = await convertXML(fileContents);
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
                modelVersion,
                true
              );

              const reportItem = {
                rid_section_model: `${rid}#${section.name}#${model}`,
                timestamp: new Date().toISOString(),
                model,
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
                    modelResponse: resp,
                    model,
                    errors:
                      structured_comments?.trim().length === 0
                        ? "NO_CONTENT_AFTER_FILTER"
                        : undefined,
                  },
                }) + `|||`
              );
              // @ts-expect-error flush - calling due to use of compression
              res.flush();
              resolve();
            }, (model === "gemini" ? 500 : 250) * i);
          });
        }
        logger.debug(`topic over: ${section.name}`);
      }
    )
  );
  logger.debug("all promises completed");
  res.end();
}

export async function handle_GET_reportNarrative(
  req: { p: { rid: string }; query: QueryParams },
  res: Response
) {
  const storage = new DynamoStorageService(
    "report_narrative_store",
    req.query.noCache === "true"
  );
  await storage.initTable();

  const modelParam = req.query.model || "openai";
  const modelVersionParam = req.query.modelVersion;

  res.writeHead(200, {
    "Content-Type": "text/plain; charset=utf-8",
    "Transfer-Encoding": "chunked",
  });
  const { rid } = req.p;

  res.write(`POLIS-PING: AI bootstrap`);

  // Express response has no flush method, but compression middleware adds it
  (res as any).flush();

  const zid = await getZidForRid(rid);
  if (!zid) {
    fail(res, 404, "polis_error_report_narrative_notfound");
    return;
  }

  res.write(`POLIS-PING: retrieving system lore`);

  // Express response has no flush method, but compression middleware adds it
  (res as any).flush();

  const system_lore = await fs.readFile(
    "src/report_experimental/system.xml",
    "utf8"
  );

  res.write(`POLIS-PING: retrieving stream`);

  // Express response has no flush method, but compression middleware adds it
  (res as any).flush();
  try {
    const cachedResponse = await storage?.getAllByReportID(rid);
    if (
      Array.isArray(cachedResponse) &&
      cachedResponse?.length &&
      !isFreshData(cachedResponse[0].timestamp)
    ) {
      res.write(`POLIS-PING: pruining cache`);
      await storage?.deleteAllByReportID(rid);
      res.write(`POLIS-PING: cache pruined`);
    }
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
    logger.error(err);
    const msg =
      err instanceof Error && err.message && err.message.startsWith("polis_")
        ? err.message
        : "polis_err_report_narrative";
    fail(res, 500, msg, err);
  }
}
