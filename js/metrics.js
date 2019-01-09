// Copyright (C) 2012-present, The Authors. This program is free software: you can redistribute it and/or  modify it under the terms of the GNU Affero General Public License, version 3, as published by the Free Software Foundation. This program is distributed in the hope that it will be useful, but WITHOUT ANY WARRANTY; without even the implied warranty of MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the GNU Affero General Public License for more details. You should have received a copy of the GNU Affero General Public License along with this program.  If not, see <http://www.gnu.org/licenses/>.

var PolisStorage = require("./util/polisStorage");

function useIntercom() {
  return PolisStorage.hasEmail();
}

function boot() {
  if (window.Intercom && useIntercom()) {

    /*eslint-disable */
    /* jshint ignore:start */
    Intercom('boot', {
      app_id: 'nb5hla8s',
      created_at: Date.now(),
      user_id: PolisStorage.uid()
    });
    /* jshint ignore:end */
    /*eslint-enable */
  }
}

// Return the {x: {min: #, max: #}, y: {min: #, max: #}}
module.exports = {
  boot: boot
};
