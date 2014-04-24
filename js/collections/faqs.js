var Collection = require("../collection");
var faqModel = require("../models/faq");

module.exports = Collection.extend({
    name: "faqs",
    url: "faqs",
    initialize: function(models, options) {
    },
    model: faqModel
});