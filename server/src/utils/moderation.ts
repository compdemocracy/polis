import request from "request-promise";
import { GoogleGenAI } from "@google/genai";
import config from "../config";
import { convertXML } from "simple-xml-to-json";
import logger from "./logger";
import fs from "fs/promises";

const js2xmlparser = require("js2xmlparser");

const internal_config = {
  fileContents: "",
  system_lore: "",
};

async function loadFiles() {
  internal_config.fileContents = await fs.readFile(
    "src/prompts/moderation/script.xml",
    "utf8"
  );
  internal_config.system_lore = await fs.readFile(
    "src/prompts/report_experimental/system.xml",
    "utf8"
  );
}

loadFiles();

async function analyzeComment(
  txt: string,
  convo_topic: string,
  geographical_context?: string // ip address if available
) {
  try {
    const json = await convertXML(internal_config.fileContents);
    const getRegionFromIP = async (ip: string): Promise<string> => {
      if (!ip) {
        return "US or Europe (EU)";
      }
      try {
        // Using a free IP geolocation service.
        // Consider replacing with a more robust, authenticated service for production.
        const response = await request.get(`http://ip-api.com/json/${ip}`);
        const data = JSON.parse(response);
        if (data.status === "success" && data.country) {
          const locationParts = [
            data.city,
            data.regionName,
            data.country,
          ].filter(Boolean);
          return locationParts.join(", ");
        }
        return "US or Europe (EU)"; // fallback
      } catch (error) {
        logger.error("Error fetching region from IP:", { ip, error });
        return "US or Europe (EU)"; // fallback on any error
      }
    };
    const finalGeographicalContext = geographical_context
      ? await getRegionFromIP(geographical_context)
      : "US or Europe (EU)";
    json.polis_moderation_rubric.children[11].task.children[1].input = {
      comment_text: txt,
      conversation_topic: convo_topic,
      geographical_context: finalGeographicalContext,
    };

    const prompt_xml = js2xmlparser.parse("polis_moderation_rubric", json);

    const genAI = new GoogleGenAI({ apiKey: config.geminiApiKey });
    const respGem = await genAI.models.generateContent({
      model: "gemini-2.5-pro",
      config: {
        responseMimeType: "application/json",
        maxOutputTokens: 50000,
      },
      contents: [
        {
          parts: [
            {
              text: `
                  ${internal_config.system_lore}
  
                  ${prompt_xml}
  
                  You MUST respond with score object ONLY. Nothing else is permitted. The response structure should be as follows:
                  {
                    "output": {
                      "base_score": "NUMBER",
                      "substance_level": "STRING",
                      "multiplier": "N/A | NUMBER",
                      "final_score": "NUMBER",
                      "decision": "STRING"
                    }
                  }
                  KEEP THE EXACT STRUCTURE.
                `,
            },
          ],
          role: "user",
        },
      ],
    });

    const result = respGem.text;
    logger.debug(`${txt} moderation result: ${result}`);
    return JSON.parse(result).output?.final_score;
  } catch (error) {
    return;
  }
}

export default analyzeComment;
