"use strict";
// Generated fixture clock only. Native timers/performance.now remain real so
// response and drain deadlines still measure elapsed wall time.
const instant = 1700000000000;
function install() {
  const NativeDate = global.Date;
  class FixtureDate extends NativeDate {
    constructor(...args) {
      super(...(args.length ? args : [instant]));
    }
    static now() {
      return instant;
    }
  }
  global.Date = FixtureDate;
  return () => {
    global.Date = NativeDate;
  };
}
module.exports = { instant, install };
