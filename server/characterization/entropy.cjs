'use strict';
// Portable xorshift32, producing exact multiples of 2^-32. Crypto is not affected.
function entropy() {
  let state=0x270027;
  return {
    seed(hex) { state=(parseInt(hex.slice(0,8),16)>>>0)||0x270027; },
    next() { state^=state<<13;state^=state>>>17;state^=state<<5;return (state>>>0)/4294967296; }
  };
}
module.exports={entropy};
