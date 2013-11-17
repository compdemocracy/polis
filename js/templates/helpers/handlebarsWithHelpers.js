define([
	"originalhandlebars"
], function(Handlebars) {

  function ifDefined(context, options) {
    return "undefined" !== typeof context ? options.fn(this) : "";
  }
  Handlebars.registerHelper("ifDefined", ifDefined);

  function ifEmbedded(arg0) {
    return window.top !== window ? arg0.fn(this) : "";
  }
  Handlebars.registerHelper("ifEmbedded", ifEmbedded);

  function ifNotEmbedded(arg0) {
    return window.top === window ? arg0.fn(this) : "";
  }
  Handlebars.registerHelper("ifNotEmbedded", ifNotEmbedded);

	return Handlebars;
});