"use strict";
// Recording-profile accounting only. An Agent's idle TLS socket cannot mutate
// the request. Keep its timer tracked so reuse immediately makes it pending.
const https = require("node:https");
const { TLSSocket } = require("node:tls");
function install() {
  const timers = new WeakMap();
  const original = https.Agent.prototype.keepSocketAlive;
  https.Agent.prototype.keepSocketAlive = function (socket) {
    const kept = original.call(this, socket);
    if (kept && socket instanceof TLSSocket) {
      for (const symbol of Object.getOwnPropertySymbols(socket)) {
        const timer = socket[symbol];
        if (
          symbol.description === "timeout" &&
          timer && typeof timer._onTimeout === "function"
        ) timers.set(timer, { socket, agent: this });
      }
    }
    return kept;
  };
  const settled = (kind, resource) => {
    if (kind !== "Timeout" || !resource) return false;
    const found = timers.get(resource);
    if (!found) return false;
    const { socket, agent } = found;
    const free = Object.values(agent.freeSockets).some(xs => xs.includes(socket));
    const active = Object.values(agent.sockets).some(xs => xs.includes(socket));
    const request = socket._httpMessage;
    return free && !active && !socket.destroyed &&
      (!request || (request.finished && request.res?.complete === true));
  };
  settled.restore = () => { https.Agent.prototype.keepSocketAlive = original; };
  return settled;
}
module.exports = { install };
