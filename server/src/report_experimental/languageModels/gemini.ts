import { GoogleGenerativeAI } from "@google/generative-ai";

const genAI = new GoogleGenerativeAI("my_api_key");

async function main() {
  // const model = genAI.getGenerativeModel({ model: "gemini-pro" });
  // const model = genAI.getGenerativeModel({ model: "gemini-1.5-pro-002" });
  const model = genAI.getGenerativeModel({ model: "gemini-exp-1206" });

  const msg = await model.generateContent({
    contents: [
      {
        role: "user",
        parts: [{ text: "TASK SPECIFIC PROMPT..." }],
      },
    ],
    generationConfig: {
      maxOutputTokens: 3000,
      temperature: 0,
    },
  });

  console.log(msg.response.text());
}

main().catch(console.error);
