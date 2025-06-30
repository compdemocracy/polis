import { jest } from "@jest/globals";

// --- Correctly Mocking fs/promises ---
// This mock now creates the deep object structure that your `analyzeComment` function expects.
jest.mock("fs/promises", () => ({
  readFile: jest.fn().mockImplementation((path) => {
    if ((path as string).endsWith("script.xml")) {
      return Promise.resolve(`
        <polis_moderation_rubric>
          <children></children> 
          <children></children>
          <children></children>
          <children></children>
          <children></children>
          <children></children>
          <children></children>
          <children></children>
          <children></children>
          <children></children>
          <children></children> 
          <children>
            <task>
              <children></children> 
              <children>
                 
              </children>
            </task>
          </children>
        </polis_moderation_rubric>
      `);
    }
    if ((path as string).endsWith("system.xml")) {
      return Promise.resolve("<system_lore>System lore content</system_lore>");
    }
    return Promise.reject(new Error(`File not found in mock: ${path}`));
  }),
}));

//@ts-expect-error mock
const mockGenerateContent = jest.fn().mockResolvedValue({
  text: JSON.stringify({
    output: {
      base_score: "0.9",
      substance_level: "High",
      multiplier: "1.2",
      final_score: "1.08",
      decision: "APPROVE",
    },
  }),
});

jest.mock("@google/genai", () => {
  return {
    GoogleGenAI: jest.fn().mockImplementation(() => {
      return {
        models: {
          generateContent: mockGenerateContent,
        },
      };
    }),
  };
});
