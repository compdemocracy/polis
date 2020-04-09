// Copyright (C) 2012-present, The Authors. This program is free software: you can redistribute it and/or  modify it under the terms of the GNU Affero General Public License, version 3, as published by the Free Software Foundation. This program is distributed in the hope that it will be useful, but WITHOUT ANY WARRANTY; without even the implied warranty of MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the GNU Affero General Public License for more details. You should have received a copy of the GNU Affero General Public License along with this program.  If not, see <http://www.gnu.org/licenses/>.

import en_us from "./en_us";
import pt_br from "./pt_br"; // Temporarily until language choosing code is ported

var s = {};

// TODO port language choosing code
s = en_us;


function f(key) {
  // strip whitespace from key
  key = key.replace(/\s+$/,"").replace(/^\s+/,"");
  if (typeof s[key] === "undefined") {
    return key;
  }
  return s[key];
}

export default f;
