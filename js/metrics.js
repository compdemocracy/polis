var PolisStorage = require("./util/polisStorage");

function useIntercom() {
  return PolisStorage.hasEmail();
}

function boot() {
  if (window.Intercom && useIntercom()) {
    Intercom('boot', {
      app_id: 'nb5hla8s',
      created_at: Date.now(),
      user_id: PolisStorage.uid()
    });
  }
}

// Return the {x: {min: #, max: #}, y: {min: #, max: #}}
module.exports = {
  boot: boot
};