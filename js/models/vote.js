var Model = require("../model");

module.exports = Model.extend({
    name: "vote",
    idAttribute: "tid", // assumes it is used in a context where sid=current conversation and pid=self
    defaults: {
      commentText: "",
      tid: undefined, // commenTTTT id... must be provided by the view, because multiple are sent over at a time...
      pid: undefined, // PPPParticipant id -- this is a unique id every participant has in every convo that starts at 0
      sid: undefined, // converSation id
      votes: undefined, // agree = -1, pass = 0, disagree = 1
      participantStarred: false
    }
  });