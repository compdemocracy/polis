"use strict";
const { AsyncLocalStorage, createHook } = require("node:async_hooks");
// Request ownership propagates through promises even though promises themselves are
// not pending I/O. Track timers, filesystem work and explicit DB/provider operations.
function createBarrier(unownedActive = () => false) {
  const context = new AsyncLocalStorage(),
    pending = new Map(),
    closed = new Set(),
    late = [];
  let sequence = 0;
  function start(kind, resource) {
    const owner = context.getStore();
    if (!owner) {
      if (
        unownedActive() &&
        ["postgres", "provider", "FSREQCALLBACK", "FSREQPROMISE"].includes(kind)
      )
        late.push({ owner: "unclassified", kind, stack: new Error().stack });
      return () => {};
    }
    // Node's TLS close callback releases SSL state after socket teardown; it cannot run application I/O.
    // Do not attribute this documented runtime disposal Immediate to a later API case.
    if (
      kind === "Immediate" &&
      /at TLSSocket.onSocketCloseDestroySSL \(node:internal\/tls\/wrap:/.test(
        new Error().stack
      )
    )
      return () => {};
    if (
      kind === "Timeout" &&
      /remove idle client/.test(String(resource?._onTimeout)) &&
      /pg-pool\/index\.js/.test(new Error().stack)
    )
      return () => {};
    // Default Node HTTP keep-alive expiry disposes an already-completed socket.
    if (
      kind === "Timeout" &&
      /at resOnFinish \(node:_http_server:/.test(new Error().stack)
    )
      return () => {};
    if (closed.has(owner))
      late.push({ owner, kind, origin: new Error().stack });
    const id = ++sequence;
    pending.set(id, {
      owner,
      kind,
      resource,
      origin: new Error().stack,
      callback: String(resource?._onTimeout).slice(0, 180),
    });
    return () => pending.delete(id);
  }
  const asynchronous = new Map();
  const hook = createHook({
    init(id, type, trigger, resource) {
      if (
        ["Timeout", "Immediate", "FSREQCALLBACK", "FSREQPROMISE"].includes(type)
      )
        asynchronous.set(id, start(type, resource));
    },
    destroy(id) {
      asynchronous.get(id)?.();
      asynchronous.delete(id);
    },
  }).enable();
  function state(owner) {
    return {
      pending: [...pending.values()]
        .filter((x) => x.owner === owner)
        .map(({ owner, kind, origin, callback }) => ({
          owner,
          kind,
          origin,
          callback,
        })),
      late: [...late],
    };
  }
  return {
    run: (owner, fn) => context.run(owner, fn),
    start,
    state,
    finish(owner) {
      const s = state(owner);
      if (s.pending.length || s.late.length)
        throw Error("INCONCLUSIVE: request-owned work not drained");
      closed.add(owner);
      return "request-effects-drained";
    },
    close: () => hook.disable(),
  };
}
module.exports = { createBarrier };
