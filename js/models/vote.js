// Copyright (C) 2012-present, The Authors. This program is free software: you can redistribute it and/or  modify it under the terms of the GNU Affero General Public License, version 3, as published by the Free Software Foundation. This program is distributed in the hope that it will be useful, but WITHOUT ANY WARRANTY; without even the implied warranty of MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the GNU Affero General Public License for more details. You should have received a copy of the GNU Affero General Public License along with this program.  If not, see <http://www.gnu.org/licenses/>.

var Model = require("../model");

module.exports = Model.extend({
    name: "vote",
    idAttribute: "tid", // assumes it is used in a context where conversation_id=current conversation and pid=self
    defaults: {
      commentText: "",
      tid: undefined, // commenTTTT id... must be provided by the view, because multiple are sent over at a time...
      pid: undefined, // PPPParticipant id -- this is a unique id every participant has in every convo that starts at 0
      conversation_id: undefined, // converSation id
      votes: undefined, // agree = -1, pass = 0, disagree = 1
      participantStarred: false
    }
  });
