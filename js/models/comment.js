var Model = require("../model");

module.exports = Model.extend({
  name: "comment",
  urlRoot: "comments",
  idAttribute: "tid",
  defaults: {
    //tid: undefined, // comment id
    //pid: undefined, // participant id
    //txt: "This is default comment text defined in the model.",
    //created: 0
  }
});