define(["collection", "models/vote"], function (Collection, Vote) {
  return Collection.extend({
    name: "votes",
    url: "votes",
    model: Vote
  });
});
