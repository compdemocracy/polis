var Collection = require("./collection");
var Conversation = require("./models/conversation");
  
module.exports = Collection.extend({
    name: "conversations",
    url: "conversations",
    model: Conversation
  });