"use strict";
// Only idempotent Dynamo snapshot reads may be retried. Never a case or HTTP request.
async function retryRead(command, send, record, options = {}) {
  if (!options.enabled) return send(command);
  const operation = command.constructor.name;
  if (!["ListTablesCommand", "ScanCommand"].includes(operation))
    throw Error("SNAPSHOT_RETRY_OPERATION_REFUSED");
  const input = JSON.stringify(command.input);
  const pause =
    options.pause || ((ms) => new Promise((r) => setTimeout(r, ms)));
  for (let attempt = 1; attempt <= 3; attempt++) {
    if (JSON.stringify(command.input) !== input)
      throw Error("SNAPSHOT_READ_INPUT_CHANGED");
    let value;
    try {
      value = await send(command);
    } catch (error) {
      if (error.code !== "EAI_AGAIN" && error.cause?.code !== "EAI_AGAIN")
        throw error;
      record({
        operation,
        attempt,
        outcome: attempt === 3 ? "exhausted" : "EAI_AGAIN",
      });
      if (attempt === 3) throw Error("SNAPSHOT_DNS_RETRY_EXHAUSTED");
      await pause([100, 500][attempt - 1]);
      continue;
    }
    if (attempt > 1) record({ operation, attempt, outcome: "recovered" });
    return value;
  }
}
module.exports = { retryRead };
