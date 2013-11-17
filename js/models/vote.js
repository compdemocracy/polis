define(["model"], function (Model) {
  return Model.extend({
    name: "vote",
    defaults: {
      commentText: "",
      tid: undefined, // commenTTTT id... must be provided by the view, because multiple are sent over at a time...
      pid: undefined, // PPPParticipant id -- this is a unique id every participant has in every convo that starts at 0
      zid: undefined, // converZZZZationZZZZ id
      votes: undefined, // agree = -1, pass = 0, disagree = 1
      participantStarred: false
    }
  });
});
