import { GoogleGenerativeAI } from "@google/generative-ai";
import logger from "../../../utils/logger";

const genAI = new GoogleGenerativeAI("my_api_key");

async function main() {
  const model = genAI.getGenerativeModel({ model: "gemini-pro" });

  const msg = await model.generateContent({
    contents: [
      {
        role: "user",
        parts: [{ text: "TASK SPECIFIC PROMPT..." }],
      },
    ],
    generationConfig: {
      maxOutputTokens: 1000,
      temperature: 0,
    },
  });

  logger.debug(msg.response.text());
}

main().catch(logger.error);
