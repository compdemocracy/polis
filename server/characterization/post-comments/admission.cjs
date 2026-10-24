"use strict";
const assert = require("node:assert/strict");
const { assertAttempts } = require("../admission.cjs");
function message(recipient, count, conversationId) {
  const text = `${count} ${count === 1 ? "Statement is" : "Statements are"} waiting for your review here: https://pol.is/m/${conversationId}\n\nThank you for using Polis.`;
  return {
    Destination: { ToAddresses: [recipient] },
    Content: { Simple: {
      Subject: { Charset: "UTF-8", Data: `Waiting for review (conversation ${conversationId})` },
      Body: {
        Html: { Charset: "UTF-8", Data: `${text} + <br><i>Polis is powered by donations from people like you. Donate at <a href="https://donorbox.org/geo-polis">https://donorbox.org/geo-polis</a>.</i><br>` },
        Text: { Charset: "UTF-8", Data: `${text} - Polis is powered by donations from people like you. Donate at https://donorbox.org/geo-polis.` },
      },
    } },
    FromEmailAddress: "sender@example.invalid",
  };
}
function assertCommentsAttempts(attempts, policy) {
  assert.ok(policy, "every case declares a notification policy");
  assert.equal(policy.template, "comment-moderation");
  assert.equal(policy.count, policy.recipients.length);
  for (const recipient of policy.recipients)
    assert.ok(["owner", "site-moderator"].includes(recipient.class));
  const sdk = attempts.filter(a => a.service === "SESv2");
  const local = attempts.filter(a => a.host === "comments-ses");
  assertAttempts(attempts.filter(a => a.service !== "SESv2" && a.host !== "comments-ses"));
  assert.equal(sdk.length, policy.count, "SES command count");
  const http = local.filter(a => a.protocol === "http");
  assert.equal(http.length, policy.count, "SES transport count");
  assert.ok(local.filter(a => a.protocol === "tcp").length <= policy.count, "no extra raw sockets");
  for (const a of local) {
    assert.equal(a.port, 8025); assert.equal(a.blocked, false);
    assert.ok(["http", "tcp"].includes(a.protocol));
    if (a.protocol === "http") {
      assert.equal(a.method, "POST"); assert.equal(a.path, "/v2/email/outbound-emails");
      assert.equal(a.termination, "end");
    }
  }
  const expected = policy.recipients.map(r => message(r.address, policy.pending, policy.conversationId));
  const key = x => JSON.stringify(x.Destination);
  const sort = xs => xs.sort((a,b) => key(a).localeCompare(key(b)));
  for (const a of sdk) { assert.equal(a.command, "SendEmailCommand"); assert.equal(a.termination, "end"); }
  assert.deepEqual(sort(sdk.map(a=>a.input)), sort([...expected]), "exact SES template and recipient");
  assert.deepEqual(sort(http.map(a=>a.body)), sort([...expected]), "exact captured HTTP payload");
}
module.exports = { assertCommentsAttempts, message };
