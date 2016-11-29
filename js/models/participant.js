// Copyright (C) 2012-present, Polis Technology Inc. This program is free software: you can redistribute it and/or  modify it under the terms of the GNU Affero General Public License, version 3, as published by the Free Software Foundation. This program is distributed in the hope that it will be useful, but WITHOUT ANY WARRANTY; without even the implied warranty of MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the GNU Affero General Public License for more details. You should have received a copy of the GNU Affero General Public License along with this program.  If not, see <http://www.gnu.org/licenses/>.

var Model = require("../model");

module.exports = Model.extend({
    name: "participant",
    url: "participants",
    defaults: {
      pid: undefined, // participant id -- each person gets a unique participant id
      uid: undefined, // user id -- each user can only be in the conversation once
      conversation_id: undefined  // converSation id
		}
  });
