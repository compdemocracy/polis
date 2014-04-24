var Model = require("../model");

module.exports = Model.extend({
  name: "faq",
  defaults: {
    title: "no title in this faq",
    content: "no content in this faq"
	}
});