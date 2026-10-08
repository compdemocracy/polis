const getNarrativeJSON = (narrative) => {
  const responseText = narrative?.modelResponse;
  try {
    return JSON.parse(responseText || `{}`);
  } catch (error) {
    console.error("Failed to parse narrative modelResponse. Raw text:", responseText);
    // It's often helpful to re-throw the error or return a default/error object
    // depending on how the calling code should handle this.
    // For now, let's re-throw to keep existing behavior for other errors,
    // but we've logged the problematic text.
    // Alternatively, return a structured error object or a default valid JSON.
    // e.g., return { error: "Failed to parse", rawText: responseText, paragraphs: [] };
    throw error;
  }
};

export default getNarrativeJSON;
