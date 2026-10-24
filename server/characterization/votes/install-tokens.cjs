"use strict";
// Pipe simulator test tokens directly to the owned observer; never persist them.
(async () => {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  const response = await fetch(process.env.P027_CONTROL_URL + "/votes-provider-tokens", {
    method: "POST", body: Buffer.concat(chunks),
  });
  if (!response.ok) throw Error("provider fixture installation failed");
  console.log("provider fixtures installed");
})().catch(error => { console.error(error); process.exitCode = 1; });
