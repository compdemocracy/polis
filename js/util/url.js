// Copyright (C) 2012-present, The Authors. This program is free software: you can redistribute it and/or  modify it under the terms of the GNU Affero General Public License, version 3, as published by the Free Software Foundation. This program is distributed in the hope that it will be useful, but WITHOUT ANY WARRANTY; without even the implied warranty of MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the GNU Affero General Public License for more details. You should have received a copy of the GNU Affero General Public License along with this program.  If not, see <http://www.gnu.org/licenses/>.

// build may prepend 'devWithPreprod'

var urlPrefix = "_domainWhitelistError_";

var wl = window.domainWhitelist.map(function(x) {
  return new RegExp(x);
});

for (var i = 0; i < wl.length; i++) {
  if (document.domain.match(wl[i])) {
    urlPrefix = document.location.protocol + "//" + document.location.hostname + ":" + document.location.port + "/";
    break;
  }
}

module.exports = {
  urlPrefix: urlPrefix,
};
