var Collection = require("./collection");
var Vote = require("./models/vote");

module.exports = Collection.extend({
    name: "votes",
    url: "votes",
    model: Vote
  });