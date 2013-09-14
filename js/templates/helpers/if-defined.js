define(['handlebars'], function (Handlebars) {
  function ifDefined(context, options) {
    return "undefined" !== typeof context ? options.fn(this) : "";
  }
  Handlebars.registerHelper('if-defined', ifDefined);
  return ifDefined;
});