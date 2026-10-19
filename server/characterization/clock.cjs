"use strict";
// Generated fixture clock only. Native timers/performance.now remain real so
// response and drain deadlines still measure elapsed wall time.
const instant = 1700000000000;
let current = instant;
// Missing clock preserves the historical frozen replay. Timers stay native.
function set(value) {
  if (value == null) {
    current = instant;
    return;
  }
  if (!/^[0-9]{1,16}$/.test(String(value)))
    throw Error("invalid fixture clock");
  const next = Number(value);
  if (!Number.isSafeInteger(next) || next > 8640000000000000)
    throw Error("invalid fixture clock");
  current = next;
}
function install() {
  const NativeDate = global.Date;
  class FixtureDate extends NativeDate {
    constructor(...args) {
      super(...(args.length ? args : [current]));
    }
    static now() {
      return current;
    }
  }
  global.Date = FixtureDate;
  return () => {
    global.Date = NativeDate;
  };
}
module.exports = { instant, install, set };
