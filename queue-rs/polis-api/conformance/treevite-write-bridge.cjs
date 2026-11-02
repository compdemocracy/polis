"use strict";
// Optional VM-host adapter: byte streams only, with two fixed destinations.
// The recorder and product server retain their sealed-network memberships.
const net = require("node:net");
function forward(port, host, destination) {
  net.createServer(client => {
    const upstream = net.connect(destination, host);
    client.on("error", () => upstream.destroy());
    upstream.on("error", () => client.destroy());
    client.on("close", () => upstream.destroy());
    upstream.on("close", () => client.destroy());
    client.pipe(upstream).pipe(client);
  }).listen(port, "0.0.0.0");
}
forward(5432, "postgres", 5432);
const port = Number(process.env.P027_TREEVITE_RUST_PORT);
if (!Number.isInteger(port) || port < 1024 || port > 65535) throw Error("unique Rust port required");
forward(port, "host.lima.internal", port);
