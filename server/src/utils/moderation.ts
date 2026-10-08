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

export const moderationReady = loadFiles();

// The location context is always this neutral default. Until 2026-10 the
// commenter's IP address was sent to a third-party geolocation service to
// fill it in; that lookup was stopped by ruling (2026-10-05) "until better
// option or we do our own internal service".
const GEOGRAPHICAL_CONTEXT = "US or Europe (EU)";

async function analyzeComment(txt: string, convo_topic: string) {
  try {
    const json = await convertXML(internal_config.fileContents);
    json.polis_moderation_rubric.children[11].task.children[1].input = {
      comment_text: txt,
      conversation_topic: convo_topic,
      geographical_context: GEOGRAPHICAL_CONTEXT,
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
