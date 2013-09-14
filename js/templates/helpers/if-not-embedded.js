define(['handlebars'], function (Handlebars) {
  function ifNotEmbedded(arg0) {
    return window.top === window ? arg0.fn(this) : "";
  }
  Handlebars.registerHelper('if-not-embedded', ifNotEmbedded);
  return ifNotEmbedded;
});