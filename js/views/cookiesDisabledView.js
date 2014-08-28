var Handlebones = require("handlebones");
var template = require("../tmpl/cookiesDisabled");

module.exports = Handlebones.View.extend({
    name: "cookies-disabled-view",
    template: template
});