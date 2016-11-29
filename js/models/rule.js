// Copyright (C) 2012-present, Polis Technology Inc. This program is free software: you can redistribute it and/or  modify it under the terms of the GNU Affero General Public License, version 3, as published by the Free Software Foundation. This program is distributed in the hope that it will be useful, but WITHOUT ANY WARRANTY; without even the implied warranty of MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the GNU Affero General Public License for more details. You should have received a copy of the GNU Affero General Public License along with this program.  If not, see <http://www.gnu.org/licenses/>.

var Model = require("../model");

module.exports = Model.extend({
  name: "rule",
  urlRoot: "rules",
  idAttribute: "rid",
  defaults: {
    // rid: 0
    // data: null // A reference to the model which the rule refers to
    // setting: null // The setting of the rule:
                     //  for example [-1,0] would be AGREE OR PASS
                     //  for example [234, 235] would mean CHOICES WITH PMAID 234 OR 235
                     //  for example [98101, 98102] would be a subset of zipcodes
    //created: 0
  }
});