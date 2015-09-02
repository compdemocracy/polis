var Backbone = require("backbone");

var currentUserModel = new Backbone.Model();

currentUserModel.update = function() {
  var that = this;
  return $.get("/api/v3/users").then(function(user) {
    // set up global userObject
    window.userObject = $.extend(window.userObject, user);

    window.userObject.uid = void 0;

    // migrating to a singleton model instead.
    that.set(user);
    return user;
  });
};

module.exports = currentUserModel;