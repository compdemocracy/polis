"use strict";
// DynamoDB table definitions for the generated-fixture stack: the bootstrap's
// eighteen (../dynamo-schema.json, copied from delphi/create_dynamodb_tables.py)
// plus the two it does not create there: Delphi_JobActiveGuard (same file,
// later block) and report_narrative_store (created out of band in production;
// key from P-076 T20). Billing mode is irrelevant to DynamoDB Local.
const base = require("../dynamo-schema.json").tables;

const extra = {
  Delphi_JobActiveGuard: {
    KeySchema: [{ AttributeName: "guard_key", KeyType: "HASH" }],
    AttributeDefinitions: [{ AttributeName: "guard_key", AttributeType: "S" }],
    BillingMode: "PAY_PER_REQUEST",
  },
  report_narrative_store: {
    KeySchema: [
      { AttributeName: "rid_section_model", KeyType: "HASH" },
      { AttributeName: "timestamp", KeyType: "RANGE" },
    ],
    AttributeDefinitions: [
      { AttributeName: "rid_section_model", AttributeType: "S" },
      { AttributeName: "timestamp", AttributeType: "S" },
    ],
    BillingMode: "PAY_PER_REQUEST",
  },
};

const TABLES = { ...base, ...extra };

function definition(name) {
  const t = TABLES[name];
  if (!t) throw new Error(`no table definition for ${name}`);
  // DynamoDB Local accepts either billing form; normalise to on-demand so GSIs
  // need no throughput blocks.
  const def = {
    TableName: name,
    KeySchema: t.KeySchema,
    AttributeDefinitions: t.AttributeDefinitions,
    BillingMode: "PAY_PER_REQUEST",
  };
  if (t.GlobalSecondaryIndexes)
    def.GlobalSecondaryIndexes = t.GlobalSecondaryIndexes.map((g) => ({
      IndexName: g.IndexName,
      KeySchema: g.KeySchema,
      Projection: g.Projection,
    }));
  return def;
}

module.exports = { TABLES, definition };
