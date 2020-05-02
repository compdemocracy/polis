// Copyright (C) 2012-present, The Authors. This program is free software: you can redistribute it and/or  modify it under the terms of the GNU Affero General Public License, version 3, as published by the Free Software Foundation. This program is distributed in the hope that it will be useful, but WITHOUT ANY WARRANTY; without even the implied warranty of MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the GNU Affero General Public License for more details. You should have received a copy of the GNU Affero General Public License along with this program.  If not, see <http://www.gnu.org/licenses/>.

var Model = require("../model");

module.exports = Model.extend({
  name: "comment",
  url: "comments",
  urlRoot: "comments",
  idAttribute: "tid",
  defaults: {
    //tid: undefined, // comment id
    //pid: undefined, // participant id
    //txt: "This is default comment text defined in the model.",
    //created: 0
  }
});
