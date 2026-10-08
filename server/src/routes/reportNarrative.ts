import { Response } from "express";
import { failJson } from "../utils/fail";
import { getZidForRid } from "../utils/zinvite";

import Anthropic from "@anthropic-ai/sdk";
import { convertXML } from "simple-xml-to-json";
import fs from "fs/promises";
import { parse } from "csv-parse/sync";
import { create } from "xmlbuilder2";
import { sendCommentGroupsSummary } from "../report";
import DynamoStorageService, { StorageError } from "../utils/storage";
import { AwsCredentialsConfigurationError } from "../utils/dynamoClient";
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

const anthropic = config.anthropicApiKey
  ? new Anthropic({
      apiKey: config.anthropicApiKey,
    })
  : null;

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

function isFreshData(timestamp: any): boolean {
  if (!timestamp) return false;

  const timestampDate = new Date(timestamp);
  const now = new Date();
  const diffInHours =
    (now.getTime() - timestampDate.getTime()) / (1000 * 60 * 60);
  return diffInHours < 1; // Consider data fresh if less than 1 hour old
}

/**
 * Handles storage errors gracefully and returns appropriate error responses
 */
function handleStorageError(error: StorageError, operation: string): string {
  logger.error(`Storage error during ${operation}:`, error);

  if (error.isTableNotFound) {
    return "Service temporarily unavailable. The report storage system may not be fully initialized.";
  } else if (error.isCredentialsError) {
    return "Storage service configuration error. Please contact support.";
  } else if (error.isNetworkError) {
    return "Storage service connection error. Please try again later.";
  } else if (error.isPermissionError) {
    return "Storage service access error. Please contact support.";
  } else {
    return `Storage service error: ${error.message}`;
  }
}

const getModelResponse = async (
  model: string,
  system_lore: string,
  prompt_xml: string,
  modelVersion?: string
) => {
  try {
    if (model !== "claude") {
      throw new Error("polis_err_narrative_generation_retired");
    }
    {
      if (!anthropic) {
        throw new Error("polis_err_anthropic_api_key_not_set");
      }
      const responseClaude = await anthropic.messages.create({
        model: modelVersion || "claude-sonnet-5",
        // max_tokens is a hard cap on thinking + response text combined
        // (adaptive thinking is on by default on Sonnet 5 / Opus 4.8+), so
        // this needs real headroom beyond the visible JSON text length.
        max_tokens: 8000,
        output_config: { effort: "medium" },
        system: system_lore,
        messages: [
          {
            role: "user",
            content: [{ type: "text", text: prompt_xml }],
          },
        ],
      });
      if (responseClaude.stop_reason === "max_tokens") {
        logger.warn(
          "Anthropic narrative report response was truncated by max_tokens; output may be incomplete/invalid JSON."
        );
      }
      const textBlock = responseClaude.content.find((b) => b.type === "text");
      const rawText = textBlock?.type === "text" ? textBlock.text : "";
      // Strip markdown code fences if present
      return rawText
        .replace(/^```(?:json)?\s*/i, "")
        .replace(/\s*```$/, "")
        .trim();
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

// Define report sections configuration
const getReportSections = () => [
  {
    name: "uncertainty_narrative",
    templatePath:
      "src/report_experimental/subtaskPrompts/uncertainty_narrative.xml",
  },
  {
    name: "participant_groups",
    templatePath:
      "src/report_experimental/subtaskPrompts/participant_groups.xml",
  },
];

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

  if (!storage) {
    logger.error("Storage service not available");
    res.write(
      JSON.stringify({
        [section.name]: {
          error: "Storage service not available",
          model,
        },
      }) + `|||`
    );
    (res as any).flush();
    return;
  }

  const cachedResult = await storage.queryItemsByRidSectionModel(
    `${rid}#${section.name}#${model}`
  );

  // Use type assertion for filter function with different parameter shape but compatible runtime behavior
  const structured_comments = await getCommentsAsXML(
    zid,
    section.filter as any
  );

  if (
    cachedResult.success &&
    Array.isArray(cachedResult.data) &&
    cachedResult.data?.length
  ) {
    res.write(
      JSON.stringify({
        [section.name]: {
          modelResponse: cachedResult.data[0].report_data,
          model,
          errors:
            structured_comments?.trim().length === 0
              ? "NO_CONTENT_AFTER_FILTER"
              : undefined,
        },
      }) + `|||`
    );
  } else {
    if (!cachedResult.success) {
      logger.warn("Failed to query cached consensus:", cachedResult.error);
    }

    if (model !== "claude") {
      writeRetiredSection(res, section.name, model);
      return;
    }
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
      report_id: rid,
      report_data: resp,
      model,
      errors:
        structured_comments?.trim().length === 0
          ? "NO_CONTENT_AFTER_FILTER"
          : undefined,
    };

    const putResult = await storage.putItem(reportItem);
    if (!putResult.success) {
      logger.warn("Failed to cache report item:", putResult.error);
      // Continue execution - caching failure shouldn't stop the response
    }

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
  const sections = getReportSections().filter((section) =>
    section.name.includes("uncertainty")
  );

  await Promise.all(
    sections.map(async (section) => {
      if (!storage) {
        logger.error("Storage service not available");
        res.write(
          JSON.stringify({
            [section.name]: {
              error: "Storage service not available",
              model,
            },
          }) + `|||`
        );
        return;
      }

      const cachedResult = await storage.queryItemsByRidSectionModel(
        `${rid}#${section.name}#${model}`
      );

      if (!cachedResult.success) {
        const errorMessage = handleStorageError(
          cachedResult.error!,
          "query cached uncertainty"
        );
        res.write(
          JSON.stringify({
            [section.name]: {
              error: errorMessage,
              model,
            },
          }) + `|||`
        );
        return;
      }

      const cachedResponse = cachedResult.data;

      if (Array.isArray(cachedResponse) && cachedResponse?.length) {
        res.write(
          JSON.stringify({
            [section.name]: {
              modelResponse: cachedResponse[0].report_data,
              model,
            },
          }) + `|||`
        );
      } else {
        if (model !== "claude") {
          writeRetiredSection(res, section.name, model);
          return;
        }
        const structured_comments = await getCommentsAsXML(zid);
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
          report_id: rid,
          model,
          errors:
            structured_comments?.trim().length === 0
              ? "NO_CONTENT_AFTER_FILTER"
              : undefined,
        };

        const putResult = await storage.putItem(reportItem);
        if (!putResult.success) {
          logger.warn("Failed to cache report item:", putResult.error);
          // Continue execution - caching failure shouldn't stop the response
        }

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
    })
  );
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
  const sections = getReportSections().filter((section) =>
    section.name.includes("groups")
  );

  await Promise.all(
    sections.map(async (section) => {
      if (!storage) {
        logger.error("Storage service not available");
        res.write(
          JSON.stringify({
            [section.name]: {
              error: "Storage service not available",
              model,
            },
          }) + `|||`
        );
        return;
      }

      const cachedResult = await storage.queryItemsByRidSectionModel(
        `${rid}#${section.name}#${model}`
      );

      if (!cachedResult.success) {
        const errorMessage = handleStorageError(
          cachedResult.error!,
          "query cached groups"
        );
        res.write(
          JSON.stringify({
            [section.name]: {
              error: errorMessage,
              model,
            },
          }) + `|||`
        );
        return;
      }

      const cachedResponse = cachedResult.data;

      if (Array.isArray(cachedResponse) && cachedResponse?.length) {
        res.write(
          JSON.stringify({
            [section.name]: {
              modelResponse: cachedResponse[0].report_data,
              model,
            },
          }) + `|||`
        );
      } else {
        if (model !== "claude") {
          writeRetiredSection(res, section.name, model);
          return;
        }
        const structured_comments = await getCommentsAsXML(zid);
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
          report_id: rid,
          model,
          errors:
            structured_comments?.trim().length === 0
              ? "NO_CONTENT_AFTER_FILTER"
              : undefined,
        };

        const putResult = await storage.putItem(reportItem);
        if (!putResult.success) {
          logger.warn("Failed to cache report item:", putResult.error);
          // Continue execution - caching failure shouldn't stop the response
        }

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
    })
  );
}

function writeRetiredSection(res: Response, section: string, model: string) {
  res.write(
    JSON.stringify({
      [section]: {
        error:
          "Generation is no longer available for this section. Stored reports remain readable.",
        model,
      },
    }) + "|||"
  );
  (res as any).flush();
}

export async function handle_GET_topics(
  rid: string,
  storage: DynamoStorageService | undefined,
  res: Response<any, Record<string, any>>,
  model: string,
  zid?: number
) {
  if (!storage) {
    res.write(
      JSON.stringify({
        topics: { error: "Storage service not available", model },
      }) + "|||"
    );
    return;
  }
  const cachedTopics = await storage.queryItemsByRidSectionModel(
    `${rid}#topics`
  );
  if (!cachedTopics.success) {
    res.write(
      JSON.stringify({
        topics: {
          error: handleStorageError(cachedTopics.error!, "query stored topics"),
          model,
        },
      }) + "|||"
    );
    return;
  }
  const topics = cachedTopics.data?.[0]?.report_data;
  if (!Array.isArray(topics)) {
    writeRetiredSection(res, "topics", model);
    return;
  }
  await Promise.all(topics.map(async (topic) => {
    const section = `topic_${topic.name.toLowerCase().replace(/\s+/g, "_")}`;
    const cached = await storage.queryItemsByRidSectionModel(
      `${rid}#${section}#${model}`
    );
    const structured_comments = await getCommentsAsXML(zid, (v) => topic.citations.includes(v.comment_id));
    if (!cached.success) {
      res.write(
        JSON.stringify({
          [section]: {
            error: handleStorageError(
              cached.error!,
              "query stored topic narrative"
            ),
            model,
          },
        }) + "|||"
      );
    } else if (cached.data?.length) {
      res.write(
        JSON.stringify({
          [section]: {
            modelResponse: cached.data[0].report_data,
            model,
            errors: structured_comments?.trim().length === 0 ? "NO_CONTENT_AFTER_FILTER" : undefined,
          },
        }) + "|||"
      );
    } else {
      writeRetiredSection(res, section, model);
    }
  }));
  (res as any).flush();
}

export async function handle_GET_reportNarrative(
  req: { p: { rid: string; delphiEnabled: boolean }; query: QueryParams },
  res: Response
) {
  let storage: DynamoStorageService;
  const modelParam = req.query.model || "claude";
  const modelVersionParam = req.query.modelVersion;
  const storedOnly = modelParam !== "claude";

  // Initialize storage with improved error handling. Construction is inside the
  // try because it resolves AWS credentials and throws a named configuration
  // error on a placeholder credential in the environment.
  try {
    if (!req.p.delphiEnabled) {
      throw new Error("Unauthorized");
    }
    storage = new DynamoStorageService(
      "report_narrative_store",
      !storedOnly && req.query.noCache === "true"
    );
    const initResult = await storage.initTable();
    if (!initResult.success) {
      const error = initResult.error!;
      logger.error("Failed to initialize storage:", error);

      // Provide helpful error message based on error type
      if (error.isTableNotFound) {
        failJson(res, 503, "polis_err_report_storage_not_ready", {
          hint: "The report storage system is not fully initialized. Please try again later or contact support if this persists.",
        });
      } else if (error.isCredentialsError) {
        failJson(res, 503, "polis_err_report_storage_config", {
          hint: "Storage service configuration error. Please contact support.",
        });
      } else if (error.isNetworkError) {
        failJson(res, 503, "polis_err_report_storage_network", {
          hint: "Cannot connect to storage service. Please try again later.",
        });
      } else {
        failJson(res, 503, "polis_err_report_storage", {
          hint: "Storage service error. Please try again later.",
        });
      }
      return;
    }
  } catch (error) {
    logger.error("Storage initialization failed:", error);
    if (error instanceof AwsCredentialsConfigurationError) {
      failJson(res, 503, error.code, {
        hint: "Storage service credentials are misconfigured. Please contact support.",
      });
      return;
    }
    failJson(res, 503, "polis_err_report_storage", {
      hint: "Storage service error. Please try again later.",
    });
    return;
  }

  // Retired names are accepted only as keys for historical stored outputs.
  if (!["claude", "openai", "gemini"].includes(modelParam as string)) {
    failJson(res, 400, "polis_err_narrative_model_unsupported");
    return;
  }

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
    failJson(res, 404, "polis_error_report_narrative_notfound");
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
    // Refresh only the three active sections. Never prune historical providers
    // or the topic index/outputs: their generators have been removed.
    if (!storedOnly) {
      const cacheResult = await storage.getAllByReportID(rid);
      const activeKeys = new Set([
        `${rid}#group_informed_consensus#claude`,
        `${rid}#uncertainty_narrative#claude`,
        `${rid}#participant_groups#claude`,
      ]);
      const activeRows =
        cacheResult.success && Array.isArray(cacheResult.data)
          ? cacheResult.data.filter((item) =>
              activeKeys.has(item.rid_section_model)
            )
          : [];
      if (activeRows.length && !isFreshData(activeRows[0].timestamp)) {
        res.write("POLIS-PING: pruning cache");
        let deletedCount = 0;
        for (const item of activeRows) {
          const result = await storage.deleteReportItem(
            item.rid_section_model,
            item.timestamp
          );
          if (result.success) deletedCount++;
          else
            logger.warn("Failed to prune active report section:", result.error);
        }
        res.write(`POLIS-PING: cache pruned (${deletedCount} items)`);
      }
    }
    // noCache can regenerate active sections, but cannot bypass stored topics.
    const topicStorage =
      req.query.noCache === "true" && !storedOnly
        ? new DynamoStorageService("report_narrative_store", false)
        : storage;
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
      handle_GET_topics(rid, topicStorage, res, modelParam as string, zid),
    ];
    await Promise.all(promises);
    res.end();
  } catch (err) {
    // @ts-expect-error flush - calling due to use of compression
    res.flush();
    logger.error("Report narrative generation error:", err);
    const msg =
      err instanceof Error && err.message && err.message.startsWith("polis_")
        ? err.message
        : "polis_err_report_narrative";
    failJson(res, 500, msg, err);
  }
}
