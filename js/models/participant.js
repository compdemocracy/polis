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