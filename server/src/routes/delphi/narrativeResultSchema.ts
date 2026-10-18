export default {
  type: "object",
  additionalProperties: false,
  required: [
    "schema_version",
    "conversation_id",
    "report_id",
    "export_id",
    "input_digest",
    "section",
    "model",
    "results",
  ],
  properties: {
    schema_version: {
      type: "integer",
      enum: [1],
    },
    conversation_id: {
      type: "string",
      minLength: 1,
      maxLength: 100,
      pattern: "^[A-Za-z0-9]+$",
    },
    report_id: {
      type: "string",
      minLength: 1,
      maxLength: 100,
      pattern: "^[A-Za-z0-9]+$",
    },
    export_id: {
      type: "string",
      minLength: 1,
      maxLength: 45,
      pattern:
        "^external_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$",
    },
    input_digest: {
      type: "string",
      minLength: 1,
      maxLength: 64,
      pattern: "^[0-9a-f]{64}$",
    },
    section: {
      type: ["string", "null"],
      maxLength: 300,
      pattern: "^[A-Za-z0-9_-]+$",
    },
    model: {
      type: "string",
      minLength: 1,
      maxLength: 100,
      pattern: "^[A-Za-z0-9][A-Za-z0-9._:/ -]*$",
    },
    results: {
      type: "array",
      minItems: 1,
      maxItems: 99,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["section", "report_data"],
        properties: {
          section: {
            type: "string",
            minLength: 1,
            maxLength: 300,
            pattern: "^[A-Za-z0-9_-]+$",
          },
          report_data: {
            type: "object",
            additionalProperties: false,
            required: ["id", "title", "paragraphs"],
            properties: {
              id: {
                type: "string",
                minLength: 1,
                maxLength: 100,
              },
              title: {
                type: "string",
                minLength: 1,
                maxLength: 500,
              },
              paragraphs: {
                type: "array",
                minItems: 1,
                maxItems: 20,
                items: {
                  type: "object",
                  additionalProperties: false,
                  required: ["id", "title", "sentences"],
                  properties: {
                    id: {
                      type: "string",
                      minLength: 1,
                      maxLength: 100,
                    },
                    title: {
                      type: "string",
                      minLength: 1,
                      maxLength: 500,
                    },
                    sentences: {
                      type: "array",
                      minItems: 1,
                      maxItems: 30,
                      items: {
                        type: "object",
                        additionalProperties: false,
                        required: ["clauses"],
                        properties: {
                          clauses: {
                            type: "array",
                            minItems: 1,
                            maxItems: 30,
                            items: {
                              type: "object",
                              additionalProperties: false,
                              required: ["text", "citations"],
                              properties: {
                                text: {
                                  type: "string",
                                  minLength: 1,
                                  maxLength: 4000,
                                },
                                citations: {
                                  type: "array",
                                  minItems: 0,
                                  maxItems: 100,
                                  items: {
                                    type: "integer",
                                    minimum: 0,
                                    maximum: 2147483647,
                                  },
                                },
                              },
                            },
                          },
                        },
                      },
                    },
                  },
                },
              },
            },
          },
        },
      },
    },
  },
  $schema: "http://json-schema.org/draft-07/schema#",
  title: "External agent narrative import v1",
};
