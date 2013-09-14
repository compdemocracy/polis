define(['handlebars'], function (Handlebars) {
  function ifEmbedded(arg0) {
    return window.top !== window ? arg0.fn(this) : "";
  }
  Handlebars.registerHelper('if-embedded', ifEmbedded);
  return ifEmbedded;
});