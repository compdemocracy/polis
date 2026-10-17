'use strict';
// Test-only generated identity entropy. Never loaded by a product entry point.
// Equal write inputs must yield equal IDs, not comparator masks. Signing keys
// remain fresh RSA keys; this does not replace authentication or any handler.
if (process.env.CLI_DIFFERENTIAL_FIXTURE !== '1' || process.env.P027_NETWORK_INTERNAL !== '1')
  throw Error('isolated differential fixture required');
const state = require('/app/characterization/observe.cjs');
const crypto = require('node:crypto');
const entropy = require('/app/characterization/entropy.cjs').entropy();
const seed = state.setSeed;
state.setSeed = hex => { seed(hex); entropy.seed(hex); };
function bytes(size, callback) {
  const out = Buffer.from(Array.from({length:size}, () => Math.floor(entropy.next()*256)));
  if (callback) { process.nextTick(callback, null, out); return; }
  return out;
}
crypto.randomBytes = crypto.pseudoRandomBytes = bytes;
crypto.randomInt = (min, max, callback) => {
  if (max === undefined) { max = min; min = 0; }
  const value = min + Math.floor(entropy.next()*(max-min));
  if (callback) { process.nextTick(callback, null, value); return; }
  return value;
};
crypto.randomUUID = () => {
  const b = bytes(16); b[6] = (b[6]&15)|64; b[8] = (b[8]&63)|128;
  const h = b.toString('hex'); return `${h.slice(0,8)}-${h.slice(8,12)}-${h.slice(12,16)}-${h.slice(16,20)}-${h.slice(20)}`;
};
require('/app/characterization/entry.cjs');
